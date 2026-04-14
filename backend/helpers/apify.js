const axios = require('axios');

const APIFY_BASE = 'https://api.apify.com/v2';
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 120_000; // 2 minutes

const ACTORS = {
  tiktok: 'clockworks/tiktok-scraper',
  instagram: 'apify/instagram-scraper',
};

function buildInput(platform, handle) {
  if (platform === 'tiktok') {
    return {
      profiles: [`https://www.tiktok.com/@${handle}`],
      resultsType: 'profiles',
      maxProfilesPerQuery: 1,
    };
  }

  if (platform === 'instagram') {
    return {
      usernames: [handle],
      resultsType: 'details',
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

function normaliseResult(platform, item) {
  if (platform === 'tiktok') {
    const meta = item.authorMeta ?? item;
    const followerCount = meta.fans ?? meta.followerCount ?? null;
    const followingCount = meta.following ?? null;
    const heartCount = meta.heart ?? meta.heartCount ?? null;
    const videoCount = meta.video ?? meta.videoCount ?? null;

    let engagementRate = null;
    if (followerCount && heartCount && videoCount && videoCount > 0) {
      engagementRate = ((heartCount / videoCount / followerCount) * 100).toFixed(2) + '%';
    }

    return {
      followers: followerCount,
      following: followingCount,
      likes: heartCount,
      videos: videoCount,
      engagementRate,
      niche: item.category ?? null,
      location: item.region ?? item.location ?? null,
      bio: item.signature ?? item.bioLink ?? null,
      matchScore: null,
    };
  }

  if (platform === 'instagram') {
    const followers = item.followersCount ?? item.followedByCount ?? null;
    const following = item.followsCount ?? item.followingCount ?? null;
    const mediaCount = item.postsCount ?? item.mediaCount ?? null;
    const avgLikes = item.avgLikesCount ?? null;

    let engagementRate = null;
    if (followers && avgLikes) {
      engagementRate = ((avgLikes / followers) * 100).toFixed(2) + '%';
    }

    return {
      followers,
      following,
      likes: avgLikes,
      videos: mediaCount,
      engagementRate,
      niche: item.category ?? null,
      location: item.city ?? item.country ?? null,
      bio: item.biography ?? null,
      matchScore: null,
    };
  }

  return {};
}

async function runApify(platform, handle) {
  const actor = ACTORS[platform];
  if (!actor) throw new Error(`No Apify actor configured for platform: ${platform}`);

  const token = process.env.APIFY_API_TOKEN;
  const input = buildInput(platform, handle);

  const startResponse = await axios.post(
    `${APIFY_BASE}/acts/${encodeURIComponent(actor)}/runs`,
    input,
    {
      params: { token },
      headers: { 'Content-Type': 'application/json' },
    }
  );

  const runId = startResponse.data?.data?.id;
  if (!runId) throw new Error('Apify did not return a run ID');

  console.log(`[APIFY] Started run ${runId} for ${platform}/@${handle}`);

  const deadline = Date.now() + MAX_POLL_MS;
  let status = 'RUNNING';

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const statusResponse = await axios.get(`${APIFY_BASE}/actor-runs/${runId}`, {
      params: { token },
    });

    status = statusResponse.data?.data?.status;
    console.log(`[APIFY] Run ${runId} status: ${status}`);

    if (status === 'SUCCEEDED') break;

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error(`Apify run ended with status: ${status}`);
    }
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run timed out after ${MAX_POLL_MS / 1000}s`);
  }

  const datasetId = (
    await axios.get(`${APIFY_BASE}/actor-runs/${runId}`, { params: { token } })
  ).data?.data?.defaultDatasetId;

  const itemsResponse = await axios.get(`${APIFY_BASE}/datasets/${datasetId}/items`, {
    params: { token, limit: 1 },
  });

  const items = itemsResponse.data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Apify returned no data for this handle');
  }

  console.log('[APIFY] Raw item:', JSON.stringify(items[0]));

  return normaliseResult(platform, items[0]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRapidAPI(platform, handle) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) throw new Error('RAPIDAPI_KEY not set');

  if (platform === 'tiktok') {
    const response = await axios.get(
      'https://tiktok-api6.p.rapidapi.com/user/info',
      {
        params: { unique_id: handle },
        headers: {
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': 'tiktok-api6.p.rapidapi.com',
        },
      }
    );
    const user = response.data?.userInfo?.user;
    const stats = response.data?.userInfo?.stats;
    if (!user) throw new Error('RapidAPI returned no TikTok data');

    const followers = stats?.followerCount ?? null;
    const following = stats?.followingCount ?? null;
    const hearts = stats?.heartCount ?? null;
    const videos = stats?.videoCount ?? null;

    let engagementRate = null;
    if (followers && hearts && videos && videos > 0) {
      engagementRate = ((hearts / videos / followers) * 100).toFixed(2) + '%';
    }

    return {
      followers,
      following,
      likes: hearts,
      videos,
      engagementRate,
      niche: null,
      location: null,
      bio: user.signature ?? null,
      matchScore: null,
    };
  }

  if (platform === 'instagram') {
    const response = await axios.get(
      'https://instagram-scraper-api2.p.rapidapi.com/v1/info',
      {
        params: { username_or_id_or_url: handle },
        headers: {
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': 'instagram-scraper-api2.p.rapidapi.com',
        },
      }
    );
    const user = response.data?.data;
    if (!user) throw new Error('RapidAPI returned no Instagram data');

    const followers = user.follower_count ?? null;
    const following = user.following_count ?? null;
    const avgLikes = user.avg_like_count ?? null;
    const mediaCount = user.media_count ?? null;

    let engagementRate = null;
    if (followers && avgLikes) {
      engagementRate = ((avgLikes / followers) * 100).toFixed(2) + '%';
    }

    return {
      followers,
      following,
      likes: avgLikes,
      videos: mediaCount,
      engagementRate,
      niche: user.category ?? null,
      location: user.city_name ?? null,
      bio: user.biography ?? null,
      matchScore: null,
    };
  }

  throw new Error(`RapidAPI: unsupported platform ${platform}`);
}

async function scrapeCreator(platform, handle) {
  try {
    console.log(`[SCRAPE] Trying Apify for ${platform}/@${handle}`);
    return await runApify(platform, handle);
  } catch (err) {
    console.warn(`[SCRAPE] Apify failed for ${platform}/@${handle}: ${err.message}`);
    console.log(`[SCRAPE] Falling back to RapidAPI for ${platform}/@${handle}`);
    return await runRapidAPI(platform, handle);
  }
}

module.exports = { scrapeCreator, runApify };
