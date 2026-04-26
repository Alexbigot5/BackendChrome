const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { rateLimit } = require('../middleware/rateLimit');

const SC = 'https://api.scrapecreators.com';

router.use(rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.ip }));

// ─── Auth middleware ──────────────────────────────────────────────────────────
async function authenticate(req, res, next) {
  const authHeader    = req.headers.authorization;
  const internalToken = req.headers['x-livechrome-token'];

  if (!authHeader && !internalToken) {
    return res.status(401).json({ error: 'Missing auth' });
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const sessionToken = authHeader.slice(7);
      const payload      = JSON.parse(Buffer.from(sessionToken.split('.')[1], 'base64url').toString());
      if (!payload.sub || !payload.sid) throw new Error('Malformed token');

      const r = await fetch(`https://api.clerk.com/v1/sessions/${payload.sid}`, {
        headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
      });
      if (!r.ok) throw new Error('Session not found');
      const session = await r.json();
      if (session.status !== 'active') throw new Error('Session inactive');
    } catch (err) {
      return res.status(401).json({ error: 'Auth failed: ' + err.message });
    }
  } else {
    const { pool } = require('../db');
    const result = await pool.query(
      'SELECT id FROM users WHERE token=$1 AND active=true', [internalToken]
    ).catch(() => ({ rows: [] }));
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid token' });
  }

  next();
}

