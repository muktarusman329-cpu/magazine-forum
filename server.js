import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { rateLimit } from 'express-rate-limit';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { v2 as cloudinary } from 'cloudinary';
import { databaseSslOptions } from './lib/database-ssl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const publicDir = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const required = ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
if (isProduction && !process.env.APP_ORIGIN?.startsWith('https://')) throw new Error('Set APP_ORIGIN to the public HTTPS origin in production.');
const deletionRetentionDays = Number(process.env.DELETION_RETENTION_DAYS || 14);
if (!Number.isInteger(deletionRetentionDays) || deletionRetentionDays < 1 || deletionRetentionDays > 3650) {
  throw new Error('DELETION_RETENTION_DAYS must be an integer between 1 and 3650.');
}

function positiveIntegerSetting(name, defaultValue) {
  const value = Number(process.env[name] || defaultValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const poolMax = positiveIntegerSetting('PG_POOL_MAX', 10);
const poolConnectionTimeoutMs = positiveIntegerSetting('PG_CONNECTION_TIMEOUT_MS', 5000);
const poolIdleTimeoutMs = positiveIntegerSetting('PG_IDLE_TIMEOUT_MS', 10000);
const readinessTimeoutMs = positiveIntegerSetting('PG_READY_TIMEOUT_MS', 1500);
const shutdownGraceMs = positiveIntegerSetting('SHUTDOWN_GRACE_MS', 25000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSslOptions(isProduction),
  max: poolMax,
  connectionTimeoutMillis: poolConnectionTimeoutMs,
  idleTimeoutMillis: poolIdleTimeoutMs,
});
pool.on('error', (error) => console.error('Unexpected idle PostgreSQL client error:', error));
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });

app.disable('x-powered-by');
if (isProduction || process.env.RENDER === 'true') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com', 'https://api.cloudinary.com'], connectSrc: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '12kb' }));
const PgSession = connectPgSimple(session);
app.use(session({ name: 'klass26.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, store: new PgSession({ pool, createTableIfMissing: false, tableName: 'admin_sessions' }), cookie: { httpOnly: true, secure: isProduction, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 }, rolling: true }));
app.use(express.static(publicDir, { index: 'index.html', maxAge: isProduction ? '1h' : 0 }));
app.use('/api/admin', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const limits = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false });
const publicLimiter = limits(15 * 60 * 1000, 8);
const loginLimiter = limits(15 * 60 * 1000, 8);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)) });
const folder = process.env.CLOUDINARY_FOLDER || 'klass-2k26/submissions';
const tokenFor = (publicId, expires) => {
  const payload = `${publicId}.${expires}`;
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
  return `${expires}.${signature}`;
};
function validPhotoToken(publicId, token) {
  if (typeof publicId !== 'string' || typeof token !== 'string') return false;
  const [expText, signature] = token.split('.');
  const expires = Number(expText);
  if (!Number.isInteger(expires) || expires < Date.now() || expires > Date.now() + 2 * 60 * 60 * 1000 || !signature) return false;
  const expected = tokenFor(publicId, expires).split('.')[1];
  const left = Buffer.from(signature); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right) && publicId.startsWith(`${folder}/`);
}
function requireAdmin(req, res, next) { if (!req.session.admin) return res.status(401).json({ error: 'Sign in to continue.' }); next(); }
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== expected) return res.status(403).json({ error: 'Request origin could not be verified.' });
  next();
}
function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  if (!origin || origin !== expected) return res.status(403).json({ error: 'Request origin could not be verified.' });
  next();
}
function validSubmissionId(id) {
  if (!/^[1-9]\d*$/.test(id)) return false;
  try { return BigInt(id) <= 9223372036854775807n; } catch { return false; }
}

