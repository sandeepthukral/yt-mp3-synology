import { test, expect } from '@playwright/test';

// Run against a live instance:
//   BASE_URL=http://ds220:3000 AUTH_TOKEN=... npx playwright test
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? '';

test('health endpoint responds', async ({ request }) => {
  const res = await request.get(`${BASE_URL}/health`);
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ ok: true });
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
