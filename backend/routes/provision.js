const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { provisionSheet } = require('../helpers/sheets');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// POST /provision
// Headers: Authorization: Bearer <clerk-session-token>
// Called from the frontend after Clerk sign-up.
// Creates user in DB (free tier) and provisions a Google Sheet.
router.post('/', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const sessionToken = authHeader.slice(7);

  let email;
  let clerkUserId;

  // ─── Verify Clerk session ─────────────────────────────────────────────────
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

  // ─── Get email from Clerk ─────────────────────────────────────────────────
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
    // Return early if sheet already provisioned
    const existing = await pool.query(
      'SELECT id, sheet_id, sheet_url FROM users WHERE email = $1',
      [email]
    );
    if (existing.rows.length > 0 && existing.rows[0].sheet_id) {
      return res.json({
        sheetId: existing.rows[0].sheet_id,
        sheetUrl: existing.rows[0].sheet_url,
        alreadyProvisioned: true,
      });
    }

    // Create / upsert user record
    const userToken = generateToken();
    const upsert = await pool.query(
      `INSERT INTO users (email, active, token)
       VALUES ($1, true, $2)
       ON CONFLICT (email) DO UPDATE SET
         active = true,
         token = CASE WHEN users.token IS NULL THEN EXCLUDED.token ELSE users.token END
       RETURNING id`,
      [email, userToken]
    );
    const userId = upsert.rows[0].id;

    // Fetch any already-saved field preferences (e.g. re-provisioning after onboarding)
    let userFields = null;
    try {
      const prefResult = await pool.query(
        'SELECT fields FROM user_preferences WHERE user_id = $1',
        [userId]
      );
      if (prefResult.rows.length > 0) {
        userFields = prefResult.rows[0].fields;
      }
    } catch (_) {
      // Non-fatal — provision with defaults
    }

    // Provision the Google Sheet with the user's field layout
    const { sheetId, sheetUrl } = await provisionSheet(email, userFields);

    await pool.query(
      'UPDATE users SET sheet_id = $1, sheet_url = $2 WHERE id = $3',
      [sheetId, sheetUrl, userId]
    );

    return res.json({ sheetId, sheetUrl, alreadyProvisioned: false });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to provision account: ' + err.message });
  }
});

module.exports = router;