let isShuttingDown = false;
const liveHealthCheck = (_req, res) => res.json({ ok: true });
app.get('/api/health/live', liveHealthCheck);
app.get('/api/health', liveHealthCheck);
app.get('/api/health/ready', async (_req, res) => {
  if (isShuttingDown) return res.status(503).json({ ok: false });

  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('Database readiness check timed out.')), readinessTimeoutMs);
    timeoutHandle.unref();
  });

  try {
    await Promise.race([
      pool.query({ text: 'SELECT 1', query_timeout: readinessTimeoutMs }),
      timeout,
    ]);
    if (isShuttingDown) return res.status(503).json({ ok: false });
    return res.json({ ok: true });
  } catch (error) {
    console.warn('Database readiness check failed:', error.message);
    return res.status(503).json({ ok: false });
  } finally {
    clearTimeout(timeoutHandle);
  }
});
app.post('/api/upload', publicLimiter, sameOrigin, upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a JPG/JPEG or PNG photo under 5 MB.' });
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !['image/jpeg', 'image/png'].includes(detected.mime)) return res.status(400).json({ error: 'That file is not a valid JPG/JPEG or PNG image.' });
    let normalized;
    try {
      normalized = await sharp(req.file.buffer, { limitInputPixels: 25_000_000 })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86, mozjpeg: true })
        .toBuffer();
    } catch (error) {
      if (error instanceof Error && /^(?:Vips(?:Jpeg|Png):|Input image exceeds pixel limit|Input buffer (?:contains unsupported image format|has corrupt header))/.test(error.message)) {
        return res.status(400).json({ error: 'That photo is damaged or could not be decoded. Choose a different JPG/JPEG or PNG.' });
      }
      throw error;
    }
    const publicId = `${folder}/${crypto.randomUUID()}`;
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ public_id: publicId, resource_type: 'image', type: 'authenticated', format: 'jpg', overwrite: false, unique_filename: false, invalidate: true }, (error, value) => error ? reject(error) : resolve(value));
      stream.end(normalized);
    });
    const expires = Date.now() + 60 * 60 * 1000;
    res.status(201).json({ photoId: result.public_id, photoToken: tokenFor(result.public_id, expires) });
  } catch (error) { next(error); }
});

app.post('/api/submissions', publicLimiter, sameOrigin, async (req, res, next) => {
  try {
    const { fullName, phone, nickname, photoId, photoToken, consent, website } = req.body || {};
    if (website) return res.status(400).json({ error: 'Submission could not be accepted.' });
    if (consent !== true) return res.status(400).json({ error: 'Please agree to the magazine use of your photo and details.' });
    if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 100) return res.status(400).json({ error: 'Enter a full name (up to 100 characters).' });
    if (typeof nickname !== 'string' || nickname.trim().length < 1 || nickname.trim().length > 50) return res.status(400).json({ error: 'Enter a nickname (up to 50 characters).' });
    if (typeof phone !== 'string' || !/^\+?[0-9 ()-]{7,20}$/.test(phone.trim())) return res.status(400).json({ error: 'Enter a valid phone number.' });
    if (!validPhotoToken(photoId, photoToken)) return res.status(400).json({ error: 'Upload your photo again before submitting.' });
    const saved = await pool.query('INSERT INTO submissions (full_name, phone, nickname, photo_public_id, consent_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id', [fullName.trim(), phone.trim(), nickname.trim(), photoId]);
    res.status(201).json({ ok: true, reference: saved.rows[0].id });
  } catch (error) { next(error); }
});

