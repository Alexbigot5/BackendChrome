const express = require('express');
const router = express.Router();
const axios = require('axios');
const { rateLimit } = require('../middleware/rateLimit');

const SC_BASE = 'https://api.scrapecreators.com';

// Rate limit: 10 brand lookups per minute per user
router.use(rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.ip }));

/**
 * POST /brand
 * Body: { url }  — any brand URL or handle
 * Auth: Authorization: Bearer <clerk-session-token>  OR  x-livechrome-token: <internal-token>
 *
 * Calls ScrapeCreators Facebook Ad Library:
 *   1. GET /v1/facebook/adLibrary/search/companies?query=<handle>  → find pageId
 *   2. GET /v1/facebook/adLibrary/company/ads?pageId=<id>&status=ACTIVE  → get ads
 *
 * Real response shape (from docs):
 * {
 *   results: [ {
 *     ad_archive_id, is_active, page_name, page_id,
 *     publisher_platform: ['INSTAGRAM', 'FACEBOOK'],   ← top-level array
 *     start_date: 1740643200,                          ← unix timestamp
 *     snapshot: {
 *       display_format: 'VIDEO',
 *       body: { text: '...' },
 *       title: null,
 *       cta_text: 'Learn more',
 *       images: [],
 *       videos: [{ video_preview_image_url: '...' }],
 *       cards: [],
 *     }
 *   } ],
 *   cursor: '...'
 * }
 */
