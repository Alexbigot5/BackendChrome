const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { updateSheetHeaders } = require('../helpers/sheets');

router.post('/', async (req, res) => {
  // Accept Clerk Bearer token (same as /provision)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(400).json({ error: 'Missing or invalid Authorization header' });
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

  const { platforms, fields, sheetOption, brief } = req.body;

  let user;
  try {
    const result = await pool.query(
      'SELECT id, sheet_id FROM users WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    user = result.rows[0];
  } catch (err) {
    console.error('[ONBOARDING] DB error during user lookup:', err.message);
    return res.status(500).json({ error: 'Failed to look up user' });
  }

  const briefFollowerMin   = brief?.followerMin    ?? null;
  const briefFollowerMax   = brief?.followerMax    ?? null;
  const briefMinEngagement = brief?.minEngagement  ?? null;
  const briefLocation      = brief?.location       ?? null;
  const briefNiches        = brief?.niches         ?? null;

  try {
    await pool.query(
      `INSERT INTO user_preferences
         (user_id, platforms, fields, sheet_option,
          brief_follower_min, brief_follower_max, brief_min_engagement,
          brief_location, brief_niches, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         platforms            = EXCLUDED.platforms,
         fields               = EXCLUDED.fields,
         sheet_option         = EXCLUDED.sheet_option,
         brief_follower_min   = EXCLUDED.brief_follower_min,
         brief_follower_max   = EXCLUDED.brief_follower_max,
         brief_min_engagement = EXCLUDED.brief_min_engagement,
         brief_location       = EXCLUDED.brief_location,
         brief_niches         = EXCLUDED.brief_niches,
         updated_at           = NOW()`,
      [
        user.id, platforms ?? null, fields ?? null, sheetOption ?? null,
        briefFollowerMin, briefFollowerMax, briefMinEngagement,
        briefLocation, briefNiches ?? null,
      ]
    );
  } catch (err) {
    console.error('[ONBOARDING] DB error saving preferences:', err.message);
    return res.status(500).json({ error: 'Failed to save preferences' });
  }

  try {
    await pool.query('UPDATE users SET onboarded = true WHERE id = $1', [user.id]);
  } catch (err) {
    console.error('[ONBOARDING] Failed to mark user as onboarded:', err.message);
  }

  console.log(`[ONBOARDING] Completed onboarding for user ${user.id} (${email})`);

  if (user.sheet_id && fields && fields.length > 0) {
    updateSheetHeaders(user.sheet_id, fields)
      .then(() => console.log(`[ONBOARDING] Updated sheet headers for user ${user.id}`))
      .catch((err) => console.error(`[ONBOARDING] Failed to update sheet headers:`, err.message));
  }

  return res.json({ success: true });
});

module.exports = router;
