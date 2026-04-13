const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createClerkClient } = require('@clerk/backend');
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
  
    try {
          const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
          const { sub: clerkUserId } = await clerk.verifyToken(sessionToken);
          const clerkUser = await clerk.users.getUser(clerkUserId);
          const primary = clerkUser.emailAddresses.find(
                  (e) => e.id === clerkUser.primaryEmailAddressId
                        ) || clerkUser.emailAddresses[0];
          email = primary?.emailAddress;
          if (!email) {
                  return res.status(400).json({ error: 'No email address found on Clerk account' });
          }
    } catch (err) {
          console.error('[PROVISION] Clerk verification failed:', err.message);
          return res.status(401).json({ error: 'Invalid or expired session token' });
    }
  
    email = email.toLowerCase().trim();
  
    try {
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
      
          const userToken = generateToken();
          const upsert = await pool.query(
                  'INSERT INTO users (email, active, token) VALUES ($1, true, $2) ON CONFLICT (email) DO UPDATE SET active = true, token = CASE WHEN users.token IS NULL THEN EXCLUDED.token ELSE users.token END RETURNING id',
                  [email, userToken]
                );
          const userId = upsert.rows[0].id;
      
          const result = await provisionSheet(email);
          const { sheetId, sheetUrl } = result;
          await pool.query(
                  'UPDATE users SET sheet_id = $1, sheet_url = $2 WHERE id = $3',
                  [sheetId, sheetUrl, userId]
                );
          console.log('[PROVISION] Sheet provisioned for ' + email);
          return res.json({ sheetId, sheetUrl, alreadyProvisioned: false });
    } catch (err) {
          console.error('[PROVISION] Error:', err.message);
          return res.status(500).json({ error: 'Failed to provision account: ' + err.message });
    }
});

module.exports = router;TEST