router.post('/', async (req, res) => {
  // Accept Clerk Bearer token (dashboard) or internal token (extension)
  const authHeader    = req.headers.authorization;
  const internalToken = req.headers['x-livechrome-token'];

  if (!authHeader && !internalToken) {
    return res.status(401).json({ error: 'Missing Authorization header or x-livechrome-token' });
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const sessionToken = authHeader.slice(7);
    try {
      const payloadB64 = sessionToken.split('.')[1];
      const payload    = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
      const clerkUserId = payload.sub;
      const sessionId   = payload.sid;
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
  } else if (internalToken) {
    const { pool } = require('../db');
    try {
      const result = await pool.query(
        'SELECT id FROM users WHERE token = $1 AND active = true',
        [internalToken]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid or inactive token' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Auth check failed' });
    }
  }

  const { url } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'url is required' });
  }

  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'SCRAPECREATORS_API_KEY env var is missing' });
  }

  const handle = extractHandle(url.trim());
  console.log(`[BRAND] Researching: "${handle}" (input: "${url}")`);

  try {
    // ── Step 1: Find the Facebook page ID ──────────────────────────────────
    let pageId   = null;
    let pageName = null;

    try {
      const companyRes = await axios.get(`${SC_BASE}/v1/facebook/adLibrary/search/companies`, {
        params:  { query: handle },
        headers: { 'x-api-key': apiKey },
        timeout: 15000,
      });

      // Response: { searchResults: [{ page_id, page_name, ... }] }
      const results = companyRes.data?.searchResults || [];
      if (results.length > 0) {
        const exact = results.find(r =>
          (r.page_name || '').toLowerCase() === handle.toLowerCase()
        );
        const best = exact || results[0];
        pageId   = best.page_id   || null;
        pageName = best.page_name || null;
      }
      console.log(`[BRAND] Company lookup: pageId=${pageId}, pageName=${pageName}`);
    } catch (err) {
      console.warn(`[BRAND] Company lookup failed:`, err.message);
    }

    // ── Step 2: Fetch active ads ────────────────────────────────────────────
    let rawAds = [];
    try {
      // Build params — prefer pageId (more precise), fall back to companyName
      const params = {
        status:   'ACTIVE',
        country:  'ALL',
        trim:     'false',   // full response so we get snapshot details
      };
      if (pageId) {
        params.pageId = pageId;
      } else {
        params.companyName = handle;
      }

      const adsRes = await axios.get(`${SC_BASE}/v1/facebook/adLibrary/company/ads`, {
        params,
        headers: { 'x-api-key': apiKey },
        timeout: 20000,
      });

      // Real response key is "results" (not "ads" or "searchResults")
      rawAds = adsRes.data?.results || [];
      console.log(`[BRAND] Raw ads fetched: ${rawAds.length}`);

      // Debug: log the first ad structure so we can see what fields come back
      if (rawAds.length > 0) {
        const sample = rawAds[0];
        console.log(`[BRAND] Sample ad keys: ${Object.keys(sample).join(', ')}`);
        console.log(`[BRAND] publisher_platform: ${JSON.stringify(sample.publisher_platform)}`);
        console.log(`[BRAND] snapshot.display_format: ${sample.snapshot?.display_format}`);
      }
    } catch (err) {
      console.warn(`[BRAND] Ads fetch failed:`, err.message);
      if (err.response) {
        console.warn(`[BRAND] Response status: ${err.response.status}`);
        console.warn(`[BRAND] Response data: ${JSON.stringify(err.response.data)}`);
      }
    }

    // ── Normalise ads ───────────────────────────────────────────────────────
    const ads = rawAds.slice(0, 20).map(ad => {
      const snap = ad.snapshot || {};

      // Body text
      const body = snap.body?.text || snap.caption || snap.title || null;

      // Thumbnail — videos have preview images, images have direct URLs
      const imageUrl =
        snap.videos?.[0]?.video_preview_image_url ||
        snap.images?.[0]?.resized_image_url        ||
        snap.images?.[0]?.original_image_url        ||
        snap.cards?.[0]?.resized_image_url          ||
        null;

      // publisher_platform is top-level on the ad object (array of strings like 'INSTAGRAM')
      const publisherPlatforms = (ad.publisher_platform || [])
        .map(p => (typeof p === 'string' ? p : (p.name || '')))
        .filter(Boolean);

      const format = detectFormat(snap);

      return {
        id:        ad.ad_archive_id || String(Math.random()),
        title:     snap.title || snap.link_description || ad.page_name || pageName || handle,
        body:      body ? body.slice(0, 160) : null,
        platform:  publisherPlatforms[0] || 'FACEBOOK',
        platforms: publisherPlatforms,
        format,
        startDate: formatTimestamp(ad.start_date),
        status:    ad.is_active ? 'ACTIVE' : 'INACTIVE',
        ctaText:   snap.cta_text || null,
        imageUrl,
      };
    });

    // ── Aggregate stats ─────────────────────────────────────────────────────
    const platformCounts = countBy(ads, a => normalisePlatform(a.platform));
    const formatCounts   = countBy(ads, a => a.format);

    const platforms = Object.entries(platformCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const formats = Object.entries(formatCounts)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    console.log(`[BRAND] Done: ${ads.length} ads, platforms: ${platforms.map(p => p.name).join(', ')}, formats: ${formats.map(f => f.label).join(', ')}`);

    return res.json({
      handle,
      pageId,
      pageName:  pageName || handle,
      totalAds:  rawAds.length,
      activeAds: ads.length,
      platforms,
      formats,
      ads,
    });

  } catch (err) {
    console.error(`[BRAND] Unexpected error:`, err.message);
    return res.status(502).json({ error: `Brand research failed: ${err.message}` });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function extractHandle(input) {
  try {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const u        = new URL(input);
      const segments = u.pathname.split('/').filter(Boolean);
      const last     = segments[segments.length - 1] || '';
      return last.replace(/^@/, '') || u.hostname.replace('www.', '');
    }
  } catch (_) {}
  return input.replace(/^@/, '');
}

function detectFormat(snap) {
  const df = (snap.display_format || '').toUpperCase();
  if (df.includes('VIDEO'))                              return 'Video';
  if (df.includes('REEL'))                               return 'Reel';
  if (df.includes('STORY'))                              return 'Story';
  if (df.includes('CAROUSEL') || df.includes('MULTI'))  return 'Carousel';
  if (df.includes('IMAGE'))                              return 'Image';
  // Fall back to media presence
  if (snap.videos?.length)                               return 'Video';
  if ((snap.cards?.length || 0) > 1)                    return 'Carousel';
  if (snap.images?.length)                               return 'Image';
  return 'Image';
}

function normalisePlatform(p) {
  const s = (p || '').toLowerCase();
  if (s.includes('instagram'))  return 'Instagram';
  if (s.includes('facebook'))   return 'Facebook';
  if (s.includes('tiktok'))     return 'TikTok';
  if (s.includes('messenger'))  return 'Messenger';
  if (s.includes('whatsapp'))   return 'WhatsApp';
  if (s.includes('audience'))   return 'Audience Network';
  return 'Facebook';
}

function countBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function formatTimestamp(ts) {
  if (!ts) return null;
  try {
    return new Date(ts * 1000).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch (_) {
    return null;
  }
}

module.exports = router;
