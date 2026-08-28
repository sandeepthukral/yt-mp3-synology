import { describe, it, expect, beforeEach } from 'vitest';
import {
  createJob,
  getJob,
  markRunning,
  markDone,
  markError,
  publicView,
  sweep,
  resetJobs,
} from '../src/jobs.js';

const TTL = 30 * 60 * 1000; // JOB_TTL_MS default
const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

beforeEach(() => resetJobs());

describe('job lifecycle', () => {
  it('starts queued and is retrievable by id', () => {
    const job = createJob(URL);
    expect(job.status).toBe('queued');
    expect(getJob(job.id)).toBe(job);
  });

  it('gives each job a distinct id', () => {
    expect(createJob(URL).id).not.toBe(createJob(URL).id);
  });

  it('moves through running to done', () => {
    const { id } = createJob(URL);
    markRunning(id);
    expect(getJob(id)?.status).toBe('running');
    markDone(id, '/tmp/x', '/tmp/x/a.mp3', 'Song.mp3');
    expect(getJob(id)).toMatchObject({ status: 'done', filename: 'Song.mp3' });
  });

  it('records a failure reason', () => {
    const { id } = createJob(URL);
    markError(id, 'conversion failed: boom');
    expect(getJob(id)).toMatchObject({ status: 'error', error: 'conversion failed: boom' });
  });

  it('ignores transitions on unknown ids rather than throwing', () => {
    expect(() => markRunning('nope')).not.toThrow();
    expect(() => markDone('nope', '/a', '/a/b.mp3', 'b.mp3')).not.toThrow();
    expect(() => markError('nope', 'x')).not.toThrow();
  });
});

describe('publicView', () => {
  it('hides on-disk paths from clients', () => {
    const { id } = createJob(URL);
    markDone(id, '/tmp/secret', '/tmp/secret/a.mp3', 'Song.mp3');
    const job = getJob(id)!;
    const view = publicView(job);
    expect(view).toEqual({
      id,
      status: 'done',
      filename: 'Song.mp3',
      downloadKey: job.downloadKey,
    });
    expect(JSON.stringify(view)).not.toContain('/tmp/secret');
  });

  it('omits filename and error while still queued', () => {
    const job = createJob(URL);
    expect(publicView(job)).toEqual({
      id: job.id,
      status: 'queued',
      downloadKey: job.downloadKey,
    });
  });
});

describe('downloadKey', () => {
  it('is distinct from the job id, so a leaked id is not a download grant', () => {
    const job = createJob(URL);
    expect(job.downloadKey).toBeTruthy();
    expect(job.downloadKey).not.toBe(job.id);
  });

  it('differs between jobs', () => {
    const keys = new Set([createJob(URL), createJob(URL), createJob(URL)].map((j) => j.downloadKey));
    expect(keys.size).toBe(3);
  });
});

describe('sweep', () => {
  it('keeps finished jobs until the TTL elapses', () => {
    const { id } = createJob(URL);
    markDone(id, '/tmp/x', '/tmp/x/a.mp3', 'a.mp3');
    expect(sweep(Date.now() + TTL - 1000)).toEqual([]);
    expect(getJob(id)).toBeDefined();
  });

  it('removes finished jobs past the TTL', () => {
    const { id } = createJob(URL);
    markDone(id, '/tmp/x', '/tmp/x/a.mp3', 'a.mp3');
    expect(sweep(Date.now() + TTL + 1000)).toEqual([id]);
    expect(getJob(id)).toBeUndefined();
  });

  it('expires failed jobs too', () => {
    const { id } = createJob(URL);
    markError(id, 'nope');
    expect(sweep(Date.now() + TTL + 1000)).toEqual([id]);
  });

  it('never expires a job that has not finished', () => {
    // A conversion queued behind a long one must not be swept out from under
    // the client, however long it waits.
    const { id } = createJob(URL);
    markRunning(id);
    expect(sweep(Date.now() + TTL * 100)).toEqual([]);
    expect(getJob(id)?.status).toBe('running');
  });
});