// ─── Safe fetch — never throws, returns null on failure ──────────────────────
async function safeFetch(label, fn) {
  try {
    const result = await fn();
    console.log(`[BRAND] ✓ ${label}`);
    return result;
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message;
    console.warn(`[BRAND] ✗ ${label}: ${status ? `HTTP ${status} — ` : ''}${msg}`);
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractHandle(input) {
  try {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const u   = new URL(input);
      const seg = u.pathname.split('/').filter(Boolean);
      return (seg[seg.length - 1] || '').replace(/^@/, '') || u.hostname.replace('www.', '');
    }
  } catch (_) {}
  return input.replace(/^@/, '');
}

function ts(unix) {
  if (!unix) return null;
  return new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysAgo(unix) {
  if (!unix) return null;
  return Math.floor((Date.now() - unix * 1000) / 86400000);
}

function detectMetaFormat(snap) {
  const df = (snap?.display_format || '').toUpperCase();
  if (df.includes('VIDEO'))   return 'Video';
  if (df.includes('REEL'))    return 'Reel';
  if (df.includes('STORY'))   return 'Story';
  if (df.includes('CAROUSEL') || df.includes('MULTI')) return 'Carousel';
  if (df.includes('IMAGE'))   return 'Image';
  if (snap?.videos?.length)   return 'Video';
  if ((snap?.cards?.length || 0) > 1) return 'Carousel';
  if (snap?.images?.length)   return 'Image';
  return 'Image';
}

function normPlatform(p) {
  const s = (p || '').toLowerCase();
  if (s.includes('instagram')) return 'Instagram';
  if (s.includes('facebook'))  return 'Facebook';
  if (s.includes('messenger')) return 'Messenger';
  if (s.includes('whatsapp'))  return 'WhatsApp';
  if (s.includes('audience'))  return 'Audience Network';
  return 'Facebook';
}

function countBy(arr, fn) {
  return arr.reduce((acc, x) => { const k = fn(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
}

const SPONSORED_TAGS = ['#ad', '#sponsored', '#partner', '#gifted', '#collab', '#paidpartnership', '#brandambassador'];

function isSponsoredCaption(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return SPONSORED_TAGS.some(t => lower.includes(t));
}

// ─── POST /brand ──────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'url is required' });

  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey)  return res.status(500).json({ error: 'SCRAPECREATORS_API_KEY missing' });

  const handle = extractHandle(url.trim());
  console.log(`[BRAND] Starting research for "${handle}"`);

  // ── Run all lookups in parallel ─────────────────────────────────────────────
  const [
    metaCompany,
    igProfile,
    ttProfile,
    ttHashtag,
    ttHashtagPartner,
    igReelsSearch,
    googleAds,
  ] = await Promise.all([

    // 1a. Meta: find page ID
    safeFetch('Meta company search', () =>
      axios.get(`${SC}/v1/facebook/adLibrary/search/companies`, {
        params: { query: handle }, headers: { 'x-api-key': apiKey }, timeout: 12000,
      }).then(r => r.data)
    ),

    // 2. Instagram profile
    safeFetch('Instagram profile', () =>
      axios.get(`${SC}/v1/instagram/profile`, {
        params: { handle }, headers: { 'x-api-key': apiKey }, timeout: 12000,
      }).then(r => r.data)
    ),

    // 3. TikTok profile
    safeFetch('TikTok profile', () =>
      axios.get(`${SC}/v1/tiktok/profile`, {
        params: { handle }, headers: { 'x-api-key': apiKey }, timeout: 12000,
      }).then(r => r.data)
    ),

    // 4a. TikTok hashtag: #brandname
    safeFetch('TikTok hashtag search', () =>
      axios.get(`${SC}/v1/tiktok/search/hashtag`, {
        params: { hashtag: handle }, headers: { 'x-api-key': apiKey }, timeout: 15000,
      }).then(r => r.data)
    ),

    // 4b. TikTok hashtag: #brandnamepartner
    safeFetch('TikTok partner hashtag', () =>
      axios.get(`${SC}/v1/tiktok/search/hashtag`, {
        params: { hashtag: `${handle}partner` }, headers: { 'x-api-key': apiKey }, timeout: 15000,
      }).then(r => r.data)
    ),

    // 4c. Instagram reels search: "brandname sponsored"
    safeFetch('Instagram reels search', () =>
      axios.get(`${SC}/v2/instagram/reels/search`, {
        params: { query: `${handle} sponsored` }, headers: { 'x-api-key': apiKey }, timeout: 15000,
      }).then(r => r.data)
    ),

    // 5. Google Ads
    safeFetch('Google ads', () =>
      axios.get(`${SC}/v1/google/company/ads`, {
        params: { companyName: handle, get_ad_details: 'true' },
        headers: { 'x-api-key': apiKey }, timeout: 15000,
      }).then(r => r.data)
    ),
  ]);

  // ── Section 1: Meta Ads ─────────────────────────────────────────────────────
  let metaAds = null;
  {
    // Find the best matching page ID
    const companies  = metaCompany?.searchResults || [];
    const exact      = companies.find(c => (c.page_name || '').toLowerCase() === handle.toLowerCase());
    const best       = exact || companies[0];
    const pageId     = best?.page_id   || null;
    const pageName   = best?.page_name || null;

    // Fetch ads using pageId if we found one
    let rawAds = [];
    if (pageId || handle) {
      const adsData = await safeFetch('Meta company ads', () =>
        axios.get(`${SC}/v1/facebook/adLibrary/company/ads`, {
          params: {
            ...(pageId ? { pageId } : { companyName: handle }),
            status:  'ACTIVE',
            country: 'ALL',
            trim:    'false',
          },
          headers: { 'x-api-key': apiKey },
          timeout: 20000,
        }).then(r => r.data)
      );
      rawAds = adsData?.results || [];
    }

    const ads = rawAds.slice(0, 20).map(ad => {
      const snap = ad.snapshot || {};
      return {
        id:        ad.ad_archive_id || String(Math.random()),
        title:     snap.title || snap.link_description || ad.page_name || pageName || handle,
        body:      (snap.body?.text || snap.caption || '').slice(0, 160) || null,
        platforms: (ad.publisher_platform || []).map(p => normPlatform(p)),
        format:    detectMetaFormat(snap),
        startDate: ts(ad.start_date),
        daysRunning: daysAgo(ad.start_date),
        ctaText:   snap.cta_text || null,
        imageUrl:  snap.videos?.[0]?.video_preview_image_url
                || snap.images?.[0]?.resized_image_url
                || snap.images?.[0]?.original_image_url
                || null,
      };
    });

    const platformCounts = countBy(ads.flatMap(a => a.platforms), p => p);
    const formatCounts   = countBy(ads, a => a.format);

    metaAds = {
      pageId,
      pageName:  pageName || handle,
      totalAds:  rawAds.length,
      activeAds: ads.length,
      platforms: Object.entries(platformCounts).map(([name, count]) => ({ name, count })).sort((a,b) => b.count - a.count),
      formats:   Object.entries(formatCounts).map(([label, count]) => ({ label, count })).sort((a,b) => b.count - a.count),
      ads,
    };
  }

  // ── Section 2: Creator Partnership History ──────────────────────────────────
  let partnerships = null;
  {
    // ScrapeCreators hashtag search can return different keys depending on endpoint version
    const extractTTVideos = (d) =>
      d?.videos || d?.item_list || d?.aweme_list || d?.data || d?.items || [];

    const ttVideos = [
      ...extractTTVideos(ttHashtag),
      ...extractTTVideos(ttHashtagPartner),
    ];

    // Log what we got so we can debug field shapes
    if (ttVideos.length > 0) {
      const sample = ttVideos[0];
      console.log(`[BRAND] TikTok video sample keys: ${Object.keys(sample).slice(0,10).join(', ')}`);
      if (sample.author) console.log(`[BRAND] author keys: ${Object.keys(sample.author).join(', ')}`);
      console.log(`[BRAND] createTime=${sample.createTime}, create_time=${sample.create_time}`);
    }

    // Deduplicate by video ID
    const seen    = new Set();
    const ttPosts = ttVideos
      .filter(v => {
        const id = v.id || v.video_id || v.aweme_id || v.itemId;
        if (!id || seen.has(String(id))) return false;
        seen.add(String(id));
        return true;
      })
      .map(v => {
        const author  = v.author || v.authorInfo || v.authorMeta || {};
        const stats   = v.stats  || v.statistics || v.statsV2 || {};
        const caption = v.desc   || v.description || v.text || v.title || '';
        // Handle timestamps as either seconds or milliseconds, and as string or number
        const rawTs   = v.createTime || v.create_time || v.createTimestamp || v.timestamp || null;
        const unixTs  = rawTs ? (Number(rawTs) > 1e12 ? Math.floor(Number(rawTs) / 1000) : Number(rawTs)) : null;
        const handle  = author.uniqueId || author.unique_id || author.nickname || author.name;
        return {
          platform:   'tiktok',
          creator:    handle || 'unknown',
          followers:  author.followerCount || author.fans || null,
          caption:    caption.slice(0, 200),
          likes:      Number(stats.diggCount    || stats.like_count    || stats.likeCount    || 0),
          views:      Number(stats.playCount    || stats.play_count    || stats.viewCount    || 0),
          comments:   Number(stats.commentCount || stats.comment_count || stats.replyCount   || 0),
          date:       ts(unixTs),
          daysAgo:    daysAgo(unixTs),
          url:        handle ? `https://www.tiktok.com/@${handle}/video/${v.id || v.aweme_id}` : null,
          isSponsored: isSponsoredCaption(caption),
        };
      })
      .filter(p => p.creator !== 'unknown');

    // Instagram reels search results
    const igPosts = (igReelsSearch?.reels || igReelsSearch?.results || igReelsSearch?.data || [])
      .slice(0, 15)
      .map(r => {
        const caption = r.caption || r.description || r.title || '';
        // IG timestamps can be unix seconds, ms, or ISO string
        const rawTs   = r.taken_at || r.timestamp || r.created_at || null;
        const unixTs  = rawTs
          ? (typeof rawTs === 'string' ? Math.floor(new Date(rawTs).getTime() / 1000)
            : Number(rawTs) > 1e12 ? Math.floor(Number(rawTs) / 1000) : Number(rawTs))
          : null;
        return {
          platform:   'instagram',
          creator:    r.username || r.owner?.username || r.user?.username || 'unknown',
          followers:  null,
          caption:    caption.slice(0, 200),
          likes:      Number(r.like_count    || r.likeCount    || 0),
          views:      Number(r.play_count    || r.playCount    || r.view_count || 0),
          comments:   Number(r.comment_count || r.commentCount || 0),
          date:       ts(unixTs),
          daysAgo:    daysAgo(unixTs),
          url:        r.permalink || r.url || null,
          isSponsored: isSponsoredCaption(caption),
        };
      })
      .filter(p => p.creator !== 'unknown');

    const allPosts = [...ttPosts, ...igPosts]
      .sort((a, b) => (a.daysAgo ?? 9999) - (b.daysAgo ?? 9999));

    // Unique creators
    const creatorMap = {};
    allPosts.forEach(p => {
      const key = `${p.platform}:${p.creator}`;
      if (!creatorMap[key]) {
        creatorMap[key] = { platform: p.platform, creator: p.creator, followers: p.followers, posts: [] };
      }
      creatorMap[key].posts.push(p);
    });

    const creators = Object.values(creatorMap)
      .map(c => ({
        ...c,
        postCount:   c.posts.length,
        latestDaysAgo: Math.min(...c.posts.map(p => p.daysAgo ?? 9999)),
        latestDate:  c.posts[0]?.date,
        sponsoredCount: c.posts.filter(p => p.isSponsored).length,
      }))
      .sort((a, b) => a.latestDaysAgo - b.latestDaysAgo)
      .slice(0, 20);

    partnerships = {
      totalPosts:   allPosts.length,
      totalCreators: Object.keys(creatorMap).length,
      sponsoredPosts: allPosts.filter(p => p.isSponsored).length,
      recentPosts:  allPosts.slice(0, 10),
      creators,
    };
  }

  // ── Section 3: Social Profiles ──────────────────────────────────────────────
  let socialProfiles = null;
  {
    const ig = igProfile?.data?.user || igProfile?.user || igProfile;
    const tt = ttProfile?.user       || ttProfile?.userInfo?.user || ttProfile;
    const ttStats = ttProfile?.stats || ttProfile?.userInfo?.stats || {};

    socialProfiles = {
      instagram: ig ? {
        handle:     ig.username          || handle,
        followers:  ig.edge_followed_by?.count || ig.follower_count || null,
        following:  ig.edge_follow?.count      || ig.following_count || null,
        posts:      ig.edge_owner_to_timeline_media?.count || ig.media_count || null,
        bio:        ig.biography          || null,
        verified:   ig.is_verified        || false,
        category:   ig.category_name      || null,
        website:    ig.external_url       || null,
        profilePic: ig.profile_pic_url_hd || ig.profile_pic_url || null,
      } : null,
      tiktok: tt ? {
        handle:     tt.uniqueId           || handle,
        followers:  ttStats.followerCount || tt.followerCount || null,
        following:  ttStats.followingCount || tt.followingCount || null,
        likes:      ttStats.heartCount    || tt.heartCount     || null,
        videos:     ttStats.videoCount    || tt.videoCount     || null,
        bio:        tt.signature          || null,
        verified:   tt.verified           || false,
        profilePic: tt.avatarMedium       || tt.avatarLarger   || null,
      } : null,
    };
  }

  // ── Section 4: Google Ads ───────────────────────────────────────────────────
  let googleAdsSection = null;
  {
    const raw = googleAds?.ads || googleAds?.results || [];
    const ads = raw.slice(0, 10).map(ad => ({
      id:          ad.creativeId || ad.id || String(Math.random()),
      advertiser:  ad.advertiserName || ad.advertiser?.name || handle,
      headline:    ad.headline || ad.title || null,
      description: (ad.description || ad.body || '').slice(0, 160) || null,
      format:      ad.adType || ad.format || 'Display',
      startDate:   ad.firstShownDate || ad.start_date || null,
      endDate:     ad.lastShownDate  || ad.end_date   || null,
      regions:     ad.regions        || ad.countries  || [],
      imageUrl:    ad.imageUrl       || ad.thumbnail  || null,
    }));

    googleAdsSection = {
      totalAds: raw.length,
      ads,
    };
  }

  console.log(`[BRAND] Done — Meta:${metaAds.activeAds} ads | Partnerships:${partnerships.totalPosts} posts | Google:${googleAdsSection.totalAds} ads`);

  return res.json({
    handle,
    metaAds,
    partnerships,
    socialProfiles,
    googleAds: googleAdsSection,
  });
});

module.exports = router;
