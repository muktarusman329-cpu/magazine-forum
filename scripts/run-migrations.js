import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { databaseSslOptions } from '../lib/database-ssl.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(scriptDir, '..', 'migrations');
const isProduction = process.env.NODE_ENV === 'production';
const lockId = 2_026_112_026;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to inspect or apply database migrations.');
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSslOptions(isProduction),
});

function checksum(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function listMigrations() {
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(file)) {
      throw new Error(`Invalid migration filename: ${file}`);
    }
  }

  return Promise.all(files.map(async (filename) => {
    const contents = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    return { filename, contents, checksum: checksum(contents) };
  }));
}

async function readAppliedMigrations() {
  try {
    const result = await client.query(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
    );
    return new Map(result.rows.map((row) => [row.filename, row.checksum]));
  } catch (error) {
    if (error.code === '42P01') return new Map();
    throw error;
  }
}

function validateMigrationHistory(migrations, applied) {
  const known = new Set(migrations.map((migration) => migration.filename));

  for (const [filename, appliedChecksum] of applied) {
    if (!known.has(filename)) {
      throw new Error(`Applied migration is missing from disk: ${filename}`);
    }
    const current = migrations.find((migration) => migration.filename === filename);
    if (current.checksum !== appliedChecksum) {
      throw new Error(`Applied migration was changed: ${filename}`);
    }
  }
}

async function ensureMigrationLedger() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function applyMigration(migration) {
  await client.query('BEGIN');
  try {
    await client.query(migration.contents);
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
      [migration.filename, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const statusOnly = process.argv.includes('--status');
  const migrations = await listMigrations();

  await client.connect();
  if (!statusOnly) {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    await ensureMigrationLedger();
  }

  const applied = await readAppliedMigrations();
  validateMigrationHistory(migrations, applied);
  const pending = migrations.filter((migration) => !applied.has(migration.filename));

  if (statusOnly) {
    console.log(`Applied: ${applied.size}`);
    for (const migration of migrations) {
      console.log(`${applied.has(migration.filename) ? 'applied' : 'pending'}  ${migration.filename}`);
    }
    if (!migrations.length) console.log('No migration files found.');
    return;
  }

  for (const migration of pending) {
    console.log(`Applying ${migration.filename}`);
    await applyMigration(migration);
  }

  console.log(pending.length ? `Applied ${pending.length} migration(s).` : 'No pending migrations.');
}

try {
  await main();
} catch (error) {
  console.error('Migration command failed:', error);
  process.exitCode = 1;
} finally {
  if (client.connection) await client.end();
}
