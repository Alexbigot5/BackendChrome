const express = require('express');
const router = express.Router();
const axios = require('axios');
const { rateLimit } = require('../middleware/rateLimit');

const SC_BASE = 'https://api.scrapecreators.com';

// Rate limit: 10 brand lookups per minute per token
router.use(rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.headers['x-livechrome-token'] || req.ip }));

/**
 * POST /brand
 * Body: { url }  — any brand URL or handle, e.g. "https://instagram.com/nike" or "@nike" or "nike"
 * Auth: x-livechrome-token header
 *
 * Returns:
 * {
 *   handle: string,
 *   pageId: string | null,
 *   pageName: string | null,
 *   totalAds: number,
 *   activeAds: number,
 *   platforms: { name: string, count: number }[],
 *   formats: { label: string, count: number }[],
 *   ads: {
 *     id: string,
 *     title: string,
 *     body: string | null,
 *     platform: string,
 *     format: string,
 *     startDate: string,
 *     status: string,
 *     ctaText: string | null,
 *     imageUrl: string | null,
 *   }[]
 * }
 */
router.post('/', async (req, res) => {
  // Accept either:
  //   Authorization: Bearer <clerk-session-token>  (from the dashboard web app)
  //   x-livechrome-token: <internal-token>          (future: from the extension)
  const authHeader = req.headers.authorization;
  const internalToken = req.headers['x-livechrome-token'];

  if (!authHeader && !internalToken) {
    return res.status(401).json({ error: 'Missing Authorization header or x-livechrome-token' });
  }

  // Validate whichever auth method was provided
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const sessionToken = authHeader.slice(7);
    try {
      const payloadB64 = sessionToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
      const clerkUserId = payload.sub;
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
  } else if (internalToken) {
    // Validate internal token
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

  // ── Extract a clean brand name / handle from whatever the user pasted ──
  const handle = extractHandle(url.trim());
  console.log(`[BRAND] Researching brand: "${handle}" (from input: "${url}")`);

  try {
    // Step 1: find the Facebook page ID for this brand
    let pageId = null;
    let pageName = null;

    try {
      const companyRes = await axios.get(`${SC_BASE}/v1/facebook/adLibrary/search/companies`, {
        params: { query: handle },
        headers: { 'x-api-key': apiKey },
        timeout: 15000,
      });

      const results = companyRes.data?.searchResults || [];
      if (results.length > 0) {
        // Pick the best match — prefer exact name match, else first result
        const exact = results.find(r =>
          (r.page_name || '').toLowerCase() === handle.toLowerCase()
        );
        const best = exact || results[0];
        pageId   = best.page_id   || null;
        pageName = best.page_name || null;
      }
    } catch (err) {
      console.warn(`[BRAND] Company lookup failed for "${handle}":`, err.message);
    }

    // Step 2: fetch the brand's active ads
    let rawAds = [];
    try {
      const adsParams = { status: 'ACTIVE', trim: 'true', country: 'US' };

      // Prefer pageId if we found one (more accurate), fall back to companyName search
      if (pageId) {
        adsParams.pageId = pageId;
      } else {
        adsParams.companyName = handle;
      }

      const adsRes = await axios.get(`${SC_BASE}/v1/facebook/adLibrary/company/ads`, {
        params: adsParams,
        headers: { 'x-api-key': apiKey },
        timeout: 20000,
      });

      rawAds = adsRes.data?.ads || adsRes.data?.searchResults || [];
    } catch (err) {
      console.warn(`[BRAND] Ads fetch failed for "${handle}":`, err.message);
      // Return empty result rather than erroring out entirely
    }

    // ── Normalise ads ─────────────────────────────────────────────────────
    const ads = rawAds.slice(0, 20).map(ad => {
      const snap     = ad.snapshot || ad;
      const body     = snap.body?.text || snap.caption || snap.title || null;
      const imageUrl = snap.images?.[0]?.resized_image_url
                    || snap.images?.[0]?.original_image_url
                    || snap.videos?.[0]?.video_preview_image_url
                    || null;

      // Publisher platforms — could be an array of objects or strings
      const publisherPlatforms = (ad.publisher_platforms || []).map(p =>
        typeof p === 'string' ? p : (p.name || p.publisher_platform || '')
      ).filter(Boolean);

      const format = detectFormat(ad, snap);

      return {
        id:        ad.ad_archive_id || ad.id || String(Math.random()),
        title:     snap.title || snap.link_title || pageName || handle,
        body:      body ? body.slice(0, 140) : null,
        platform:  publisherPlatforms[0] || 'facebook',
        platforms: publisherPlatforms,
        format,
        startDate: ad.start_date_string || formatTimestamp(ad.start_date) || null,
        status:    ad.is_active ? 'ACTIVE' : (ad.end_date ? 'INACTIVE' : 'ACTIVE'),
        ctaText:   snap.cta_text || null,
        imageUrl,
      };
    });

    // ── Aggregate stats ───────────────────────────────────────────────────
    const platformCounts = countBy(ads, a => normalisePlatform(a.platform));
    const formatCounts   = countBy(ads, a => a.format);

    const platforms = Object.entries(platformCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const formats = Object.entries(formatCounts)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    console.log(`[BRAND] "${handle}" — ${ads.length} ads, ${formats.length} formats, ${platforms.length} platforms`);

    return res.json({
      handle,
      pageId,
      pageName: pageName || handle,
      totalAds:  rawAds.length,
      activeAds: ads.length,
      platforms,
      formats,
      ads,
    });

  } catch (err) {
    console.error(`[BRAND] Unexpected error for "${handle}":`, err.message);
    return res.status(502).json({ error: `Brand research failed: ${err.message}` });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract a clean brand name from a URL or @handle.
 * "https://instagram.com/nike"  → "nike"
 * "https://tiktok.com/@nike"    → "nike"
 * "@nike"                       → "nike"
 * "nike running shoes"          → "nike running shoes"
 */
function extractHandle(input) {
  try {
    // If it looks like a URL, parse the pathname
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const url      = new URL(input);
      const segments = url.pathname.split('/').filter(Boolean);
      // Remove leading @ from handles like /@nike
      const last = segments[segments.length - 1] || '';
      return last.replace(/^@/, '') || url.hostname.replace('www.', '');
    }
  } catch (_) {}

  // Strip leading @ if present
  return input.replace(/^@/, '');
}

/**
 * Detect the ad creative format from the raw ad object.
 */
function detectFormat(ad, snap) {
  const df = (ad.display_format || snap.display_format || '').toUpperCase();
  if (df.includes('VIDEO'))        return 'Video';
  if (df.includes('MULTI_IMAGE') || df.includes('CAROUSEL')) return 'Carousel';
  if (df.includes('IMAGE'))        return 'Image';
  if (df.includes('STORY'))        return 'Story';
  if (df.includes('REEL'))         return 'Reel';
  // Fall back to media presence
  if (snap.videos?.length)         return 'Video';
  if (snap.images?.length > 1)     return 'Carousel';
  if (snap.images?.length === 1)   return 'Image';
  return 'Image'; // sensible default
}

/** Normalise raw platform strings to clean labels */
function normalisePlatform(p) {
  const s = (p || '').toLowerCase();
  if (s.includes('instagram')) return 'Instagram';
  if (s.includes('tiktok'))    return 'TikTok';
  if (s.includes('facebook'))  return 'Facebook';
  if (s.includes('messenger')) return 'Messenger';
  if (s.includes('whatsapp'))  return 'WhatsApp';
  if (s.includes('audience'))  return 'Audience Network';
  return p || 'Facebook';
}

/** Count occurrences by a key function */
function countBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

/** Format a Unix timestamp to a readable date string */
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
