import { rateLimit } from 'express-rate-limit';

export function createJsonRateLimiter({ windowMs = 15 * 60 * 1000, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: message }),
  });
}
