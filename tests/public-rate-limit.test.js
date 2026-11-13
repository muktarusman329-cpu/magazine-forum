import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createJsonRateLimiter } from '../lib/public-rate-limit.js';

test('independent API limits return JSON errors', async (t) => {
  const app = express();
  app.post('/upload', createJsonRateLimiter({ limit: 1, message: 'Upload limit reached.' }), (_req, res) => res.sendStatus(201));
  app.post('/submit', createJsonRateLimiter({ limit: 1, message: 'Submission limit reached.' }), (_req, res) => res.sendStatus(201));
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
