const axios = require('axios');

const SC_BASE = 'https://api.scrapecreators.com';

async function scrapeCreator(platform, handle) {
  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey) throw new Error('SCRAPECREATORS_API_KEY env var is missing');

  console.log(`[SCRAPE] Using ScrapeCreators for ${platform}/@${handle}`);

  if (platform === 'tiktok') return await scrapeTikTok(handle, apiKey);
  if (platform === 'instagram') return await scrapeInstagram(handle, apiKey);

  throw new Error(`Unsupported platform: ${platform}`);
}

async function scrapeTikTok(handle, apiKey) {
  const response = await axios.get(`${SC_BASE}/v1/tiktok/profile`, {
    params: { handle },
    headers: { 'x-api-key': apiKey },
  });

  const { user, stats } = response.data;
  if (!user || !stats) throw new Error('ScrapeCreators returned no TikTok data');

  const followers = stats.followerCount ?? null;
  const following = stats.followingCount ?? null;
  const likes     = stats.heartCount ?? stats.heart ?? null;
  const videos    = stats.videoCount ?? null;

  let engagementRate = null;
  if (followers && likes && videos && videos > 0) {
    engagementRate = ((likes / videos / followers) * 100).toFixed(2) + '%';
  }

  let estimatedCpm = null;
  if (followers) {
    const base = 25 + Math.min(25, (followers / 1_000_000) * 10);
    estimatedCpm = '$' + base.toFixed(2);
  }

  console.log(`[SCRAPE] TikTok @${handle}: ${followers} followers`);

  return {
    followers,
    following,
    likes,
    videos,
    engagementRate,
    estimatedCpm,
    verified: user.verified ?? false,
    niche:    user.category ?? null,
    location: user.region ?? null,
    bio:      user.signature ?? null,
    matchScore: null,
  };
}

async function scrapeInstagram(handle, apiKey) {
  const response = await axios.get(`${SC_BASE}/v1/instagram/profile`, {
    params: { handle, trim: false },
    headers: { 'x-api-key': apiKey },
  });

  const user = response.data?.data?.user;
  if (!user) throw new Error('ScrapeCreators returned no Instagram data');

  const followers = user.edge_followed_by?.count ?? null;
  const following = user.edge_follow?.count     ?? null;
  const posts     = user.edge_owner_to_timeline_media?.count ?? null;

  // Calculate avg likes from recent posts if available
  const recentEdges = user.edge_owner_to_timeline_media?.edges ?? [];
  let avgLikes    = null;
  let avgComments = null;
  if (recentEdges.length > 0) {
    const totalLikes    = recentEdges.reduce((s, e) => s + (e.node?.edge_liked_by?.count ?? 0), 0);
    const totalComments = recentEdges.reduce((s, e) => s + (e.node?.edge_media_to_comment?.count ?? 0), 0);
    avgLikes    = Math.round(totalLikes    / recentEdges.length);
    avgComments = Math.round(totalComments / recentEdges.length);
  }

  let engagementRate = null;
  if (followers && avgLikes) {
    engagementRate = ((avgLikes / followers) * 100).toFixed(2) + '%';
  }

  let estimatedCpm = null;
  if (followers) {
    const base = 20 + Math.min(30, (followers / 1_000_000) * 15);
    estimatedCpm = '$' + base.toFixed(2);
  }

  // Parse city from business_address_json if present
  let location = null;
  try {
    if (user.business_address_json) {
      const addr = typeof user.business_address_json === 'string'
        ? JSON.parse(user.business_address_json)
        : user.business_address_json;
      location = addr.city_name ?? null;
    }
  } catch (_) {}

  console.log(`[SCRAPE] Instagram @${handle}: ${followers} followers`);

  return {
    followers,
    following,
    likes:    avgLikes,
    videos:   posts,
    avgComments,
    engagementRate,
    estimatedCpm,
    verified: user.is_verified ?? false,
    niche:    user.category_name ?? null,
    location,
    bio:      user.biography ?? null,
    matchScore: null,
  };
}

module.exports = { scrapeCreator };
