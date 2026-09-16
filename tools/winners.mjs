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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* Shared with the hourly export, so the number announced at the stall and the
   number in the exported file are computed by the same code. */
import { readRegister, winnersByHour, hourKey } from '../lib/registerRead.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'registrations.csv');

function currentHourKey() {
  return hourKey(new Date());
}

/** Reads the register, or explains why it cannot and stops. */
async function load() {
  const result = await readRegister(FILE);
  if (!result.ok) {
    console.error('\n  Could not read the register: ' + result.reason + '\n');
    process.exit(1);
  }
  if (!result.entries.length) {
    console.log('\n  ' + result.reason + ' - nobody has finished a session yet.\n');
    process.exit(0);
  }
  return result.entries;
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
  let unreachable = 0;
  for (const row of rows) {
    if (!row.winner.hasContact) unreachable += 1;
    console.log(
      '  ' + pad(row.hour, 18) + pad(row.winner.name, 16) + pad(row.winner.bitsId || '-', 14) +
      pad(row.winner.phone || '-', 17) + pad(row.winner.score, 7) + row.played +
      (row.winner.hasContact ? '' : '   <-- NO CONTACT')
    );
  }
  console.log('');
  if (unreachable) {
    console.log('  ' + unreachable + ' winner(s) left no contact details and cannot be reached.');
    console.log('  Announce the next-highest scorer for those hours instead.');
    console.log('');
  }
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
    console.log('  At        ' + row.winner.time);
    if (!row.winner.hasContact) {
      console.log('');
      console.log('  WARNING: this player left no contact details.');
      const others = entries
        .filter((e) => e.hour === row.hour && e.sessionId !== row.winner.sessionId && e.hasContact)
        .sort((a, b) => b.score - a.score || a.iso.localeCompare(b.iso));
      if (others.length) {
        console.log('  Next reachable: ' + others[0].name + '  ' + others[0].phone +
          '  (score ' + others[0].score + ')');
      } else {
        console.log('  Nobody else this hour left contact details either.');
      }
    }
    console.log('');
  }
} else {
  printTable(all);
  console.log('  ' + entries.length + ' sessions registered across ' + all.length + ' hour(s)');
  console.log('  npm run winners -- now    just the hour in progress');
  console.log('  npm run winners -- csv    the same table as CSV\n');
}
