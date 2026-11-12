CREATE TABLE IF NOT EXISTS admin_sessions (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT admin_sessions_pkey PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS admin_sessions_expire_idx
  ON admin_sessions (expire);
