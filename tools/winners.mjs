#!/usr/bin/env node
/**
 * Picks the hourly prize winners out of the register.
 *
 *   npm run winners           every hour so far, best score in each
 *   npm run winners -- now    just the hour in progress
 *   npm run winners -- csv    the same table as CSV, to paste anywhere
 *
 * Reads data/registrations.csv, which server.js appends to as sessions finish.
 * Nothing here writes, so it is safe to run mid-event with the stall server up.
 *
 * Ties are broken by who got there first: with equal scores the earlier
 * submission wins, which is the same rule the leaderboard itself uses.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'registrations.csv');

/** RFC4180-ish reader: handles quoted fields, embedded commas and newlines. */
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

/** Undoes the apostrophe the writer adds to defuse Excel formula injection. */
function unescapeCell(value) {
  return value.startsWith("'") ? value.slice(1) : value;
}

async function load() {
  let raw;
  try {
    raw = await fs.readFile(FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(
        '\nNo register yet at data/registrations.csv.\n' +
          'It is created the first time somebody finishes all three attempts.\n'
      );
      process.exit(1);
    }
    throw err;
  }

  // Strip the UTF-8 BOM the writer adds for Excel.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const rows = parseCsv(raw);
  if (rows.length < 2) {
    console.log('\nThe register is empty - nobody has finished a session yet.\n');
    process.exit(0);
  }

  const header = rows[0].map((h) => unescapeCell(h).trim());
  const index = (name) => header.indexOf(name);

  const iHour = index('hourBucket');
  const iTime = index('localTime');
  const iIso = index('submittedAt');
  const iName = index('name');
  const iId = index('bitsId');
  const iPhone = index('phone');
  const iScore = index('score');

  if (iHour < 0 || iScore < 0) {
    console.error('data/registrations.csv does not have the expected columns.');
    process.exit(1);
  }

  return rows.slice(1).map((r) => ({
    hour: unescapeCell(r[iHour] || ''),
    time: unescapeCell(r[iTime] || ''),
    iso: unescapeCell(r[iIso] || ''),
    name: unescapeCell(r[iName] || ''),
    bitsId: unescapeCell(r[iId] || ''),
    phone: unescapeCell(r[iPhone] || ''),
    score: Number(unescapeCell(r[iScore] || '0')) || 0
  }));
}

/** Best score per hour; earliest submission wins a tie. */
function winnersByHour(entries) {
  const byHour = new Map();
  for (const entry of entries) {
    if (!entry.hour) continue;
    const current = byHour.get(entry.hour);
    if (!current) { byHour.set(entry.hour, { winner: entry, played: 1 }); continue; }
    current.played += 1;
    const better =
      entry.score > current.winner.score ||
      (entry.score === current.winner.score && entry.iso < current.winner.iso);
    if (better) current.winner = entry;
  }
  return [...byHour.entries()]
    .map(([hour, v]) => ({ hour, ...v }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function currentHourKey() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) + ':00'
  );
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function printTable(rows) {
  console.log('');
  console.log(
    '  ' + pad('HOUR', 18) + pad('WINNER', 16) + pad('BITS ID', 14) +
    pad('WHATSAPP', 17) + pad('SCORE', 7) + 'PLAYERS'
  );
  console.log('  ' + '-'.repeat(78));
  for (const row of rows) {
    console.log(
      '  ' + pad(row.hour, 18) + pad(row.winner.name, 16) + pad(row.winner.bitsId || '-', 14) +
      pad(row.winner.phone || '-', 17) + pad(row.winner.score, 7) + row.played
    );
  }
  console.log('');
}

/* -------------------------------------------------------------------------- */

const mode = (process.argv[2] || 'all').toLowerCase();
const entries = await load();
const all = winnersByHour(entries);

if (mode === 'csv') {
  console.log('hour,winner,bitsId,whatsapp,score,playersThatHour');
  for (const row of all) {
    const cells = [row.hour, row.winner.name, row.winner.bitsId, row.winner.phone, row.winner.score, row.played];
    console.log(cells.map((c) => (/[",]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(','));
  }
} else if (mode === 'now') {
  const key = currentHourKey();
  const row = all.find((r) => r.hour === key);
  if (!row) {
    console.log('\n  Nobody has finished a session this hour (' + key + ') yet.\n');
  } else {
    console.log('\n  THIS HOUR  ' + row.hour);
    console.log('  ' + '-'.repeat(46));
    console.log('  Winner    ' + row.winner.name);
    console.log('  BITS ID   ' + (row.winner.bitsId || '-'));
    console.log('  WhatsApp  ' + (row.winner.phone || '-'));
    console.log('  Score     ' + row.winner.score);
    console.log('  Played    ' + row.played + ' this hour');
    console.log('  At        ' + row.winner.time + '\n');
  }
} else {
  printTable(all);
  console.log('  ' + entries.length + ' sessions registered across ' + all.length + ' hour(s)');
  console.log('  npm run winners -- now    just the hour in progress');
  console.log('  npm run winners -- csv    the same table as CSV\n');
}
