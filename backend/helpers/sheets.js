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
 * Robustly extracts and rebuilds a PEM private key from an env var,
 * regardless of how it was stored (escaped \n, JSON quotes, CRLF, etc.)
 */
function extractPem(raw) {
  let s = raw;

  // Step 1: Remove outer JSON/shell quotes if present
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }

  // Step 2: Convert all forms of escaped newlines to actual newlines
  // Handle \n (literal backslash-n from Railway env vars)
  s = s.replace(/\\n/g, '\n').replace(/\\r/g, '').trim();

  // Step 3: Find the PEM header type
  const headerMatch = s.match(/-----BEGIN ([A-Z ]+)-----/);
  if (!headerMatch) {
    throw new Error('No PEM header found. Key preview: ' + s.slice(0, 60).replace(/[\n\r]/g, '|'));
  }
  const keyType = headerMatch[1].trim();

  // Step 4: Extract raw base64 (strip everything except base64 chars)
  const base64 = s
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');

  if (base64.length < 100) {
    throw new Error('Base64 content too short (' + base64.length + ' chars). Key may be truncated.');
  }

  // Step 5: Rebuild clean PEM with 64-char lines
  const lines = (base64.match(/.{1,64}/g) || []).join('\n');
  return '-----BEGIN ' + keyType + '-----\n' + lines + '\n-----END ' + keyType + '-----\n';
}

async function getAccessToken() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || '';
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!raw) throw new Error('GOOGLE_PRIVATE_KEY env var is missing');
  if (!serviceAccountEmail) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL env var is missing');

  const keyPem = extractPem(raw);

  let privateKey;
  try {
    privateKey = forge.pki.privateKeyFromPem(keyPem);
  } catch (err) {
    throw new Error('forge.pki.privateKeyFromPem failed: ' + err.message);
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
  const md = forge.md.sha256.create();
  md.update(toSign, 'utf8');
  const signatureB64 = Buffer.from(privateKey.sign(md), 'binary').toString('base64url');
  const jwt = toSign + '.' + signatureB64;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function provisionSheet(email) {
  const token = await getAccessToken();
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

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

  await fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/Creators!A1:H1?valueInputOption=RAW',
    { method: 'PUT', headers: auth, body: JSON.stringify({ values: [SHEET_HEADERS] }) }
  );
  await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + id + ':batchUpdate', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      requests: [{ repeatCell: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      }}],
    }),
  });
  await fetch('https://www.googleapis.com/drive/v3/files/' + id + '/permissions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
  });

  return { sheetId: id, sheetUrl: 'https://docs.google.com/spreadsheets/d/' + id + '/edit' };
}

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
