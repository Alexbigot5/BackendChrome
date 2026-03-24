const { google } = require('googleapis');

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

function getAuthClient() {
  // GOOGLE_PRIVATE_KEY is stored with literal \n in env — replace them
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ]
  );
}

/**
 * Creates a new Google Sheet for the user, writes the header row, shares it
 * with the user's email, and returns { sheetId, sheetUrl }.
 */
async function provisionSheet(email) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Create the spreadsheet
  const createResponse = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: `LiveChrome — ${email}`,
      },
      sheets: [
        {
          properties: { title: 'Creators' },
        },
      ],
    },
  });

  const sheetId = createResponse.data.spreadsheetId;
  const sheetUrl = createResponse.data.spreadsheetUrl;

  // Write header row
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Creators!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [SHEET_HEADERS],
    },
  });

  // Bold + freeze header row for readability
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
                foregroundColor: { red: 1, green: 1, blue: 1 },
              },
            },
            fields: 'userEnteredFormat(textFormat,backgroundColor,foregroundColor)',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ],
    },
  });

  // Share the sheet with the user (writer access so they can view)
  await drive.permissions.create({
    fileId: sheetId,
    requestBody: {
      type: 'user',
      role: 'writer',
      emailAddress: email,
    },
    sendNotificationEmail: true,
  });

  return { sheetId, sheetUrl };
}

/**
 * Appends a row of scraped creator data to the user's sheet.
 * scrapedData should contain fields matching SHEET_HEADERS.
 */
async function appendToSheet(sheetId, handle, platform, scrapedData) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const row = [
    handle,
    scrapedData.followers ?? '',
    scrapedData.engagementRate ?? '',
    scrapedData.niche ?? '',
    scrapedData.location ?? '',
    scrapedData.bio ?? '',
    scrapedData.matchScore ?? '',
    new Date().toISOString().split('T')[0],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Creators!A1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row],
    },
  });
}

module.exports = { provisionSheet, appendToSheet };
