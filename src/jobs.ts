import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { JOB_TTL_MS } from './config.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface Job {
  id: string;
  url: string;
  /**
   * Per-job secret for `GET /jobs/:id/download?key=…`. Clients that hand the
   * download URL to something that can't set headers — chrome.downloads, a
   * plain <a href> — have no way to send X-Auth-Token. A per-job key keeps
   * AUTH_TOKEN itself out of download histories and access logs, and dies
   * with the job.
   */
  downloadKey: string;
  status: JobStatus;
  createdAt: number;
  /** Set once the job reaches a terminal state; drives TTL expiry. */
  finishedAt?: number;
  /** Download filename, present once status is 'done'. */
  filename?: string;
  /** Path to the mp3 on disk, present once status is 'done'. */
  path?: string;
  /** Temp dir to delete when the job expires. */
  dir?: string;
  /** Failure reason, present once status is 'error'. */
  error?: string;
}

const jobs = new Map<string, Job>();

export function createJob(url: string): Job {
  const job: Job = {
    id: randomUUID(),
    url,
    downloadKey: randomUUID(),
    status: 'queued',
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function markRunning(id: string): void {
  const job = jobs.get(id);
  if (job) job.status = 'running';
}

export function markDone(id: string, dir: string, path: string, filename: string): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'done', dir, path, filename, finishedAt: Date.now() });
}

export function markError(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'error', error, finishedAt: Date.now() });
}

/**
 * The public shape of a job: internal paths stay server-side. The download key
 * is included — every route that returns this already required AUTH_TOKEN.
 */
export function publicView(job: Job) {
  return {
    id: job.id,
    status: job.status,
    downloadKey: job.downloadKey,
    ...(job.filename ? { filename: job.filename } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/**
 * Drop jobs that finished more than JOB_TTL_MS ago and delete their temp dirs.
 * Only terminal jobs expire — a slow conversion still queued behind others must
 * not be swept out from under the client.
 * Returns the ids removed. Exported for tests; `now` is injectable.
 */
export function sweep(now = Date.now()): string[] {
  const removed: string[] = [];
  for (const [id, job] of jobs) {
    if (job.finishedAt === undefined) continue;
    if (now - job.finishedAt < JOB_TTL_MS) continue;
    jobs.delete(id);
    removed.push(id);
    if (job.dir) void rm(job.dir, { recursive: true, force: true });
  }
  return removed;
}

/** Test hook: forget every job without touching the filesystem. */
export function resetJobs(): void {
  jobs.clear();
}

/** Run sweep() periodically. unref'd so it never keeps the process alive. */
export function startSweeper(intervalMs = 60_000) {
  const timer = setInterval(() => sweep(), intervalMs);
  timer.unref();
  return timer;
}
