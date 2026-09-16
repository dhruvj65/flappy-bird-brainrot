/**
 * The prize-draw register.
 *
 * Every finished session appends one row here: who played, how to reach them,
 * what they scored and when. It is what the hourly winner is drawn from.
 *
 * SEPARATE FROM THE LEADERBOARD, ON PURPOSE
 *
 * data/leaderboard.json holds names and scores and is served to the public
 * board. Contact details are written here instead and are never loaded into
 * the leaderboard store, so no API response can leak a phone number by
 * accident - the data is simply not in that object.
 *
 * WHY CSV
 *
 * Excel opens it natively, it needs no dependency, and an append is a single
 * syscall that cannot corrupt earlier rows the way a rewritten .xlsx could if
 * the laptop died mid-write at the stall.
 *
 * Server-side only: unlike lib/board.mjs this touches the filesystem.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const COLUMNS = [
  'submittedAt',
  'localTime',
  'hourBucket',
  'name',
  'bitsId',
  'phone',
  'score',
  'attempt1',
  'attempt2',
  'attempt3',
  'sessionId'
];

/**
 * Quotes a value for CSV, and defuses spreadsheet formula injection.
 *
 * A name like `=cmd|'/c calc'!A1` is a live formula when Excel opens the file,
 * and the names here are typed by strangers at a stall. Prefixing a leading
 * =, +, - or @ with an apostrophe makes Excel treat the cell as text; the
 * apostrophe is not shown in the cell and is not part of the stored value.
 */
function csvCell(value) {
  let text = value == null ? '' : String(value);

  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;

  if (/[",\n\r]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function csvRow(values) {
  return values.map(csvCell).join(',') + '\r\n';
}

/** "2026-09-16 14:00" - the hour a row belongs to, for picking winners. */
function hourBucket(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) +
    ':00'
  );
}

function localTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) +
    ':' + pad(date.getMinutes()) +
    ':' + pad(date.getSeconds())
  );
}

export class RegistrationLog {
  constructor(file) {
    this.file = file;
    // Appends are serialised so two submissions landing together cannot
    // interleave halfway through a line.
    this.chain = Promise.resolve();
    this.ready = false;
  }

  async init() {
    await this.ensureHeader();
    this.ready = true;
    return this.count();
  }

  /**
   * Guarantees the file exists and starts with the header row.
   *
   * Called before every append, not just at startup, because the file can go
   * away or be replaced underneath a running server - this project lives in a
   * OneDrive folder, and somebody clearing up mid-event is entirely plausible.
   * An append to a vanished file silently recreates it with no header, and a
   * headerless register reads as EMPTY: `npm run winners` would announce that
   * nobody had played while real rows sat in the file.
   *
   * Existing rows are preserved - the header is prepended, never overwritten.
   */
  async ensureHeader() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });

    const header = csvRow(COLUMNS);
    let existing = null;
    try {
      existing = await fs.readFile(this.file, 'utf8');
    } catch {
      /* A UTF-8 BOM, because Excel otherwise reads the file as the system
         codepage and mangles any non-ASCII name. */
      await fs.writeFile(this.file, '﻿' + header, 'utf8');
      return 'created';
    }

    const body = existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing;
    if (body.startsWith(header.trimEnd())) return 'ok';

    // Rows but no header: put one back without losing anything.
    await fs.writeFile(this.file, '﻿' + header + body, 'utf8');
    console.warn('[registrations] header was missing - restored it, ' + 
      'existing rows kept');
    return 'repaired';
  }

  /** Rows currently on file, not counting the header. */
  async count() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length);
      return Math.max(0, lines.length - 1);
    } catch {
      return 0;
    }
  }

  /**
   * Appends one finished session.
   *
   * Never throws into the request path: a register that cannot be written must
   * not stop somebody's score reaching the leaderboard. Failures are logged
   * and the submission proceeds.
   */
  append({ name, bitsId, phone, score, attempts, sessionId, at }) {
    const when = at instanceof Date ? at : new Date();
    const list = Array.isArray(attempts) ? attempts : [];

    const row = csvRow([
      when.toISOString(),
      localTime(when),
      hourBucket(when),
      name,
      bitsId,
      // Leading + is a formula character to Excel, so csvCell escapes it and
      // the number stays readable as text rather than becoming a subtraction.
      phone,
      score,
      list[0] == null ? '' : list[0],
      list[1] == null ? '' : list[1],
      list[2] == null ? '' : list[2],
      sessionId
    ]);

    this.chain = this.chain
      // Heal first: an append to a file that lost its header would make every
      // row after it invisible to the winners tool.
      .then(() => this.ensureHeader())
      .then(() => fs.appendFile(this.file, row, 'utf8'))
      .catch((err) => {
        console.error('[registrations] append failed', err.message);
      });

    return this.chain;
  }
}
