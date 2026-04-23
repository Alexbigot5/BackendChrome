const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /stats
// Headers: Authorization: Bearer <clerk-session-token>
// Returns usage stats + recent saves for the dashboard
router.get('/', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
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
    if (session.status !== 'active') throw new Error('Session not active');
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
    email = primary?.email_address;
    if (!email) return res.status(400).json({ error: 'No email on Clerk account' });
  } catch (err) {
    return res.status(401).json({ error: 'Failed to fetch user: ' + err.message });
  }

  email = email.toLowerCase().trim();

  try {
    const userResult = await pool.query(
      'SELECT id, stripe_subscription_id FROM users WHERE email = $1',
      [email]
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];
    const limit = user.stripe_subscription_id ? 2000 : 100;

    // Saves this month
    const monthResult = await pool.query(
      `SELECT COUNT(*) AS count FROM scrape_log
       WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
      [user.id]
    );
    const savesThisMonth = parseInt(monthResult.rows[0].count, 10);

    // Total saves
    const totalResult = await pool.query(
      'SELECT COUNT(*) AS count FROM scrape_log WHERE user_id = $1',
      [user.id]
    );
    const totalSaves = parseInt(totalResult.rows[0].count, 10);

    // Recent saves (last 10)
    const recentResult = await pool.query(
      `SELECT id, handle, platform, created_at
       FROM scrape_log WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    );

    return res.json({
      savesThisMonth,
      totalSaves,
      limit,
      recentSaves: recentResult.rows,
    });
  } catch (err) {
    console.error('[STATS] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
