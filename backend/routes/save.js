const express = require('express');
const router = express.Router();
const { pool } = require('../index');
const { runApify } = require('../helpers/apify');
const { appendToSheet } = require('../helpers/sheets');

const SUPPORTED_PLATFORMS = ['tiktok', 'instagram'];

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

  // Validate token and fetch user
  let user;
  try {
    const result = await pool.query(
      'SELECT id, email, sheet_id, active FROM users WHERE token = $1',
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

  // Run Apify scraper
  let scrapedData;
  try {
    scrapedData = await runApify(platform, handle);
  } catch (err) {
    console.error(`[SAVE] Apify error for ${platform}/${handle}:`, err.message);
    return res.status(502).json({ error: `Scraper failed: ${err.message}` });
  }

  // Write results to Google Sheet
  try {
    await appendToSheet(user.sheet_id, handle, platform, scrapedData);
  } catch (err) {
    console.error(`[SAVE] Sheets write error for user ${user.email}:`, err.message);
    return res.status(502).json({ error: 'Failed to write to Google Sheet' });
  }

  console.log(`[SAVE] ${user.email} saved @${handle} (${platform})`);
  return res.json({ success: true, data: scrapedData });
});

module.exports = router;
