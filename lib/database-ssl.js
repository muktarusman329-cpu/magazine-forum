export function databaseSslOptions(isProduction, mode = process.env.DATABASE_SSL_MODE) {
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  if (mode) {
    throw new Error('DATABASE_SSL_MODE must be "require" or "verify-full".');
  }
  return isProduction ? { rejectUnauthorized: true } : undefined;
}
