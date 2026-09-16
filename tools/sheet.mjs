#!/usr/bin/env node
/**
 * Google Sheet connection tool.
 *
 *   npm run sheet:test               ping the Sheet, prove the round trip
 *   npm run sheet:test -- <url>      ping a URL without setting the env var
 *   npm run sheet:backfill           push data/registrations.csv into the Sheet
 *   npm run sheet:queue              show rows waiting for the network
 *
 * Run `sheet:test` BEFORE the event. It is the difference between finding out
 * the deployment is misconfigured now, and finding out at 3pm with a queue of
 * people waiting.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SheetMirror } from '../lib/sheetMirror.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_FILE = path.join(DATA_DIR, 'registrations.csv');
const QUEUE_FILE = path.join(DATA_DIR, 'sheet-queue.json');

const mode = (process.argv[2] || 'test').toLowerCase();
const urlArg = process.argv[3] || '';
const URL_VALUE = urlArg || process.env.FLAPPY_SHEET_URL || '';
const TOKEN = process.env.FLAPPY_SHEET_TOKEN || '';

function needUrl() {
  if (URL_VALUE) return;
  console.error(
    '\nNo Sheet URL.\n\n' +
      '  npm run sheet:test -- "https://script.google.com/.../exec"\n\n' +
      'or set it once for the shell:\n\n' +
      '  PowerShell   $env:FLAPPY_SHEET_URL="https://script.google.com/.../exec"\n' +
      '  bash         export FLAPPY_SHEET_URL=https://script.google.com/.../exec\n'
  );
  process.exit(1);
}

function mirror() {
  return new SheetMirror({ url: URL_VALUE, token: TOKEN, queueFile: QUEUE_FILE });
}

/** Common misconfigurations, named rather than left as a raw error. */
function explain(error) {
  const text = String(error || '');
  if (/not shared with "Anyone"/i.test(text)) {
    return [
      'The deployment is not public.',
      'Apps Script -> Deploy -> Manage deployments -> pencil ->',
      'Who has access: Anyone -> Deploy.'
    ];
  }
  if (/responded 404/.test(text)) {
    return [
      'That URL does not resolve.',
      'Make sure it is the Web app URL ending in /exec,',
      'not the editor link or an /dev URL.'
    ];
  }
  if (/responded 403/.test(text)) {
    return ['Access refused. Redeploy with "Who has access: Anyone".'];
  }
  if (/bad token/.test(text)) {
    return [
      'The script rejected the shared secret.',
      'SHARED_TOKEN at the top of the Apps Script must equal',
      'FLAPPY_SHEET_TOKEN in this shell.'
    ];
  }
  if (/timed out|network/.test(text)) {
    return ['No answer. Check this machine is online.'];
  }
  if (/page, not JSON/.test(text)) {
    return [
      'The script threw. Open Apps Script -> Executions to see why.',
      'A redeploy is needed after editing: Manage deployments ->',
      'pencil -> Version: New version.'
    ];
  }
  return [];
}

/* -------------------------------------------------------------------------- */

async function runTest() {
  needUrl();
  console.log('\n  Pinging ' + URL_VALUE.slice(0, 60) + (URL_VALUE.length > 60 ? '...' : ''));
  console.log('  Token   ' + (TOKEN ? 'sending one' : 'none set'));

  const sheet = mirror();
  const result = await sheet.post({ ping: true });

  if (result.ok) {
    console.log('\n  CONNECTED');
    if (result.body && result.body.rows != null) {
      console.log('  The Sheet currently holds ' + result.body.rows + ' registration(s).');
    }
    console.log('\n  Start the server with it:');
    console.log('    $env:FLAPPY_SHEET_URL="' + URL_VALUE + '"');
    if (TOKEN) console.log('    $env:FLAPPY_SHEET_TOKEN="' + TOKEN + '"');
    console.log('    node server.js\n');
    return;
  }

  console.log('\n  FAILED: ' + result.error);
  for (const line of explain(result.error)) console.log('  ' + line);
  console.log('');
  process.exit(1);
}

