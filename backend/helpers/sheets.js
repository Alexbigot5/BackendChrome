const { google } = require('googleapis');

function getAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId) throw new Error('GOOGLE_CLIENT_ID env var is missing');
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET env var is missing');
  if (!refreshToken) throw new Error('GOOGLE_REFRESH_TOKEN env var is missing');

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

// ─── Field → column header label ────────────────────────────────────────────
const FIELD_LABELS = {
  handle:        'Handle',
  followers:     'Followers',
  location:      'Location',
  avgViews:      'Avg Views',
  avgLikes:      'Avg Likes',
  avgComments:   'Avg Comments',
  engagementRate:'Engagement Rate',
  estimatedCpm:  'Est. CPM',
  // Always appended at the end regardless of user selection
  _savedAt:      'Saved At',
};

// These are always present — handle is always first, savedAt always last.
const LOCKED_FIRST = ['handle'];
const LOCKED_LAST  = ['_savedAt'];

/**
 * Build an ordered header row from the user's saved fields array.
 * 'handle' is always first. 'Saved At' is always last.
 * Unknown field keys are ignored.
 */
function buildHeaders(fields) {
  // fields from DB may include 'handle' already — deduplicate
  const middle = (fields || []).filter(
    (f) => !LOCKED_FIRST.includes(f) && !LOCKED_LAST.includes(f) && FIELD_LABELS[f]
  );
  const ordered = [...LOCKED_FIRST, ...middle, ...LOCKED_LAST];
  return ordered.map((f) => FIELD_LABELS[f]);
}

/**
 * Build a data row aligned to the user's saved fields.
 * data = normalised Apify result (+ matchScore).
 */
function buildRow(fields, handle, platform, data) {
  const middle = (fields || []).filter(
    (f) => !LOCKED_FIRST.includes(f) && !LOCKED_LAST.includes(f) && FIELD_LABELS[f]
  );
  const ordered = [...LOCKED_FIRST, ...middle, ...LOCKED_LAST];

  return ordered.map((f) => {
    switch (f) {
      case 'handle':        return handle;
      case 'followers':     return data?.followers      ?? '';
      case 'location':      return data?.location       ?? '';
      case 'avgViews':      return data?.avgViews       ?? data?.videos ?? '';
      case 'avgLikes':      return data?.likes          ?? '';
      case 'avgComments':   return data?.avgComments    ?? '';
      case 'engagementRate':return data?.engagementRate ?? '';
      case 'estimatedCpm':  return data?.estimatedCpm   ?? '';
      case '_savedAt':      return new Date().toISOString();
      default:              return '';
    }
  });
}

// ─── Provision ───────────────────────────────────────────────────────────────

/**
 * Create a new Google Sheet for the user.
 * fields: optional TEXT[] from user_preferences — used to set the header row.
 * If fields is null/empty we fall back to a sensible default.
 */
async function provisionSheet(userEmail, fields) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Create spreadsheet
  let spreadsheetId;
  try {
    const createResp = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: 'LiveChrome — ' + userEmail },
        sheets: [{ properties: { title: 'Creators' } }],
      },
    });
    spreadsheetId = createResp.data.spreadsheetId;
    if (!spreadsheetId) throw new Error('No spreadsheetId in response');
  } catch (err) {
    console.error('Sheets create error:', JSON.stringify(err?.response?.data || err.message));
    throw new Error('Failed to create sheet: ' + JSON.stringify(err?.response?.data || err.message));
  }

  // Build header row from user fields (or default to all fields)
  const effectiveFields = (fields && fields.length > 0)
    ? fields
    : ['handle', 'followers', 'location', 'engagementRate', 'avgViews', 'avgLikes', 'avgComments', 'estimatedCpm'];

  const headers = buildHeaders(effectiveFields);
  const range = `Creators!A1:${columnLetter(headers.length)}1`;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  } catch (err) {
    console.error('Header row error:', JSON.stringify(err?.response?.data || err.message));
  }

  // Share with user
  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: { role: 'writer', type: 'user', emailAddress: userEmail },
    });
  } catch (err) {
    console.error('Drive share error:', JSON.stringify(err?.response?.data || err.message));
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return { sheetId: spreadsheetId, sheetUrl };
}

// ─── Update headers ───────────────────────────────────────────────────────────

/**
 * Rewrite the header row of an existing sheet to match new field selections.
 * Called by the onboarding route after preferences are saved.
 */
async function updateSheetHeaders(spreadsheetId, fields) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const effectiveFields = (fields && fields.length > 0)
    ? fields
    : ['handle', 'followers', 'location', 'engagementRate'];

  const headers = buildHeaders(effectiveFields);

  // Clear existing row 1 first, then write new headers
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Creators!1:1',
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Creators!A1:${columnLetter(headers.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });

    console.log(`[SHEETS] Updated headers for ${spreadsheetId}:`, headers);
  } catch (err) {
    console.error('updateSheetHeaders error:', JSON.stringify(err?.response?.data || err.message));
    throw err;
  }
}

// ─── Append row ───────────────────────────────────────────────────────────────

/**
 * Append a creator data row aligned to the user's saved field preferences.
 * fields: TEXT[] from user_preferences.fields
 */
async function appendToSheet(spreadsheetId, handle, platform, data, fields) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const effectiveFields = (fields && fields.length > 0)
    ? fields
    : ['handle', 'followers', 'location', 'engagementRate', 'avgViews', 'avgLikes', 'avgComments', 'estimatedCpm'];

  const row = buildRow(effectiveFields, handle, platform, data);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Creators!A:A',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a 1-based column index to a letter (1→A, 26→Z, 27→AA). */
function columnLetter(n) {
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

module.exports = { provisionSheet, appendToSheet, updateSheetHeaders, buildHeaders };
