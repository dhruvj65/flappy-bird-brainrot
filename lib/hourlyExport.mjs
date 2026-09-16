/**
 * Writes the prize-draw spreadsheets into a folder you actually open.
 *
 * On the hour, every hour, three files are rewritten:
 *
 *   registrations.csv          every session, all hours
 *   hourly-winners.csv         one row per hour: who won it and how many played
 *   hour-<date>_<hh>-00.csv    just the hour that has now finished
 *
 * The per-hour file is the one to open when announcing: it contains only the
 * people who played in that hour, with the winner marked, so there is nothing
 * to scroll past or filter while a crowd waits.
 *
 * WHY REWRITE RATHER THAN APPEND
 *
 * These are derived files. data/registrations.csv is the record; everything
 * here is regenerated from it each time, so a half-written export, a file left
 * open in Excel, or a crash between two hours cannot corrupt anything. The
 * worst case is an export that is an hour stale, and the next one repairs it.
 *
 * Writes go to a temp file and then rename, so a reader never sees a partial
 * file - which matters when the folder is in OneDrive and being synced.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { readRegister, winnersByHour, hourKey, hourSlug } from './registerRead.mjs';

const HOUR_MS = 60 * 60 * 1000;

/** Same escaping rules as the register writer - see lib/registrations.mjs. */
function cell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\n\r]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function csv(rows) {
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const RENAME_ATTEMPTS = 5;

/**
 * tmp + rename, so a reader never catches a half-written file.
 *
 * On Windows the rename fails with EBUSY or EPERM whenever the target is
 * locked, and at this stall the target is routinely locked: the file is open
 * in Excel, or OneDrive is mid-sync, or an antivirus scanner has it for a
 * moment. Sync and scanner locks clear in milliseconds, so those are simply
 * retried. Excel holds its lock for as long as the file is open, so after the
 * retries this falls back to overwriting in place - less atomic, but an
 * export that refuses to update all afternoon because somebody left a
 * spreadsheet open is worse.
 *
 * Returns a note when something unusual happened, or '' when it was clean.
 */
async function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');

  let lastError = null;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(tmp, file);
      return '';
    } catch (err) {
      lastError = err;
      if (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'EACCES') break;
      await new Promise((r) => setTimeout(r, 60 * attempt));
    }
  }

  // Still locked. Overwrite in place instead, and tidy the temp file either way.
  try {
    await fs.writeFile(file, text, 'utf8');
    await fs.rm(tmp, { force: true });
    return path.basename(file) + ' was locked (open in Excel?) - written in place';
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw new Error(
      path.basename(file) + ' could not be written: ' + (err.code || err.message) +
      '. It is probably open in Excel - close it and the next export will fix itself.'
    );
  }
}

/** Clears temp files a previous crashed or killed run left behind. */
async function sweepTempFiles(dir) {
  try {
    const names = await fs.readdir(dir);
    await Promise.all(
      names.filter((n) => n.endsWith('.tmp')).map((n) => fs.rm(path.join(dir, n), { force: true }))
    );
  } catch {
    /* the directory may not exist yet - nothing to sweep */
  }
}

export class HourlyExport {
  /**
   * @param {string} registerFile  data/registrations.csv - the source of truth
   * @param {string} outputDir     where the spreadsheets are written
   */
  constructor({ registerFile, outputDir }) {
    this.registerFile = registerFile;
    this.outputDir = outputDir || '';
    this.timer = 0;
    this.lastRun = null;
    this.lastError = '';
    this.runs = 0;
  }

  get enabled() {
    return Boolean(this.outputDir);
  }