/** Minimal CSV reader - the writer's own escaping, in reverse. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length));
}

const unescape = (v) => (String(v).startsWith("'") ? String(v).slice(1) : String(v));

async function runBackfill() {
  needUrl();

  let raw;
  try {
    raw = await fs.readFile(CSV_FILE, 'utf8');
  } catch {
    console.log('\n  Nothing to backfill - data/registrations.csv does not exist yet.\n');
    return;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const rows = parseCsv(raw);
  if (rows.length < 2) {
    console.log('\n  data/registrations.csv has no rows yet.\n');
    return;
  }

  const header = rows[0].map((h) => unescape(h).trim());
  const col = (name) => header.indexOf(name);
  const iIso = col('submittedAt');
  const iName = col('name');
  const iId = col('bitsId');
  const iPhone = col('phone');
  const iScore = col('score');
  const iA1 = col('attempt1');
  const iSession = col('sessionId');

  const sheet = mirror();
  const entries = rows.slice(1);
  console.log('\n  Pushing ' + entries.length + ' row(s). The script skips any it already has.\n');

  let sent = 0;
  let duplicate = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const r = entries[i];
    const payload = {
      at: unescape(r[iIso] || ''),
      name: unescape(r[iName] || ''),
      bitsId: unescape(r[iId] || ''),
      phone: unescape(r[iPhone] || ''),
      score: Number(unescape(r[iScore] || '0')) || 0,
      attempts: [r[iA1], r[iA1 + 1], r[iA1 + 2]].map((v) => Number(unescape(v || '')) || 0),
      sessionId: unescape(r[iSession] || '')
    };

    const result = await sheet.post(payload);
    if (result.ok && result.body && result.body.duplicate) duplicate += 1;
    else if (result.ok) sent += 1;
    else {
      failed += 1;
      console.log('  row ' + (i + 1) + ' failed: ' + result.error);
      // A systemic failure will not fix itself over 200 more attempts.
      if (failed >= 3) {
        console.log('\n  Stopping - three failures in a row.');
        for (const line of explain(result.error)) console.log('  ' + line);
        break;
      }
    }

    // Apps Script rate-limits; a small gap keeps a long backfill alive.
    await new Promise((r2) => setTimeout(r2, 180));
  }

  console.log('\n  added ' + sent + ', already present ' + duplicate + ', failed ' + failed + '\n');
}

async function runQueue() {
  let queue = [];
  try {
    queue = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8'));
  } catch {
    console.log('\n  Nothing queued - every row has reached the Sheet.\n');
    return;
  }
  if (!Array.isArray(queue) || !queue.length) {
    console.log('\n  Nothing queued - every row has reached the Sheet.\n');
    return;
  }

  console.log('\n  ' + queue.length + ' row(s) waiting for the network:\n');
  for (const row of queue.slice(0, 20)) {
    console.log('    ' + String(row.name || '?').padEnd(16) + String(row.score).padStart(4) +
      '   ' + (row.at || ''));
  }
  if (queue.length > 20) console.log('    ... and ' + (queue.length - 20) + ' more');
  console.log('\n  They send themselves when the server is running and online.');
  console.log('  To push them now:  npm run sheet:flush\n');
}

async function runFlush() {
  needUrl();
  const sheet = mirror();
  const waiting = await sheet.start();
  sheet.stop();
  if (!waiting) {
    console.log('\n  Nothing queued.\n');
    return;
  }
  console.log('\n  Flushing ' + waiting + ' queued row(s)...');
  const left = await sheet.flush();
  console.log(left ? '\n  ' + left + ' still waiting: ' + sheet.stats.lastError + '\n'
                   : '\n  All sent.\n');
}

/* -------------------------------------------------------------------------- */

if (mode === 'test') await runTest();
else if (mode === 'backfill') await runBackfill();
else if (mode === 'queue') await runQueue();
else if (mode === 'flush') await runFlush();
else {
  console.error(
    '\nUsage:\n' +
      '  npm run sheet:test        check the connection\n' +
      '  npm run sheet:backfill    push existing CSV rows into the Sheet\n' +
      '  npm run sheet:queue       list rows waiting for the network\n' +
      '  npm run sheet:flush       send those rows now\n'
  );
  process.exit(1);
}
