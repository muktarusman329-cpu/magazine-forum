import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createPublicRateLimiter } from '../lib/public-rate-limit.js';

test('upload and submission limits are independent and return JSON errors', async (t) => {
  const app = express();
  app.post('/upload', createPublicRateLimiter(1, 'Upload limit reached.'), (_req, res) => res.sendStatus(201));
  app.post('/submit', createPublicRateLimiter(1, 'Submission limit reached.'), (_req, res) => res.sendStatus(201));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${origin}/upload`, { method: 'POST' })).status, 201);
  const blockedUpload = await fetch(`${origin}/upload`, { method: 'POST' });
  assert.equal(blockedUpload.status, 429);
  assert.deepEqual(await blockedUpload.json(), { error: 'Upload limit reached.' });
  assert.equal((await fetch(`${origin}/submit`, { method: 'POST' })).status, 201);
});