  /**
   * Writes once now, then again at the top of every hour.
   *
   * The first tick is aligned to the next hour boundary rather than being an
   * interval from startup, so a server restarted at 14:37 still exports at
   * 15:00 and not at 15:37.
   */
  async start() {
    if (!this.enabled) return { ok: false, skipped: true };

    const first = await this.run();

    const msToNextHour = HOUR_MS - (Date.now() % HOUR_MS);
    this.timer = setTimeout(() => {
      this.run().catch(() => {});
      this.timer = setInterval(() => { this.run().catch(() => {}); }, HOUR_MS);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }, msToNextHour);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    return { ...first, nextRunInMs: msToNextHour };
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); }
    this.timer = 0;
  }

  /** Regenerates every file. Safe to call at any time. */
  async run(now = new Date()) {
    if (!this.enabled) return { ok: false, skipped: true };

    try {
      const read = await readRegister(this.registerFile);
      if (!read.ok) throw new Error(read.reason);

      await fs.mkdir(this.outputDir, { recursive: true });
      await sweepTempFiles(this.outputDir);

      const entries = read.entries;
      const hours = winnersByHour(entries);

      /* Each file is written independently. One spreadsheet left open in Excel
         must not stop the other two updating - previously the first lock threw
         and everything after it was skipped. */
      const notes = [];
      const locked = [];
      const write = async (name, text) => {
        try {
          const note = await writeAtomic(path.join(this.outputDir, name), text);
          if (note) notes.push(note);
        } catch (err) {
          locked.push(name);
          console.error('[export] ' + err.message);
        }
      };

      /* ---- everything ---- */
      await write(
        'registrations.csv',
        csv([
          ['Submitted', 'Local time', 'Hour', 'Name', 'BITS ID', 'WhatsApp',
            'Reachable?', 'Score', 'Attempt 1', 'Attempt 2', 'Attempt 3', 'Session ID'],
          ...entries.map((e) => [
            e.iso, e.time, e.hour, e.name, e.bitsId, e.phone,
            e.hasContact ? 'yes' : 'NO CONTACT', e.score,
            e.attempts[0], e.attempts[1], e.attempts[2], e.sessionId
          ])
        ])
      );

      /* ---- one row per hour ---- */
      await write(
        'hourly-winners.csv',
        csv([
          ['Hour', 'Winner', 'BITS ID', 'WhatsApp', 'Reachable?', 'Score', 'Players that hour'],
          ...hours.map((h) => [
            h.hour, h.winner.name, h.winner.bitsId, h.winner.phone,
            h.winner.hasContact ? 'yes' : 'NO CONTACT - PICK A RUNNER-UP',
            h.winner.score, h.played
          ])
        ])
      );

      /* ---- one file per completed hour ----
         Every hour except the one in progress, not just the last one: if the
         laptop restarts across a boundary that hour would otherwise never get
         a file. Past hours cannot change, so rewriting them is harmless, and
         it means a single `npm run export` after the event produces the full
         set. */
      const currentKey = hourKey(now);
      let hourFiles = 0;

      for (const bucket of hours) {
        if (bucket.hour === currentKey) continue;

        const slice = entries.filter((e) => e.hour === bucket.hour);
        if (!slice.length) continue;

        const winner = bucket;
        // Rebuild the Date from the bucket so the filename matches the data.
        const stamp = new Date(bucket.hour.replace(' ', 'T') + ':00');
        hourFiles += 1;

        await write(
          'hour-' + hourSlug(stamp) + '.csv',
          csv([
            ['Hour', bucket.hour],
            ['Winner', winner.winner.name],
            ['BITS ID', winner.winner.bitsId],
            ['WhatsApp', winner.winner.phone],
            ['Score', winner.winner.score],
            ['Players', slice.length],
            // Loud, and right next to the name, because this is discovered at
            // the worst possible moment otherwise.
            ...(winner.winner.hasContact
              ? []
              : [['WARNING', 'This winner left no contact details - use the next row down']]),
            [],
            ['Winner?', 'Name', 'BITS ID', 'WhatsApp', 'Reachable?', 'Score', 'Played at'],
            ...slice
              .slice()
              .sort((a, b) => b.score - a.score || a.iso.localeCompare(b.iso))
              .map((e) => [
                e.sessionId === winner.winner.sessionId ? 'WINNER' : '',
                e.name, e.bitsId, e.phone,
                e.hasContact ? 'yes' : 'NO CONTACT', e.score, e.time
              ])
          ])
        );
      }

      this.runs += 1;
      this.lastRun = now;
      this.lastError = locked.length ? locked.length + ' file(s) locked' : '';
      return {
        ok: true,
        entries: entries.length,
        hours: hours.length,
        hourFiles,
        notes,
        locked
      };
    } catch (err) {
      this.lastError = err.message;
      console.error('[export] failed', err.message);
      return { ok: false, error: err.message };
    }
  }

  describe() {
    if (!this.enabled) return 'off';
    if (this.lastError) return 'FAILING: ' + this.lastError;
    return 'on -> ' + this.outputDir;
  }
}
