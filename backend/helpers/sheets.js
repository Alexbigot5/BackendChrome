const { google } = require('googleapis');

function getAuth() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

  if (!privateKey) throw new Error('GOOGLE_PRIVATE_KEY env var is missing');
  if (!clientEmail) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL env var is missing');

  return new google.auth.JWT(
    clientEmail,
    null,
    privateKey,
    [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ]
  );
}

async function provisionSheet(userEmail) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Create spreadsheet
  const createResp = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: 'LiveChrome — ' + userEmail },
      sheets: [{ properties: { title: 'Creators' } }],
    },
  });

  const spreadsheetId = createResp.data.spreadsheetId;
  if (!spreadsheetId) throw new Error('Failed to create sheet');

  // Add header row
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Creators!A1:F1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [['Handle', 'Followers', 'Following', 'Likes', 'Videos', 'Saved At']],
    },
  });

  // Share with user
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      role: 'writer',
      type: 'user',
      emailAddress: userEmail,
    },
  });

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return { sheetId: spreadsheetId, sheetUrl };
}

async function appendToSheet(spreadsheetId, row) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Creators!A:F',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

module.exports = { provisionSheet, appendToSheet };
