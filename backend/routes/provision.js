const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { provisionSheet } = require('../helpers/sheets');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

router.post('/', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const sessionToken = authHeader.slice(7);

  let email;
  let clerkUserId;

  try {
    const payloadB64 = sessionToken.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    clerkUserId = payload.sub;
    const sessionId = payload.sid;
    if (!clerkUserId || !sessionId) throw new Error('Malformed token');

    const sessionResp = await fetch('https://api.clerk.com/v1/sessions/' + sessionId, {
      headers: { Authorization: 'Bearer ' + process.env.CLERK_SECRET_KEY },
    });
    if (!sessionResp.ok) throw new Error('Session not found');
    const session = await sessionResp.json();
    if (session.status !== 'active') throw new Error('Session not active: ' + session.status);
  } catch (err) {
    return res.status(401).json({ error: 'Auth failed: ' + err.message });
  }

  try {
    const userResp = await fetch('https://api.clerk.com/v1/users/' + clerkUserId, {
      headers: { Authorization: 'Bearer ' + process.env.CLERK_SECRET_KEY },
    });
    const clerkUser = await userResp.json();
    const primary = (clerkUser.email_addresses || []).find(
      (e) => e.id === clerkUser.primary_email_address_id
    ) || (clerkUser.email_addresses || [])[0];
    email = primary && primary.email_address;
    if (!email) return res.status(400).json({ error: 'No email address found on Clerk account' });
  } catch (err) {
    return res.status(401).json({ error: 'Failed to fetch user: ' + err.message });
  }

  email = email.toLowerCase().trim();

  try {
    const existing = await pool.query(
      'SELECT id, sheet_id, sheet_url, onboarded FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0 && existing.rows[0].sheet_id) {
      const u = existing.rows[0];
      return res.json({
        sheetId: u.sheet_id,
        sheetUrl: u.sheet_url,
        onboarded: u.onboarded ?? false,
        alreadyProvisioned: true,
      });
    }

    const userToken = generateToken();
    const upsert = await pool.query(
      `INSERT INTO users (email, active, token)
       VALUES ($1, true, $2)
       ON CONFLICT (email) DO UPDATE SET
         active = true,
         token = CASE WHEN users.token IS NULL THEN EXCLUDED.token ELSE users.token END
       RETURNING id, onboarded`,
      [email, userToken]
    );
    const userId = upsert.rows[0].id;
    const onboarded = upsert.rows[0].onboarded ?? false;

    let userFields = null;
    try {
      const prefResult = await pool.query(
        'SELECT fields FROM user_preferences WHERE user_id = $1',
        [userId]
      );
      if (prefResult.rows.length > 0) userFields = prefResult.rows[0].fields;
    } catch (_) {}

    const { sheetId, sheetUrl } = await provisionSheet(email, userFields);

    await pool.query(
      'UPDATE users SET sheet_id = $1, sheet_url = $2 WHERE id = $3',
      [sheetId, sheetUrl, userId]
    );

    return res.json({ sheetId, sheetUrl, onboarded, alreadyProvisioned: false });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to provision account: ' + err.message });
  }
});

module.exports = router;
