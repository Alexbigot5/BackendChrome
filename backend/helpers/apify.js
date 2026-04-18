const axios = require('axios');

const SC_BASE = 'https://api.scrapecreators.com';

async function scrapeCreator(platform, handle) {
  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey) throw new Error('SCRAPECREATORS_API_KEY env var is missing');

  console.log(`[SCRAPE] Using ScrapeCreators for ${platform}/@${handle}`);

  if (platform === 'tiktok')    return await scrapeTikTok(handle, apiKey);
  if (platform === 'instagram') return await scrapeInstagram(handle, apiKey);

  throw new Error(`Unsupported platform: ${platform}`);
}

// ─── TikTok ──────────────────────────────────────────────────────────────────

async function scrapeTikTok(handle, apiKey) {
  // Call 1: profile
  const profileRes = await axios.get(`${SC_BASE}/v1/tiktok/profile`, {
    params: { handle },
    headers: { 'x-api-key': apiKey },
  });

  const { user, stats } = profileRes.data;
  if (!user || !stats) throw new Error('ScrapeCreators returned no TikTok profile data');

  const followers  = stats.followerCount  ?? null;
  const following  = stats.followingCount ?? null;
  const totalLikes = stats.heartCount     ?? stats.heart ?? null;
  const videoCount = stats.videoCount     ?? null;

  // Call 2: latest 8 videos
  let avgViews       = null;
  let avgLikes       = null;
  let avgComments    = null;
  let engagementRate = null;

  try {
    const videosRes = await axios.get(`${SC_BASE}/v3/tiktok/profile/videos`, {
      params: { handle },
      headers: { 'x-api-key': apiKey },
    });

    const videos = (videosRes.data?.aweme_list ?? []).slice(0, 8);

    if (videos.length > 0) {
      let totalViews    = 0;
      let totalLikesSum = 0;
      let totalComments = 0;
      let totalShares   = 0;
      let totalSaves    = 0;
      let engRateSum    = 0;
      let engRateCount  = 0;

      for (const v of videos) {
        const s = v.statistics ?? {};
        const views    = s.play_count    ?? 0;
        const likes    = s.digg_count    ?? 0;
        const comments = s.comment_count ?? 0;
        const shares   = s.share_count   ?? 0;
        const saves    = s.collect_count ?? 0;

        totalViews    += views;
        totalLikesSum += likes;
        totalComments += comments;
        totalShares   += shares;
        totalSaves    += saves;

        // Per-video engagement rate: (likes + comments + shares + saves) / views × 100
        if (views > 0) {
          engRateSum   += ((likes + comments + shares + saves) / views) * 100;
          engRateCount += 1;
        }
      }

      avgViews    = Math.round(totalViews    / videos.length);
      avgLikes    = Math.round(totalLikesSum / videos.length);
      avgComments = Math.round(totalComments / videos.length);

      // Average engagement rate across the 8 posts
      if (engRateCount > 0) {
        engagementRate = (engRateSum / engRateCount).toFixed(2) + '%';
      }
    }
  } catch (err) {
    console.warn(`[SCRAPE] Could not fetch TikTok videos for @${handle}: ${err.message}`);
  }

  // Estimated CPM
  let estimatedCpm = null;
  if (followers) {
    const base = 25 + Math.min(25, (followers / 1_000_000) * 10);
    estimatedCpm = '$' + base.toFixed(2);
  }

  console.log(`[SCRAPE] TikTok @${handle}: ${followers} followers, eng: ${engagementRate}`);

  return {
    followers,
    following,
    likes:    totalLikes,
    videos:   videoCount,
    avgViews,
    avgLikes,
    avgComments,
    engagementRate,
    estimatedCpm,
    verified:   user.verified  ?? false,
    niche:      null,
    location:   null,
    bio:        user.signature ?? null,
    matchScore: null,
  };
}

// ─── Instagram ───────────────────────────────────────────────────────────────

async function scrapeInstagram(handle, apiKey) {
  const response = await axios.get(`${SC_BASE}/v1/instagram/profile`, {
    params: { handle, trim: false },
    headers: { 'x-api-key': apiKey },
  });

  const user = response.data?.data?.user;
  if (!user) throw new Error('ScrapeCreators returned no Instagram data');

  const followers = user.edge_followed_by?.count ?? null;
  const following = user.edge_follow?.count      ?? null;
  const posts     = user.edge_owner_to_timeline_media?.count ?? null;

  const recentEdges = (user.edge_owner_to_timeline_media?.edges ?? []).slice(0, 8);
  let avgLikes       = null;
  let avgComments    = null;
  let engagementRate = null;

  if (recentEdges.length > 0 && followers) {
    let totalLikes    = 0;
    let totalComments = 0;
    let engRateSum    = 0;

    for (const e of recentEdges) {
      const likes    = e.node?.edge_liked_by?.count         ?? 0;
      const comments = e.node?.edge_media_to_comment?.count ?? 0;

      totalLikes    += likes;
      totalComments += comments;

      // Per-post engagement rate by followers:
      // (likes + comments) / followers × 100
      engRateSum += ((likes + comments) / followers) * 100;
    }

    avgLikes    = Math.round(totalLikes    / recentEdges.length);
    avgComments = Math.round(totalComments / recentEdges.length);

    // Average engagement rate across the 8 posts
    engagementRate = (engRateSum / recentEdges.length).toFixed(2) + '%';
  }

  // Estimated CPM
  let estimatedCpm = null;
  if (followers) {
    const base = 20 + Math.min(30, (followers / 1_000_000) * 15);
    estimatedCpm = '$' + base.toFixed(2);
  }

  // Location
  let location = null;
  try {
    if (user.business_address_json) {
      const addr = typeof user.business_address_json === 'string'
        ? JSON.parse(user.business_address_json)
        : user.business_address_json;
      location = addr.city_name ?? null;
    }
  } catch (_) {}

  console.log(`[SCRAPE] Instagram @${handle}: ${followers} followers, eng: ${engagementRate}`);

  return {
    followers,
    following,
    likes:    avgLikes,
    videos:   posts,
    avgViews:   null,
    avgLikes,
    avgComments,
    engagementRate,
    estimatedCpm,
    verified:   user.is_verified   ?? false,
    niche:      user.category_name ?? null,
    location,
    bio:        user.biography     ?? null,
    matchScore: null,
  };
}

module.exports = { scrapeCreator };