app.post('/api/admin/login', loginLimiter, sameOrigin, async (req, res) => {
  const { username, password } = req.body || {};
  const equalSecret = (a, b) => { const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  if (!equalSecret(username, process.env.ADMIN_USERNAME) || !equalSecret(password, process.env.ADMIN_PASSWORD)) return res.status(401).json({ error: 'The username or password is incorrect.' });
  req.session.regenerate((error) => { if (error) return res.status(500).json({ error: 'Could not start a secure session.' }); req.session.admin = true; req.session.save((saveError) => saveError ? res.status(500).json({ error: 'Could not save the session.' }) : res.json({ ok: true })); });
});
app.get('/api/admin/session', (req, res) => res.json({ authenticated: Boolean(req.session.admin) }));
app.post('/api/admin/logout', sameOrigin, requireAdmin, (req, res) => req.session.destroy(() => { res.clearCookie('klass26.sid', { httpOnly: true, secure: isProduction, sameSite: 'strict' }); res.status(204).end(); }));
app.get('/api/admin/submissions', requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT id, full_name, phone, nickname, created_at, updated_at::text AS updated_at FROM submissions WHERE deleted_at IS NULL ORDER BY created_at DESC');
    const rows = result.rows.map((row) => ({ id: row.id, fullName: row.full_name, phone: row.phone, nickname: row.nickname, createdAt: row.created_at, updatedAt: row.updated_at, photoUrl: "/api/admin/submissions/" + row.id + "/photo" }));
    res.json({ rows });
  } catch (error) { next(error); }
});
app.get('/api/admin/deleted-submissions', requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, phone, nickname, deleted_at, purge_after FROM submissions WHERE deleted_at IS NOT NULL ORDER BY purge_after ASC',
    );
    res.json({
      rows: result.rows.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        phone: row.phone,
        nickname: row.nickname,
        deletedAt: row.deleted_at,
        purgeAfter: row.purge_after,
      })),
    });
  } catch (error) { next(error); }
});
app.patch('/api/admin/submissions/:id', requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    if (!validSubmissionId(req.params.id)) return res.status(404).json({ error: 'Registration not found.' });
    const { fullName, phone, nickname, updatedAt } = req.body || {};
    if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 100) return res.status(400).json({ error: 'Enter a full name (up to 100 characters).' });
    if (typeof nickname !== 'string' || nickname.trim().length < 1 || nickname.trim().length > 50) return res.status(400).json({ error: 'Enter a nickname (up to 50 characters).' });
    if (typeof phone !== 'string' || !/^\+?[0-9 ()-]{7,20}$/.test(phone.trim())) return res.status(400).json({ error: 'Enter a valid phone number.' });
    if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return res.status(400).json({ error: 'Reload this registration before saving changes.' });
    const updated = await pool.query(
      'UPDATE submissions SET full_name = $1, phone = $2, nickname = $3 WHERE id = $4 AND deleted_at IS NULL AND updated_at = $5::timestamptz RETURNING id, full_name, phone, nickname, created_at, updated_at::text AS updated_at',
      [fullName.trim(), phone.trim(), nickname.trim(), req.params.id, updatedAt],
    );
    if (!updated.rowCount) {
      const current = await pool.query('SELECT 1 FROM submissions WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
      if (!current.rowCount) return res.status(404).json({ error: 'Active registration not found.' });
      return res.status(409).json({ error: 'This registration changed after you opened it. Reload it and try again.' });
    }
    const row = updated.rows[0];
    res.json({ row: { id: row.id, fullName: row.full_name, phone: row.phone, nickname: row.nickname, createdAt: row.created_at } });
  } catch (error) { next(error); }
});
app.delete('/api/admin/submissions/:id', requireAdmin, requireSameOrigin, async (req, res, next) => {
  if (!validSubmissionId(req.params.id)) return res.status(404).json({ error: 'Registration not found.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT deleted_at, purge_after FROM submissions WHERE id = $1 FOR UPDATE',
      [req.params.id],
    );
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Registration not found.' });
    }
    if (found.rows[0].deleted_at) {
      await client.query('COMMIT');
      return res.json({ ok: true, purgeAfter: found.rows[0].purge_after });
    }
    const deleted = await client.query(
      `UPDATE submissions
       SET deleted_at = NOW(), purge_after = NOW() + ($2 * INTERVAL '1 day')
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING purge_after`,
      [req.params.id, deletionRetentionDays],
    );
    await client.query('COMMIT');
    res.json({ ok: true, purgeAfter: deleted.rows[0].purge_after });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});
