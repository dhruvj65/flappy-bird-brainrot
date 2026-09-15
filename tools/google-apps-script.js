/**
 * OPTIONAL - mirror the prize-draw register into a Google Sheet.
 *
 * This file does not run as part of the game. It is meant to be pasted into
 * Google Apps Script, attached to a Sheet, and deployed as a web app. The
 * stall server then POSTs each finished session to that URL.
 *
 * WHY THIS AND NOT THE SHEETS API
 *
 * No service account, no OAuth library, no JSON key to keep safe, no npm
 * dependency, and nothing to rotate. One URL in one environment variable.
 *
 * THE CSV REMAINS THE RECORD. The sheet is a convenience copy so other people
 * can watch the entries come in. If the laptop is offline, or the deployment
 * expires, or Google is slow, the game does not notice and data/registrations.csv
 * still has every row.
 *
 * ---------------------------------------------------------------------------
 * SETUP
 *
 *  1. Create a Google Sheet. Name the first tab: Registrations
 *  2. Extensions -> Apps Script. Delete whatever is there, paste ALL of this.
 *  3. Save, then Deploy -> New deployment -> type "Web app".
 *       Execute as:        Me
 *       Who has access:    Anyone
 *     "Anyone" is required - the stall laptop is not signed in to your Google
 *     account. The URL is the only secret, so do not publish it.
 *  4. Copy the /exec URL it gives you.
 *  5. Start the stall server with it set:
 *
 *       PowerShell:  $env:FLAPPY_SHEET_URL="https://script.google.com/.../exec"
 *                    node server.js
 *
 *       bash:        FLAPPY_SHEET_URL="https://script.google.com/.../exec" node server.js
 *
 *  6. The boot banner prints "sheet mirror: on" when it is configured.
 * ---------------------------------------------------------------------------
 */

var SHEET_NAME = 'Registrations';

var HEADERS = [
  'Submitted (UTC)',
  'Local time',
  'Hour',
  'Name',
  'BITS ID',
  'WhatsApp',
  'Score',
  'Attempt 1',
  'Attempt 2',
  'Attempt 3',
  'Session ID'
];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var sheet = getSheet_();
    var when = body.at ? new Date(body.at) : new Date();
    var attempts = body.attempts || [];

    sheet.appendRow([
      when.toISOString(),
      formatLocal_(when),
      formatHour_(when),
      body.name || '',
      body.bitsId || '',
      // Leading apostrophe keeps Sheets from reading +971... as a formula and
      // silently dropping the plus. It is not shown in the cell.
      body.phone ? "'" + body.phone : '',
      body.score == null ? '' : body.score,
      attempts[0] == null ? '' : attempts[0],
      attempts[1] == null ? '' : attempts[1],
      attempts[2] == null ? '' : attempts[2],
      body.sessionId || ''
    ]);

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Lets you open the /exec URL in a browser to check it is alive. */
function doGet() {
  var sheet = getSheet_();
  return json_({ ok: true, rows: Math.max(0, sheet.getLastRow() - 1) });
}

function getSheet_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = book.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function pad_(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatLocal_(d) {
  return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()) +
    ' ' + pad_(d.getHours()) + ':' + pad_(d.getMinutes()) + ':' + pad_(d.getSeconds());
}

function formatHour_(d) {
  return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()) +
    ' ' + pad_(d.getHours()) + ':00';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Optional: put this in a cell to see the current hour's leader live.
 *
 *   =HOURLY_WINNER()
 *
 * Recalculates when the sheet changes.
 */
function HOURLY_WINNER() {
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return 'no entries yet';

  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var now = new Date();
  var hour = formatHour_(now);

  var best = null;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][2]) !== hour) continue;
    var score = Number(values[i][6]) || 0;
    if (!best || score > best.score) best = { name: values[i][3], score: score, phone: values[i][5] };
  }
  return best ? best.name + '  -  ' + best.score : 'nobody has finished this hour yet';
}
