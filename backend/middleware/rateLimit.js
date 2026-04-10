/**
 * Simple in-memory rate limiter.
 *
 * Usage:
 *   const { rateLimit } = require('./middleware/rateLimit');
 *   router.post('/', rateLimit({ windowMs: 60_000, max: 10 }), handler);
 */

function rateLimit({ windowMs = 60_000, max = 30, keyFn } = {}) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }, windowMs * 2).unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));

    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests — please slow down' });
    }

    next();
  };
}

module.exports = { rateLimit };
