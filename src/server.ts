import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeFilename } from './sanitize.js';

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT ?? 3000);
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? '';
const YTDLP = process.env.YTDLP_PATH ?? 'yt-dlp';
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 15 * 60 * 1000);
// Serialize conversions: the DS220+ has limited CPU, so concurrent ffmpeg runs
// crawl. One heavy job runs at a time; extra requests wait, up to MAX_QUEUE.
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 4);

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

app.post<{ Body: { url?: string } }>('/convert', async (req, reply) => {
  if (!AUTH_TOKEN || req.headers['x-auth-token'] !== AUTH_TOKEN) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const url = req.body?.url;
  if (!url || !/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(url)) {
    return reply.code(400).send({ error: 'invalid or missing YouTube url' });
  }

  // Reject rather than pile up unbounded when the box is already saturated.
  if (queueDepth >= MAX_QUEUE) {
    return reply.code(503).send({ error: 'server busy, try again shortly' });
  }
  queueDepth++;
  if (queueDepth > 1) req.log.info({ queueDepth }, 'conversion queued, waiting for slot');
  try {
    return await runExclusive(() => convert(req, reply, url));
  } finally {
    queueDepth--;
  }
});

async function convert(
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  url: string,
) {
  // 1. Fetch title (fast, no download)
  let title: string;
  try {
    const { stdout } = await execFileP(
      YTDLP,
      ['--no-playlist', '--print', 'title', '--skip-download', url],
      { timeout: 60_000 },
    );
    title = stdout.trim().split('\n')[0] ?? 'audio';
  } catch (err) {
    req.log.error(err, 'title fetch failed');
    return reply.code(502).send({ error: 'could not fetch video metadata' });
  }
  const safeName = sanitizeFilename(title);

  // 2. Download + extract mp3 into a temp dir
  const dir = await mkdtemp(join(tmpdir(), 'yt2mp3-'));
  try {
    await execFileP(
      YTDLP,
      [
        '--no-playlist',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', join(dir, 'audio.%(ext)s'),
        url,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS },
    );
    const files = await readdir(dir);
    const mp3 = files.find((f) => f.endsWith('.mp3'));
    if (!mp3) throw new Error('no mp3 produced');

    const path = join(dir, mp3);
    const size = statSync(path).size;

    reply
      .header('Content-Type', 'audio/mpeg')
      .header('Content-Length', size)
      .header(
        'Content-Disposition',
        `attachment; filename="${safeName}.mp3"; filename*=UTF-8''${encodeURIComponent(safeName)}.mp3`,
      );

    const stream = createReadStream(path);
    stream.on('close', () => void rm(dir, { recursive: true, force: true }));
    return reply.send(stream);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    req.log.error(err, 'conversion failed');
    return reply.code(502).send({ error: 'conversion failed' });
  }
}

app.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
