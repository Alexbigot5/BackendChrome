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

async function provisionSheet(userEmail) {
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

  // Add header row
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Creators!A1:F1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [['Handle', 'Followers', 'Following', 'Likes', 'Videos', 'Saved At']],
      },
    });
  } catch (err) {
    console.error('Header row error:', JSON.stringify(err?.response?.data || err.message));
  }

  // Share with user
  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: {
        role: 'writer',
        type: 'user',
        emailAddress: userEmail,
      },
    });
  } catch (err) {
    console.error('Drive share error:', JSON.stringify(err?.response?.data || err.message));
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return { sheetId: spreadsheetId, sheetUrl };
}

async function appendToSheet(spreadsheetId, handle, platform, data) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const row = [
    handle,
    data?.followers ?? '',
    data?.following ?? '',
    data?.likes ?? '',
    data?.videos ?? '',
    new Date().toISOString(),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Creators!A:F',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

module.exports = { provisionSheet, appendToSheet };
