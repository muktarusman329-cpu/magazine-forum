import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseSslOptions } from '../lib/database-ssl.js';

test('production verifies database certificates by default', () => {
  assert.deepEqual(databaseSslOptions(true, ''), { rejectUnauthorized: true });
});

test('require encrypts connections while accepting a self-signed certificate', () => {
  assert.deepEqual(databaseSslOptions(true, 'require'), { rejectUnauthorized: false });
});

test('verify-full verifies certificates outside production too', () => {
  assert.deepEqual(databaseSslOptions(false, 'verify-full'), { rejectUnauthorized: true });
});

test('development remains unencrypted unless SSL is configured', () => {
  assert.equal(databaseSslOptions(false, ''), undefined);
});

test('unknown SSL modes fail clearly', () => {
  assert.throws(() => databaseSslOptions(true, 'prefer'), /DATABASE_SSL_MODE/);
});
