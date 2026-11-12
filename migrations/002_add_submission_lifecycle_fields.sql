ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS submissions_active_created_at_idx
  ON submissions (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION set_submission_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS submissions_updated_at_trigger ON submissions;

CREATE TRIGGER submissions_updated_at_trigger
BEFORE UPDATE ON submissions
FOR EACH ROW
EXECUTE FUNCTION set_submission_updated_at();
