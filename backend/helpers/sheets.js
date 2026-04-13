const forge = require('node-forge');

function extractPem(raw) {
  let s = raw;
  // Step 1: Remove outer JSON/shell quotes if present
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  // Step 2: Convert all forms of escaped newlines to actual newlines
  s = s.replace(/\\n/g, '\n').replace(/\\r/g, '').trim();

  // Step 3: Check if there is a PEM header
  const headerMatch = s.match(/-----BEGIN ([A-Z ]+)-----/);

  let base64;
  let keyType;

  if (!headerMatch) {
    // No PEM header found â value is raw base64 (common when copying from GCP JSON).
    // Strip any whitespace and wrap as PKCS#8 PRIVATE KEY.
    const stripped = s.replace(/[^A-Za-z0-9+/=]/g, '');
    if (stripped.length < 100) {
      throw new Error('Key too short (' + stripped.length + ' chars). Preview: ' + s.slice(0, 80));
    }
    base64 = stripped;
    keyType = 'PRIVATE KEY';
  } else {
    keyType = headerMatch[1].trim();
    base64 = s
      .replace(/-----BEGIN [A-Z ]+-----/g, '')
      .replace(/-----END [A-Z ]+-----/g, '')
      .replace(/[^A-Za-z0-9+/=]/g, '');
  }

  if (base64.length < 100) {
    throw new Error('Base64 content too short (' + base64.length + ' chars). Key may be truncated.');
  }

  // Rebuild clean PEM with exactly 64-char lines
  const lines = (base64.match(/.{1,64}/g) || []).join('\n');
  return { pem: '-----BEGIN ' + keyType + '-----\n' + lines + '\n-----END ' + keyType + '-----\n', keyType, base64 };
}

function loadPrivateKey(raw) {
  const { pem, keyType, base64 } = extractPem(raw);

  if (keyType === 'RSA PRIVATE KEY') {
    // PKCS#1 â forge handles directly
    return forge.pki.privateKeyFromPem(pem);
  }

  // PKCS#8 â forge.pki.privateKeyFromPem sometimes chokes on it with
  // "Unparsed DER bytes remain after ASN.1 sequence". Manually unwrap instead.
  try {
    const der = forge.util.decode64(base64);
    const asn1 = forge.asn1.fromDer(der, { strict: false });
    // PKCS#8 PrivateKeyInfo: SEQUENCE { version INTEGER, AlgorithmIdentifier SEQUENCE, privateKey OCTET STRING }
    const privateKeyOctet = asn1.value[2];
    if (!privateKeyOctet || privateKeyOctet.type !== forge.asn1.Type.OCTETSTRING) {
      throw new Error('Expected OCTET STRING at index 2 of PKCS#8 structure, got: ' + (privateKeyOctet && privateKeyOctet.type));
    }
    const rsaKeyAsn1 = forge.asn1.fromDer(privateKeyOctet.value, { strict: false });
    return forge.pki.privateKeyFromAsn1(rsaKeyAsn1);
  } catch (e) {
    // Last resort: try parsing the PEM directly
    try {
      return forge.pki.privateKeyFromPem(pem);
    } catch (e2) {
      throw new Error('loadPrivateKey failed. PKCS#8 unwrap: ' + e.message + ' | direct PEM: ' + e2.message);
    }
  }
}

async function getAccessToken() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || '';
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!raw) throw new Error('GOOGLE_PRIVATE_KEY env var is missing');
  if (!serviceAccountEmail) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL env var is missing');

  const privateKey = loadPrivateKey(raw);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
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

async function provisionSheet(userEmail) {
  const token = await getAccessToken();

  // Create spreadsheet
  const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: { title: 'LiveChrome \u2014 ' + userEmail },
      sheets: [{ properties: { title: 'Creators' } }],
    }),
  });
  const sheet = await createResp.json();
  if (!sheet.spreadsheetId) throw new Error('Failed to create sheet: ' + JSON.stringify(sheet));
  const spreadsheetId = sheet.spreadsheetId;

  // Add header row
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Creators!A1:F1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: [['Handle', 'Followers', 'Following', 'Likes', 'Videos', 'Saved At']],
      }),
    }
  );

  // Share with user
  await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: userEmail }),
  });

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

async function appendToSheet(spreadsheetId, row) {
  const token = await getAccessToken();
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Creators!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    }
  );
}

module.exports = { provisionSheet, appendToSheet };
