const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { updateSheetHeaders } = require('../helpers/sheets');

// POST /onboarding
// Body: { token, fields, sheetOption }
// (platforms and brief are optional — not collected in the new 2-step flow)
router.post('/', async (req, res) => {
  const { token, platforms, fields, sheetOption, brief } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  // ─── Verify token ──────────────────────────────────────────────────────────
  let user;
  try {
    const result = await pool.query(
      'SELECT id, active, sheet_id FROM users WHERE token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    user = result.rows[0];

    if (!user.active) {
      return res.status(403).json({ error: 'Subscription is not active' });
    }
  } catch (err) {
    console.error('[ONBOARDING] DB error during token lookup:', err.message);
    return res.status(500).json({ error: 'Failed to validate token' });
  }

  // ─── Parse brief fields (optional) ────────────────────────────────────────
  const briefFollowerMin  = brief?.followerMin    ?? null;
  const briefFollowerMax  = brief?.followerMax    ?? null;
  const briefMinEngagement= brief?.minEngagement  ?? null;
  const briefLocation     = brief?.location       ?? null;
  const briefNiches       = brief?.niches         ?? null;

  // ─── Upsert user preferences ───────────────────────────────────────────────
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
        user.id,
        platforms  ?? null,
        fields     ?? null,
        sheetOption ?? null,
        briefFollowerMin,
        briefFollowerMax,
        briefMinEngagement,
        briefLocation,
        briefNiches ?? null,
      ]
    );
  } catch (err) {
    console.error('[ONBOARDING] DB error saving preferences:', err.message);
    return res.status(500).json({ error: 'Failed to save preferences' });
  }

  console.log(`[ONBOARDING] Saved preferences for user ${user.id}`);

  // ─── Update sheet headers to match selected fields ─────────────────────────
  // Do this in the background — don't block the response if it fails.
  if (user.sheet_id && fields && fields.length > 0) {
    updateSheetHeaders(user.sheet_id, fields)
      .then(() => {
        console.log(`[ONBOARDING] Updated sheet headers for user ${user.id}`);
      })
      .catch((err) => {
        console.error(`[ONBOARDING] Failed to update sheet headers for user ${user.id}:`, err.message);
      });
  }

  return res.json({ success: true });
});

module.exports = router;
