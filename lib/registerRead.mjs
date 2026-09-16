/**
 * Reading the prize-draw register, and working out who won each hour.
 *
 * Shared by `npm run winners` and the hourly export, so the number announced
 * at the stall and the number in the exported file are computed by the same
 * code. Two implementations of "who won" would eventually disagree, and the
 * disagreement would surface while somebody was holding a microphone.
 */

import fs from 'node:fs/promises';

/** RFC4180-ish: quoted fields, embedded commas, embedded newlines. */
export function parseCsv(text) {
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

/** Undoes the apostrophe the writer adds to defuse spreadsheet formulas. */
export function unescapeCell(value) {
  const text = String(value == null ? '' : value);
  return text.startsWith("'") ? text.slice(1) : text;
}

/**
 * Reads the register into plain objects.
 *
 * Returns { ok, entries, reason }. A missing or empty file is not an error -
 * it is simply an event nobody has finished a session at yet.
 */
export async function readRegister(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, entries: [], reason: 'no register yet' };
    return { ok: false, entries: [], reason: err.message };
  }

  // Strip the UTF-8 BOM the writer adds for Excel.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const rows = parseCsv(raw);
  if (rows.length < 2) return { ok: true, entries: [], reason: 'register is empty' };

  const header = rows[0].map((h) => unescapeCell(h).trim());
  const at = (name) => header.indexOf(name);

  const iHour = at('hourBucket');
  const iScore = at('score');
  if (iHour < 0 || iScore < 0) {
    return { ok: false, entries: [], reason: 'unexpected columns in the register' };
  }

  const iIso = at('submittedAt');
  const iTime = at('localTime');
  const iName = at('name');
  const iId = at('bitsId');
  const iPhone = at('phone');
  const iA1 = at('attempt1');
  const iA2 = at('attempt2');
  const iA3 = at('attempt3');
  const iSession = at('sessionId');

  const pick = (row, index) => (index < 0 ? '' : unescapeCell(row[index] || ''));

  const entries = rows.slice(1).map((row) => ({
    iso: pick(row, iIso),
    time: pick(row, iTime),
    hour: pick(row, iHour),
    name: pick(row, iName),
    bitsId: pick(row, iId),
    phone: pick(row, iPhone),
    score: Number(pick(row, iScore)) || 0,
    attempts: [pick(row, iA1), pick(row, iA2), pick(row, iA3)],
    sessionId: pick(row, iSession)
  }));

  return { ok: true, entries, reason: '' };
}

/**
 * Highest score in each hour.
 *
 * Ties go to whoever submitted first - the same rule the leaderboard uses, so
 * the board on the screen and the winner in the file never disagree.
 */
export function winnersByHour(entries) {
  const byHour = new Map();

  for (const entry of entries) {
    if (!entry.hour) continue;

    const current = byHour.get(entry.hour);
    if (!current) {
      byHour.set(entry.hour, { winner: entry, played: 1 });
      continue;
    }

    current.played += 1;
    const better =
      entry.score > current.winner.score ||
      (entry.score === current.winner.score && entry.iso < current.winner.iso);
    if (better) current.winner = entry;
  }

  return [...byHour.entries()]
    .map(([hour, value]) => ({ hour, winner: value.winner, played: value.played }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

const pad = (n) => String(n).padStart(2, '0');

/** "2026-09-16 15:00" for a Date - the same shape the register stores. */
export function hourKey(date) {
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':00'
  );
}

/** "2026-09-16_15-00" - safe for a filename. */
export function hourSlug(date) {
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    '_' + pad(date.getHours()) + '-00'
  );
}
