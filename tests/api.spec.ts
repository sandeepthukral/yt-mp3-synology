import { test, expect } from '@playwright/test';

// Run against a live instance:
//   BASE_URL=http://ds220:3000 AUTH_TOKEN=... npx playwright test
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? '';

test('health endpoint responds', async ({ request }) => {
  const res = await request.get(`${BASE_URL}/health`);
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ ok: true, queueDepth: expect.any(Number) });
});

test('convert rejects missing auth', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/convert`, {
    data: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  });
  expect(res.status()).toBe(401);
});

test('convert rejects non-YouTube urls', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/convert`, {
    headers: { 'x-auth-token': AUTH_TOKEN },
    data: { url: 'https://example.com/video' },
  });
  expect(res.status()).toBe(400);
});

test('convert returns an mp3 with sanitized filename', async ({ request }) => {
  test.skip(!AUTH_TOKEN, 'AUTH_TOKEN not set');
  test.setTimeout(5 * 60 * 1000);
  const res = await request.post(`${BASE_URL}/convert`, {
    headers: { 'x-auth-token': AUTH_TOKEN },
    // "Me at the zoo" — 19 seconds, fast to convert
    data: { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
    timeout: 5 * 60 * 1000, // request-level timeout; test.setTimeout alone is not enough
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('audio/mpeg');
  expect(res.headers()['content-disposition']).toContain('.mp3');
  const body = await res.body();
  expect(body.length).toBeGreaterThan(50_000);
});

test('job endpoints reject missing auth', async ({ request }) => {
  const post = await request.post(`${BASE_URL}/jobs`, {
    data: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  });
  expect(post.status()).toBe(401);
  const get = await request.get(`${BASE_URL}/jobs/whatever`);
  expect(get.status()).toBe(401);
});

test('unknown job id is a 404', async ({ request }) => {
  test.skip(!AUTH_TOKEN, 'AUTH_TOKEN not set');
  const res = await request.get(`${BASE_URL}/jobs/00000000-0000-0000-0000-000000000000`, {
    headers: { 'x-auth-token': AUTH_TOKEN },
  });
  expect(res.status()).toBe(404);
});

test('async job mode converts and serves an mp3', async ({ request }) => {
  test.skip(!AUTH_TOKEN, 'AUTH_TOKEN not set');
  test.setTimeout(5 * 60 * 1000);

  const submit = await request.post(`${BASE_URL}/jobs`, {
    headers: { 'x-auth-token': AUTH_TOKEN },
    // "Me at the zoo" - 19 seconds, fast to convert
    data: { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
  });
  expect(submit.status()).toBe(202);
  const { id, status, downloadKey } = await submit.json();
  expect(id).toBeTruthy();
  expect(downloadKey).toBeTruthy();
  expect(['queued', 'running']).toContain(status);

  // Downloading before the conversion finishes is a 409, not a partial file.
  const early = await request.get(`${BASE_URL}/jobs/${id}/download`, {
    headers: { 'x-auth-token': AUTH_TOKEN },
  });
  expect([409, 200]).toContain(early.status());

  let state = 'queued';
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    const poll = await request.get(`${BASE_URL}/jobs/${id}`, {
      headers: { 'x-auth-token': AUTH_TOKEN },
    });
    expect(poll.status()).toBe(200);
    ({ status: state } = await poll.json());
    if (state === 'done' || state === 'error') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  expect(state).toBe('done');

  const dl = await request.get(`${BASE_URL}/jobs/${id}/download`, {
    headers: { 'x-auth-token': AUTH_TOKEN },
  });
  expect(dl.status()).toBe(200);
  expect(dl.headers()['content-type']).toBe('audio/mpeg');
  expect(dl.headers()['content-disposition']).toContain('.mp3');
  expect((await dl.body()).length).toBeGreaterThan(50_000);

  // The file survives the first download, so a dropped transfer can be retried.
  const again = await request.get(`${BASE_URL}/jobs/${id}/download`, {
    headers: { 'x-auth-token': AUTH_TOKEN },
  });
  expect(again.status()).toBe(200);

  // No header at all, just the job's key — this is the URL the Chrome
  // extension hands to chrome.downloads, which cannot set headers.
  const keyed = await request.get(`${BASE_URL}/jobs/${id}/download?key=${downloadKey}`);
  expect(keyed.status()).toBe(200);
  expect(keyed.headers()['content-type']).toBe('audio/mpeg');
  expect((await keyed.body()).length).toBeGreaterThan(50_000);

  const wrongKey = await request.get(`${BASE_URL}/jobs/${id}/download?key=not-the-key`);
  expect(wrongKey.status()).toBe(401);

  const noKey = await request.get(`${BASE_URL}/jobs/${id}/download`);
  expect(noKey.status()).toBe(401);
});
