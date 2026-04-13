const forge = require('node-forge');

const SHEET_HEADERS = [
  'Handle',
  'Followers',
  'Engagement Rate',
  'Niche',
  'Location',
  'Bio',
  'Match Score',
  'Date Saved',
];

/**
 * Creates a short-lived Google OAuth2 access token using a service account JWT.
 * Uses node-forge (pure JS) for RSA signing — avoids OpenSSL 3 compatibility issues.
 */
async function getAccessToken() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || '';
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!raw) throw new Error('GOOGLE_PRIVATE_KEY env var is missing');
  if (!serviceAccountEmail) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL env var is missing');

  // Normalize escaped newlines that may come from Railway env vars
  const keyPem = raw.replace(/\\n/g, '\n').trim();

  // Parse private key using node-forge (pure JavaScript, no OpenSSL dependency)
  let privateKey;
  try {
    privateKey = forge.pki.privateKeyFromPem(keyPem);
  } catch (err) {
    throw new Error('node-forge failed to parse private key: ' + err.message);
  }

  const now = Math.floor(Date.now() / 1000);
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const toSign = headerB64 + '.' + payloadB64;

  // Sign using node-forge RSA-SHA256
  const md = forge.md.sha256.create();
  md.update(toSign, 'utf8');
  const signatureBytes = privateKey.sign(md);
  const signatureB64 = Buffer.from(signatureBytes, 'binary').toString('base64url');
  const jwt = toSign + '.' + signatureB64;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error('Failed to get access token: ' + JSON.stringify(data));
  }
  return data.access_token;
}

/**
 * Creates a new Google Sheet for the user, writes the header row, shares it
 * with the user's email, and returns { sheetId, sheetUrl }.
 */
async function provisionSheet(email) {
  const token = await getAccessToken();
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  // 1. Create spreadsheet
  const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      properties: { title: 'LiveChrome Creators \u2014 ' + email },
      sheets: [{ properties: { title: 'Creators' } }],
    }),
  });
  const sheet = await createResp.json();
  if (!sheet.spreadsheetId) throw new Error('Create sheet failed: ' + JSON.stringify(sheet));
  const id = sheet.spreadsheetId;

  // 2. Write header row
  await fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/Creators!A1:H1?valueInputOption=RAW',
    { method: 'PUT', headers: auth, body: JSON.stringify({ values: [SHEET_HEADERS] }) }
  );

  // 3. Bold the header row
  await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + id + ':batchUpdate', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      }],
    }),
  });

  // 4. Share with user (writer access)
  await fetch('https://www.googleapis.com/drive/v3/files/' + id + '/permissions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
  });

  return {
    sheetId: id,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
  };
}

/**
 * Appends a row of creator data to an existing sheet.
 */
async function appendToSheet(sheetId, rowData) {
  const token = await getAccessToken();
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const values = SHEET_HEADERS.map((h) => rowData[h] || '');
  await fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/Creators!A:H:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    { method: 'POST', headers: auth, body: JSON.stringify({ values: [values] }) }
  );
}

module.exports = { provisionSheet, appendToSheet };
