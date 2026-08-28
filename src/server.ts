import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { rm } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { PORT, AUTH_TOKEN, MAX_QUEUE } from './config.js';
import {
  fetchTitle,
  convertToMp3,
  maybeSaveCopy,
  describeFailure,
  MetadataError,
} from './convert.js';
import {
  createJob,
  getJob,
  markRunning,
  markDone,
  markError,
  publicView,
  startSweeper,
} from './jobs.js';

// Single-slot mutex: each job runs after the previous one settles.
let queueDepth = 0;
let tail: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn, fn);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true, queueDepth }));

/** Shared gate for both conversion routes: auth, url shape, then queue capacity. */
function admit(req: FastifyRequest, reply: FastifyReply, url: string | undefined): url is string {
  if (!AUTH_TOKEN || req.headers['x-auth-token'] !== AUTH_TOKEN) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  if (!url || !/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(url)) {
    reply.code(400).send({ error: 'invalid or missing YouTube url' });
    return false;
  }
  // Reject rather than pile up unbounded when the box is already saturated.
  if (queueDepth >= MAX_QUEUE) {
    reply.code(503).send({ error: 'server busy, try again shortly' });
    return false;
  }
  return true;
}

// --- Synchronous conversion: one request, mp3 in the response -------------

app.post<{ Body: { url?: string } }>('/convert', async (req, reply) => {
  const url = req.body?.url;
  if (!admit(req, reply, url)) return reply;

  queueDepth++;
  if (queueDepth > 1) req.log.info({ queueDepth }, 'conversion queued, waiting for slot');
  try {
    return await runExclusive(() => convert(req, reply, url));
  } finally {
    queueDepth--;
  }
});

async function convert(req: FastifyRequest, reply: FastifyReply, url: string) {
  let title: string;
  try {
    title = await fetchTitle(url);
  } catch (err) {
    req.log.error(err, 'title fetch failed');
    return reply.code(502).send({ error: 'could not fetch video metadata' });
  }

  let result;
  try {
    result = await convertToMp3(url, title);
  } catch (err) {
    req.log.error(err, 'conversion failed');
    return reply.code(502).send({ error: describeFailure(err) });
  }

  await maybeSaveCopy(result.path, result.filename, req.log);

  reply
    .header('Content-Type', 'audio/mpeg')
    .header('Content-Length', statSync(result.path).size)
    .header('Content-Disposition', contentDisposition(result.filename));

  const stream = createReadStream(result.path);
  stream.on('close', () => void rm(result.dir, { recursive: true, force: true }));
  return reply.send(stream);
}

// --- Async job mode: submit, poll, download -------------------------------
// Long videos outlive an iOS Shortcut's patience for a single HTTP request, so
// the Shortcut can instead submit a job, poll until it's done, then download.

app.post<{ Body: { url?: string } }>('/jobs', async (req, reply) => {
  const url = req.body?.url;
  if (!admit(req, reply, url)) return reply;

  const job = createJob(url);
  queueDepth++;

  // Deliberately not awaited: the response goes back immediately and the
  // conversion continues in the background, behind the same one-at-a-time gate.
  void runExclusive(async () => {
    markRunning(job.id);
    try {
      const title = await fetchTitle(job.url);
      const result = await convertToMp3(job.url, title);
      await maybeSaveCopy(result.path, result.filename, req.log);
      markDone(job.id, result.dir, result.path, result.filename);
    } catch (err) {
      req.log.error(err, 'job conversion failed');
      markError(job.id, err instanceof MetadataError
        ? 'could not fetch video metadata'
        : describeFailure(err));
    } finally {
      queueDepth--;
    }
  });

  return reply.code(202).send(publicView(job));
});

app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
  if (!AUTH_TOKEN || req.headers['x-auth-token'] !== AUTH_TOKEN) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const job = getJob(req.params.id);
  // Expired jobs are indistinguishable from ids that never existed, by design.
  if (!job) return reply.code(404).send({ error: 'no such job (or it expired)' });
  return reply.send(publicView(job));
});

app.get<{ Params: { id: string } }>('/jobs/:id/download', async (req, reply) => {
  if (!AUTH_TOKEN || req.headers['x-auth-token'] !== AUTH_TOKEN) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const job = getJob(req.params.id);
  if (!job) return reply.code(404).send({ error: 'no such job (or it expired)' });
  if (job.status === 'error') return reply.code(502).send({ error: job.error });
  if (job.status !== 'done' || !job.path || !job.filename) {
    return reply.code(409).send({ error: `job is ${job.status}`, status: job.status });
  }

  reply
    .header('Content-Type', 'audio/mpeg')
    .header('Content-Length', statSync(job.path).size)
    .header('Content-Disposition', contentDisposition(job.filename));
  // The file stays until the job expires, so a dropped download can be retried.
  return reply.send(createReadStream(job.path));
});

function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

startSweeper();

app.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
