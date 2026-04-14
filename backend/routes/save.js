const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { scrapeCreator } = require('../helpers/apify');
const { appendToSheet } = require('../helpers/sheets');
const { computeMatchScore } = require('../helpers/matchScore');
const { rateLimit } = require('../middleware/rateLimit');

const SUPPORTED_PLATFORMS = ['tiktok', 'instagram'];

// ─── Rate limit: 10 saves per minute per token ─────────────────────────────
router.use(rateLimit({
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => req.body?.token || req.ip,
}));

// POST /save
// Body: { token, handle, platform }
router.post('/', async (req, res) => {
  const { token, handle, platform } = req.body;

  if (!token || !handle || !platform) {
    return res.status(400).json({ error: 'token, handle, and platform are required' });
  }

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}` });
  }

  // ─── Validate token and fetch user ────────────────────────────────────────
  let user;
  try {
    const result = await pool.query(
      'SELECT id, email, sheet_id, active, stripe_subscription_id FROM users WHERE token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    user = result.rows[0];

    if (!user.active) {
      return res.status(403).json({ error: 'Subscription is not active' });
    }

    if (!user.sheet_id) {
      return res.status(503).json({ error: 'Sheet not provisioned yet — please try again in a moment' });
    }
  } catch (err) {
    console.error('[SAVE] DB error during token lookup:', err.message);
    return res.status(500).json({ error: 'Failed to validate token' });
  }

  // ─── Check plan-based usage limits ────────────────────────────────────────
  try {
    const usageResult = await pool.query(
      `SELECT COUNT(*) AS saves_this_month
       FROM scrape_log
       WHERE user_id = $1
         AND created_at >= date_trunc('month', NOW())`,
      [user.id]
    );

    const savesThisMonth = parseInt(usageResult.rows[0].saves_this_month, 10);
    const planLimit = user.stripe_subscription_id ? 2000 : 200;
    // TODO: differentiate Starter ($10/2000) vs Pro ($29/unlimited)

    if (savesThisMonth >= planLimit) {
      return res.status(429).json({
        error: 'Monthly save limit reached. Upgrade your plan for more saves.',
        savesThisMonth,
        limit: planLimit,
      });
    }
  } catch (err) {
    console.error('[SAVE] Usage check error:', err.message);
  }

  // ─── Fetch user's campaign brief preferences ─────────────────────────────
  let brief = null;
  try {
    const prefResult = await pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [user.id]
    );
    if (prefResult.rows.length > 0) {
      brief = prefResult.rows[0];
    }
  } catch (err) {
    console.error('[SAVE] Failed to load brief preferences:', err.message);
  }

  // ─── Run Apify scraper ────────────────────────────────────────────────────
  let scrapedData;
  try {
    scrapedData = await scrapeCreator(platform, handle);
  } catch (err) {
    console.error(`[SAVE] Apify error for ${platform}/${handle}:`, err.message);
    return res.status(502).json({ error: `Scraper failed: ${err.message}` });
  }

  // ─── Compute match score ──────────────────────────────────────────────────
  const matchScore = computeMatchScore(scrapedData, brief);
  scrapedData.matchScore = matchScore;

  if (matchScore !== null) {
    console.log(`[SCORE] @${handle} scored ${matchScore}% against ${user.email}'s brief`);
  }

  // ─── Write results to Google Sheet ────────────────────────────────────────
  try {
    await appendToSheet(user.sheet_id, handle, platform, scrapedData);
  } catch (err) {
    console.error(`[SAVE] Sheets write error for user ${user.email}:`, err.message);
    return res.status(502).json({ error: 'Failed to write to Google Sheet' });
  }

  // ─── Log the save to scrape_log ───────────────────────────────────────────
  try {
    await pool.query(
      'INSERT INTO scrape_log (user_id, handle, platform) VALUES ($1, $2, $3)',
      [user.id, handle, platform]
    );
  } catch (err) {
    console.error('[SAVE] Failed to log scrape:', err.message);
  }

  console.log(`[SAVE] ${user.email} saved @${handle} (${platform}) — score: ${matchScore ?? 'N/A'}%`);
  return res.json({ success: true, data: scrapedData });
});

module.exports = router;
