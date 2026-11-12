ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;

UPDATE submissions
SET purge_after = deleted_at + INTERVAL '14 days'
WHERE deleted_at IS NOT NULL
  AND purge_after IS NULL;

CREATE INDEX IF NOT EXISTS submissions_pending_purge_idx
  ON submissions (purge_after)
  WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS photo_cleanup_jobs (
  photo_public_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS photo_cleanup_jobs_ready_idx
  ON photo_cleanup_jobs (next_attempt_at, created_at, locked_until);