app.post('/api/admin/submissions/:id/restore', requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    if (!validSubmissionId(req.params.id)) return res.status(404).json({ error: 'Registration not found.' });
    const restored = await pool.query(
      `UPDATE submissions
       SET deleted_at = NULL, purge_after = NULL
       WHERE id = $1 AND deleted_at IS NOT NULL AND purge_after > NOW()
       RETURNING id`,
      [req.params.id],
    );
    if (!restored.rowCount) {
      const found = await pool.query('SELECT deleted_at, purge_after FROM submissions WHERE id = $1', [req.params.id]);
      if (!found.rowCount) return res.status(404).json({ error: 'Registration not found.' });
      if (!found.rows[0].deleted_at) return res.status(409).json({ error: 'Registration is not pending deletion.' });
      return res.status(410).json({ error: 'The retention period has expired; this registration can no longer be restored.' });
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/admin/submissions/:id/photo', requireAdmin, async (req, res, next) => {
  try {
    if (!validSubmissionId(req.params.id)) return res.status(404).end();
    const found = await pool.query('SELECT photo_public_id FROM submissions WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!found.rowCount) return res.status(404).end();
    const url = cloudinary.utils.private_download_url(found.rows[0].photo_public_id, 'jpg', { resource_type: 'image', type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + 600 });
    res.redirect(302, url);
  } catch (error) { next(error); }
});

app.get('/api/admin/export.xlsx', requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT id, full_name, phone, nickname, photo_public_id, created_at, consent_at FROM submissions WHERE deleted_at IS NULL ORDER BY created_at ASC');
    const workbook = new ExcelJS.Workbook(); workbook.creator = 'Klass of 2k26 Magazine Forum'; workbook.created = new Date();
    const sheet = workbook.addWorksheet('Magazine submissions', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [{ header: 'Reference', key: 'id', width: 13 }, { header: 'Full name', key: 'fullName', width: 30 }, { header: 'Phone number', key: 'phone', width: 22 }, { header: 'Nickname', key: 'nickname', width: 22 }, { header: 'Photo public ID', key: 'photo', width: 48 }, { header: 'Submitted at (UTC)', key: 'date', width: 24 }, { header: 'Consent recorded (UTC)', key: 'consent', width: 24 }];
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D91' } }; sheet.autoFilter = 'A1:G1';
    for (const row of result.rows) sheet.addRow({ id: row.id, fullName: row.full_name, phone: row.phone, nickname: row.nickname, photo: row.photo_public_id, date: new Date(row.created_at).toISOString(), consent: new Date(row.consent_at).toISOString() });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="klass-2k26-magazine-submissions-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await workbook.xlsx.write(res); res.end();
  } catch (error) { next(error); }
});

app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), (error) => { if (error) res.status(404).send('Page not found.'); }));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return _next(error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Photo must be 5 MB or smaller.' });
  if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Upload one JPG/JPEG or PNG photo.' });
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const server = app.listen(port, () => console.log(`Magazine Forum listening on port ${port}`));
let shutdownPromise;
function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;

  isShuttingDown = true;
  console.log(`Received ${signal}; stopping new requests and draining active requests.`);
  shutdownPromise = (async () => {
    let forced = false;
    let deadline;
    const serverClosed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    deadline = setTimeout(() => {
      forced = true;
      console.error('Graceful shutdown deadline reached; closing remaining HTTP connections.');
      server.closeAllConnections();
    }, shutdownGraceMs);

    try {
      await serverClosed;
      await pool.end();
      process.exitCode = forced ? 1 : 0;
    } catch (error) {
      console.error('Graceful shutdown failed:', error);
      server.closeAllConnections();
      process.exitCode = 1;
      await pool.end().catch((poolError) => console.error('Could not close the PostgreSQL pool:', poolError));
    } finally {
      clearTimeout(deadline);
    }
  })();
  return shutdownPromise;
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });




