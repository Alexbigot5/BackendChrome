/**
 * Match Scoring Engine
 *
 * Compares scraped creator data against the user's campaign brief
 * and returns a 0–100 score.
 *
 * Scoring breakdown (weights sum to 100):
 *   - Follower range fit:   30 pts
 *   - Engagement rate:      30 pts
 *   - Location match:       20 pts
 *   - Niche/keyword match:  20 pts
 *
 * Each dimension returns 0–1, multiplied by its weight.
 */

const WEIGHTS = {
  followers: 30,
  engagement: 30,
  location: 20,
  niche: 20,
};

/**
 * @param {object} creator   — normalised Apify result
 * @param {object} brief     — user_preferences row from DB
 * @returns {number}         — integer 0–100
 */
function computeMatchScore(creator, brief) {
  if (!brief) return null;

  let totalScore = 0;
  let totalWeight = 0;

  // ─── 1. Follower range fit (30 pts) ────────────────────────────────────────
  const followerScore = scoreFollowers(creator.followers, brief);
  if (followerScore !== null) {
    totalScore += followerScore * WEIGHTS.followers;
    totalWeight += WEIGHTS.followers;
  }

  // ─── 2. Engagement rate (30 pts) ───────────────────────────────────────────
  const engagementScore = scoreEngagement(creator.engagementRate, brief);
  if (engagementScore !== null) {
    totalScore += engagementScore * WEIGHTS.engagement;
    totalWeight += WEIGHTS.engagement;
  }

  // ─── 3. Location match (20 pts) ───────────────────────────────────────────
  const locationScore = scoreLocation(creator.location, brief);
  if (locationScore !== null) {
    totalScore += locationScore * WEIGHTS.location;
    totalWeight += WEIGHTS.location;
  }

  // ─── 4. Niche / keyword match (20 pts) ────────────────────────────────────
  const nicheScore = scoreNiche(creator, brief);
  if (nicheScore !== null) {
    totalScore += nicheScore * WEIGHTS.niche;
    totalWeight += WEIGHTS.niche;
  }

  // If no dimensions could be scored, return null
  if (totalWeight === 0) return null;

  // Normalise so that available dimensions scale to 100
  const normalized = Math.round((totalScore / totalWeight) * 100);
  return Math.min(100, Math.max(0, normalized));
}

// ─── Dimension scorers ──────────────────────────────────────────────────────

/**
 * Follower count scoring.
 * - Inside range → 1.0
 * - Within 2× of a boundary → linear decay
 * - Way outside → 0
 */
function scoreFollowers(rawFollowers, brief) {
  const followers = parseNumber(rawFollowers);
  const min = parseNumber(brief.brief_follower_min);
  const max = parseNumber(brief.brief_follower_max);

  if (followers === null) return null;
  if (min === null && max === null) return null; // no pref set

  // Both bounds set
  if (min !== null && max !== null) {
    if (followers >= min && followers <= max) return 1.0;

    // Below min: linear decay from min down to min/2
    if (followers < min) {
      const floor = min * 0.5;
      if (followers <= floor) return 0;
      return (followers - floor) / (min - floor);
    }

    // Above max: linear decay from max up to max*2
    const ceiling = max * 2;
    if (followers >= ceiling) return 0;
    return (ceiling - followers) / (ceiling - max);
  }

  // Only min set
  if (min !== null) {
    if (followers >= min) return 1.0;
    const floor = min * 0.5;
    if (followers <= floor) return 0;
    return (followers - floor) / (min - floor);
  }

  // Only max set
  if (followers <= max) return 1.0;
  const ceiling = max * 2;
  if (followers >= ceiling) return 0;
  return (ceiling - followers) / (ceiling - max);
}

/**
 * Engagement rate scoring.
 * - At or above the minimum → 1.0
 * - Below → proportional score (e.g. 2% when min is 3% → 0.67)
 */
function scoreEngagement(rawEngagement, brief) {
  const engagement = parsePercentage(rawEngagement);
  const minEngagement = parseNumber(brief.brief_min_engagement);

  if (engagement === null || minEngagement === null) return null;
  if (minEngagement === 0) return 1.0;

  if (engagement >= minEngagement) return 1.0;

  // Proportional: never go below 0
  return Math.max(0, engagement / minEngagement);
}

/**
 * Location matching.
 * Fuzzy case-insensitive match: full match → 1.0, partial → 0.5, none → 0.
 * Supports "Global" or empty brief_location as "any location → 1.0".
 */
function scoreLocation(creatorLocation, brief) {
  const briefLocation = (brief.brief_location || '').trim().toLowerCase();

  // No location preference or "global" → everything matches
  if (!briefLocation || briefLocation === 'global') return null;

  const creatorLoc = (creatorLocation || '').trim().toLowerCase();
  if (!creatorLoc) return 0.25; // Unknown location gets partial credit

  // Exact match
  if (creatorLoc === briefLocation) return 1.0;

  // Partial match (one contains the other — e.g. "US" in "United States")
  if (creatorLoc.includes(briefLocation) || briefLocation.includes(creatorLoc)) return 0.8;

  // Check common abbreviations
  const aliases = {
    us: ['usa', 'united states', 'america'],
    uk: ['united kingdom', 'england', 'britain', 'great britain'],
    uae: ['united arab emirates', 'dubai', 'abu dhabi'],
  };

  for (const [key, values] of Object.entries(aliases)) {
    const all = [key, ...values];
    const briefMatch = all.some((a) => briefLocation.includes(a));
    const creatorMatch = all.some((a) => creatorLoc.includes(a));
    if (briefMatch && creatorMatch) return 0.9;
  }

  return 0;
}

/**
 * Niche / keyword scoring.
 * Checks how many of the brief's niche keywords appear in the creator's
 * niche, bio, or category.
 */
function scoreNiche(creator, brief) {
  const niches = brief.brief_niches;
  if (!niches || (Array.isArray(niches) && niches.length === 0)) return null;

  // Parse keywords — could be a comma-separated string or a PG text array
  let keywords = [];
  if (Array.isArray(niches)) {
    keywords = niches.map((n) => n.toLowerCase().trim()).filter(Boolean);
  } else if (typeof niches === 'string') {
    keywords = niches.split(',').map((n) => n.toLowerCase().trim()).filter(Boolean);
  }

  if (keywords.length === 0) return null;

  // Build a search corpus from all available creator text
  const corpus = [
    creator.niche || '',
    creator.bio || '',
    creator.category || '',
  ]
    .join(' ')
    .toLowerCase();

  if (!corpus.trim()) return 0.25; // No creator data to match against

  // Count keyword hits
  const hits = keywords.filter((kw) => corpus.includes(kw)).length;
  return hits / keywords.length;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Parses a number from various formats: 501000, "501K", "1.1M", "501,000"
 */
function parseNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;

  const str = String(value).trim().replace(/,/g, '');
  if (!str) return null;

  // Handle K/M suffixes
  const suffixMatch = str.match(/^([\d.]+)\s*(k|m|b)$/i);
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1]);
    const suffix = suffixMatch[2].toLowerCase();
    if (suffix === 'k') return num * 1_000;
    if (suffix === 'm') return num * 1_000_000;
    if (suffix === 'b') return num * 1_000_000_000;
  }

  const parsed = parseFloat(str);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Parses a percentage string like "6.0%" → 6.0, or a raw number.
 */
function parsePercentage(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;

  const str = String(value).trim().replace('%', '');
  const parsed = parseFloat(str);
  return isNaN(parsed) ? null : parsed;
}

module.exports = { computeMatchScore };
