/**
 * Flappy Fest -> Google Sheets.
 *
 * This file does NOT run as part of the game. Paste it into Google Apps Script
 * attached to a Sheet and deploy it as a web app; the stall server then POSTs
 * each finished session to that URL.
 *
 * It keeps two tabs:
 *
 *   Registrations   one row per finished session, appended as they happen
 *   Winners         the highest score in each hour, rebuilt on every write
 *
 * The Winners tab is the point: you read the hourly winner straight off the
 * Sheet without touching the laptop.
 *
 * ===========================================================================
 * SETUP  (about five minutes, once)
 *
 *  1. Create a Google Sheet. Any name. Leave the tabs alone - this creates
 *     what it needs.
 *
 *  2. Extensions -> Apps Script. Delete the sample code, paste ALL of this,
 *     and press Save.
 *
 *  3. OPTIONAL but recommended: set a shared secret so a stranger who finds
 *     the URL cannot push junk rows. Replace the empty string below, and use
 *     the same value as FLAPPY_SHEET_TOKEN when you start the server.
 *
 *  4. Deploy -> New deployment -> gear icon -> Web app.
 *       Description:     anything
 *       Execute as:      Me
 *       Who has access:  Anyone          <-- REQUIRED
 *     "Anyone" is needed because the stall laptop is not signed in to your
 *     Google account. It does not make the Sheet public - only this script.
 *
 *  5. Authorise when prompted. Google will warn that the app is unverified:
 *     Advanced -> Go to <project> (unsafe). It is your own script.
 *
 *  6. Copy the Web app URL. It ends in /exec.
 *
 *  7. Test it from the project folder before the event:
 *
 *       npm run sheet:test -- "https://script.google.com/.../exec"
 *
 *  8. Start the stall server with it:
 *
 *       PowerShell
 *         $env:FLAPPY_SHEET_URL="https://script.google.com/.../exec"
 *         $env:FLAPPY_SHEET_TOKEN="your-secret"
 *         node server.js
 *
 * IF YOU EVER EDIT THIS SCRIPT: Deploy -> Manage deployments -> pencil ->
 * Version: New version -> Deploy. Saving alone does not update the live URL.
 * ===========================================================================
 */

/** Must match FLAPPY_SHEET_TOKEN on the server. Empty = no check. */
var SHARED_TOKEN = '';

var DATA_SHEET = 'Registrations';
var WINNERS_SHEET = 'Winners';

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

var WINNER_HEADERS = ['Hour', 'Winner', 'BITS ID', 'WhatsApp', 'Score', 'Players that hour'];

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

function doPost(e) {
  /* One writer at a time. Two players finishing together would otherwise both
     read the same last row and one would overwrite the other. */
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'empty request' });
    }

    var body = JSON.parse(e.postData.contents);

    if (SHARED_TOKEN && body.token !== SHARED_TOKEN) {
      return json_({ ok: false, error: 'bad token' });
    }

    // A ping from `npm run sheet:test` - proves the round trip without a row.
    if (body.ping) {
      return json_({ ok: true, ping: true, rows: countRows_(getDataSheet_()) });
    }

    var sheet = getDataSheet_();

    /* Idempotent on session id. The server retries a failed POST, and a retry
       that actually went through the first time must not double the row. */
    if (body.sessionId && hasSession_(sheet, body.sessionId)) {
      return json_({ ok: true, duplicate: true, rows: countRows_(sheet) });
    }

    var when = body.at ? new Date(body.at) : new Date();
    var attempts = body.attempts || [];

    sheet.appendRow([
      when.toISOString(),
      formatLocal_(when),
      formatHour_(when),
      body.name || '',
      body.bitsId || '',
      /* Leading apostrophe: without it Sheets reads +971... as a formula and
         silently drops the plus. It is not shown in the cell. */
      body.phone ? "'" + body.phone : '',
      body.score == null ? '' : Number(body.score),
      attempts[0] == null ? '' : Number(attempts[0]),
      attempts[1] == null ? '' : Number(attempts[1]),
      attempts[2] == null ? '' : Number(attempts[2]),
      body.sessionId || ''
    ]);

    rebuildWinners_();

    return json_({ ok: true, rows: countRows_(sheet) });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** Opening the /exec URL in a browser should show this. */
function doGet() {
  var sheet = getDataSheet_();
  return json_({
    ok: true,
    service: 'flappy-fest',
    rows: countRows_(sheet),
    tokenRequired: Boolean(SHARED_TOKEN)
  });
}

/* -------------------------------------------------------------------------- */
/* Winners                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds the Winners tab: the top score in each hour.
 *
 * Ties go to whoever submitted first, which is the same rule the game's own
 * leaderboard uses - so the Sheet and the screen never disagree.
 */
function rebuildWinners_() {
  var data = getDataSheet_();
  var last = data.getLastRow();
  var out = getWinnersSheet_();

  if (last < 2) {
    if (out.getLastRow() > 1) out.getRange(2, 1, out.getLastRow() - 1, WINNER_HEADERS.length).clearContent();
    return;
  }

  var rows = data.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var byHour = {};
  var order = [];

  for (var i = 0; i < rows.length; i++) {
    var hour = String(rows[i][2]);
    if (!hour) continue;

    var entry = {
      iso: String(rows[i][0]),
      name: rows[i][3],
      bitsId: rows[i][4],
      phone: String(rows[i][5]).replace(/^'/, ''),
      score: Number(rows[i][6]) || 0
    };

    if (!byHour[hour]) {
      byHour[hour] = { winner: entry, played: 1 };
      order.push(hour);
      continue;
    }

    byHour[hour].played++;
    var best = byHour[hour].winner;
    if (entry.score > best.score || (entry.score === best.score && entry.iso < best.iso)) {
      byHour[hour].winner = entry;
    }
  }

  order.sort();

  var table = [];
  for (var j = 0; j < order.length; j++) {
    var h = order[j];
    var w = byHour[h].winner;
    table.push([h, w.name, w.bitsId, "'" + w.phone, w.score, byHour[h].played]);
  }

  // Clear the old block before writing, or a shorter table leaves stale rows.
  if (out.getLastRow() > 1) {
    out.getRange(2, 1, out.getLastRow() - 1, WINNER_HEADERS.length).clearContent();
  }
  if (table.length) {
    out.getRange(2, 1, table.length, WINNER_HEADERS.length).setValues(table);
  }
}

/** Menu item / manual trigger, in case you want to force a refresh. */
function refreshWinners() {
  rebuildWinners_();
  SpreadsheetApp.getActiveSpreadsheet().toast('Winners refreshed');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Flappy Fest')
    .addItem('Refresh winners', 'refreshWinners')
    .addToUi();
}

/* -------------------------------------------------------------------------- */
/* Sheet helpers                                                              */
/* -------------------------------------------------------------------------- */

function getDataSheet_() {
  return ensureSheet_(DATA_SHEET, HEADERS);
}

function getWinnersSheet_() {
  return ensureSheet_(WINNERS_SHEET, WINNER_HEADERS);
}

function ensureSheet_(name, headers) {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(name);
  if (!sheet) sheet = book.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.autoResizeColumns(1, headers.length);
  }
  return sheet;
}

function countRows_(sheet) {
  return Math.max(0, sheet.getLastRow() - 1);
}

/** Session ids live in the last column; scanning it is enough at stall scale. */
function hasSession_(sheet, sessionId) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var column = sheet.getRange(2, HEADERS.length, last - 1, 1).getValues();
  for (var i = 0; i < column.length; i++) {
    if (String(column[i][0]) === String(sessionId)) return true;
  }
  return false;
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
