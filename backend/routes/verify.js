const express = require('express');
const axios = require('axios');
const router = express.Router();
const { pool } = require('../db');
const { rateLimit } = require('../middleware/rateLimit');

router.use(rateLimit({ windowMs: 60_000, max: 20 }));

/**
 * POST /verify
 * Body: { googleToken }
 *
 * 1. Resolves the Google email from the Chrome identity token
 * 2. Looks up user by google_email OR email (handles same-email Clerk signups)
 * 3. If found via email match but google_email not yet stored, saves it for future lookups
 * 4. Never creates users — only /provision (Clerk flow) does that
 */
router.post('/', async (req, res) => {
  const { googleToken } = req.body;

  if (!googleToken) {
    return res.status(400).json({ error: 'googleToken is required' });
  }

  let googleEmail;
  try {
    const googleRes = await axios.get(
      'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
      { headers: { Authorization: `Bearer ${googleToken}` } }
    );
    googleEmail = googleRes.data.email?.toLowerCase().trim();
    if (!googleEmail) {
      return res.status(401).json({ error: 'Could not resolve email from Google token' });
    }
  } catch (err) {
    console.error('[VERIFY] Google token validation failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired Google token' });
  }

  try {
    // Match on google_email (returning users) OR email (first-time extension login
    // where Clerk signup email === Google account email)
    const result = await pool.query(
      `SELECT id, active, token, sheet_id, google_email
       FROM users
       WHERE (google_email = $1 OR email = $1)
       LIMIT 1`,
      [googleEmail]
    );

    if (result.rows.length === 0) {
      console.log(`[VERIFY] No account found for Google email: ${googleEmail}`);
      return res.json({ valid: false });
    }

    const user = result.rows[0];

    if (!user.active) {
      return res.json({ valid: false });
    }

    if (!user.sheet_id) {
      return res.json({ valid: false });
    }

    // First time signing in via extension — store google_email for future lookups
    if (!user.google_email) {
      pool.query('UPDATE users SET google_email = $1 WHERE id = $2', [googleEmail, user.id])
        .catch(err => console.error('[VERIFY] Failed to save google_email:', err.message));
    }

    console.log(`[VERIFY] Verified ${googleEmail} → user ${user.id}, sheet ${user.sheet_id}`);

    return res.json({
      valid: true,
      token: user.token,
      sheetId: user.sheet_id,
    });
  } catch (err) {
    console.error('[VERIFY] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to verify user' });
  }
});

module.exports = router;
