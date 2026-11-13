import 'dotenv/config';
import { Client } from 'pg';
import { v2 as cloudinary } from 'cloudinary';
import { databaseSslOptions } from '../lib/database-ssl.js';

if (process.env.ENABLE_PERMANENT_DELETION !== 'true') {
  throw new Error('Set ENABLE_PERMANENT_DELETION=true only in the scheduled cleanup environment.');
}

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const missingCloudinary = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
  .filter((name) => !process.env[name]);
if (missingCloudinary.length) throw new Error(`Missing required Cloudinary settings: ${missingCloudinary.join(', ')}`);

const isProduction = process.env.NODE_ENV === 'production';
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSslOptions(isProduction),
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

async function purgeExpiredSubmissions() {
  await client.query('BEGIN');
  try {
    const expired = await client.query(
      `SELECT id, photo_public_id
       FROM submissions
       WHERE deleted_at IS NOT NULL AND purge_after <= NOW()
       ORDER BY purge_after ASC
       LIMIT 100
       FOR UPDATE SKIP LOCKED`,
    );

    for (const row of expired.rows) {
      const retainedReference = await client.query(
        `SELECT EXISTS (
           SELECT 1
           FROM submissions
           WHERE photo_public_id = $1
             AND id <> $2
             AND (deleted_at IS NULL OR purge_after IS NULL OR purge_after > NOW())
         ) AS exists`,
        [row.photo_public_id, row.id],
      );

      if (!retainedReference.rows[0].exists) {
        await client.query(
          `INSERT INTO photo_cleanup_jobs (photo_public_id)
           VALUES ($1)
           ON CONFLICT (photo_public_id) DO NOTHING`,
          [row.photo_public_id],
        );
      }

      await client.query('DELETE FROM submissions WHERE id = $1', [row.id]);
    }

    await client.query('COMMIT');
    return expired.rowCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function claimCleanupJob() {
  await client.query('BEGIN');
  try {
    const result = await client.query(
      `SELECT photo_public_id
       FROM photo_cleanup_jobs
       WHERE next_attempt_at <= NOW()
         AND (locked_until IS NULL OR locked_until < NOW())
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    if (!result.rowCount) {
      await client.query('COMMIT');
      return null;
    }

    const photoPublicId = result.rows[0].photo_public_id;
    const claimed = await client.query(
      `UPDATE photo_cleanup_jobs
       SET locked_until = NOW() + INTERVAL '10 minutes',
           attempts = attempts + 1
       WHERE photo_public_id = $1
       RETURNING attempts`,
      [photoPublicId],
    );
    await client.query('COMMIT');
    return { photoPublicId, attempts: claimed.rows[0].attempts };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function cleanupPhotos() {
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < 100; index += 1) {
    const job = await claimCleanupJob();
    if (!job) break;

    const retainedReference = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM submissions
         WHERE photo_public_id = $1
           AND (deleted_at IS NULL OR purge_after IS NULL OR purge_after > NOW())
       ) AS exists`,
      [job.photoPublicId],
    );
    if (retainedReference.rows[0].exists) {
      await client.query(
        `UPDATE photo_cleanup_jobs
         SET locked_until = NULL, next_attempt_at = NOW() + INTERVAL '1 hour'
         WHERE photo_public_id = $1`,
        [job.photoPublicId],
      );
      continue;
    }

    try {
      const result = await cloudinary.uploader.destroy(job.photoPublicId, {
        resource_type: 'image',
        type: 'authenticated',
        invalidate: true,
      });
      if (result.result !== 'ok' && result.result !== 'not found') {
        throw new Error(`Unexpected Cloudinary result: ${result.result}`);
      }
      await client.query('DELETE FROM photo_cleanup_jobs WHERE photo_public_id = $1', [job.photoPublicId]);
      processed += 1;
    } catch (error) {
      const retryMinutes = Math.min(24 * 60, 2 ** Math.min(job.attempts, 10));
      await client.query(
        `UPDATE photo_cleanup_jobs
         SET locked_until = NULL,
             next_attempt_at = NOW() + ($2 * INTERVAL '1 minute'),
             last_error = $3
         WHERE photo_public_id = $1`,
        [job.photoPublicId, retryMinutes, String(error.message || 'Cloudinary cleanup failed').slice(0, 500)],
      );
      failed += 1;
    }
  }

  return { processed, failed };
}

try {
  await client.connect();
  const permanentlyDeleted = await purgeExpiredSubmissions();
  const photos = await cleanupPhotos();
  console.log(`Permanent deletions: ${permanentlyDeleted}; photos removed: ${photos.processed}; photo cleanup failures: ${photos.failed}.`);
} finally {
  await client.end();
}
