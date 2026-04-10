const express = require('express');
const axios = require('axios');
const router = express.Router();
const { pool } = require('../db');
const { rateLimit } = require('../middleware/rateLimit');

// ─── Rate limit: 20 verify requests per minute per IP ──────────────────────
router.use(rateLimit({ windowMs: 60_000, max: 20 }));

/**
 * POST /verify
 * Body: { googleToken }
 *
 * Validates the Google OAuth token, extracts the email, and returns
 * the user's LiveChrome token + sheet ID if they have an active sub.
 */
router.post('/', async (req, res) => {
  const { googleToken } = req.body;

  if (!googleToken) {
    return res.status(400).json({ error: 'googleToken is required' });
  }

  let email;
  try {
    const googleRes = await axios.get(
      'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
      { headers: { Authorization: `Bearer ${googleToken}` } }
    );
    email = googleRes.data.email;

    if (!email) {
      return res.status(401).json({ error: 'Could not resolve email from Google token' });
    }
  } catch (err) {
    console.error('[VERIFY] Google token validation failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired Google token' });
  }

  try {
    const result = await pool.query(
      'SELECT active, token, sheet_id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0 || !result.rows[0].active) {
      return res.json({ valid: false });
    }

    const user = result.rows[0];
    return res.json({
      valid: true,
      token: user.token,
      sheetId: user.sheet_id,
    });
  } catch (err) {
    console.error('[VERIFY] DB error:', err.message);
    res.status(500).json({ error: 'Failed to verify user' });
  }
});

// Backwards-compatible GET (deprecated — remove once extension is updated)
router.get('/', async (req, res) => {
  console.warn('[VERIFY] Deprecated GET /verify called — migrate to POST with googleToken');
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'email query parameter is required' });
  }

  try {
    const result = await pool.query(
      'SELECT active, token, sheet_id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0 || !result.rows[0].active) {
      return res.json({ valid: false });
    }

    const user = result.rows[0];
    return res.json({
      valid: true,
      token: user.token,
      sheetId: user.sheet_id,
    });
  } catch (err) {
    console.error('[VERIFY] DB error:', err.message);
    res.status(500).json({ error: 'Failed to verify user' });
  }
});

module.exports = router;
