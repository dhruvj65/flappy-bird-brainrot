/**
 * Pushes prize-draw registrations into a Google Sheet.
 *
 * The Sheet is what you actually work from during the event. This is the
 * client that keeps it fed.
 *
 * WHY IT IS MORE THAN ONE FETCH
 *
 * A stall laptop on event wifi drops out. Google occasionally takes seconds to
 * answer. An Apps Script deployment can be mid-redeploy. Any of those with a
 * plain fire-and-forget POST means a row is gone for good - and if that row
 * was the hour's winner, nobody ever finds out.
 *
 * So a failed row is retried, and if it still will not go it lands in an
 * on-disk queue that is flushed on a timer and again at startup. The moment
 * the wifi returns, everything missed catches up in order.
 *
 * The local CSV is written regardless and independently. Between the two, a
 * registration has to lose a disk write AND every retry AND the queue file to
 * actually disappear.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Attempts inside a single submission before the row goes to the queue. */
const IMMEDIATE_ATTEMPTS = 2;
/** How often the queue is retried in the background. */
const FLUSH_INTERVAL_MS = 30000;
/** A single request's patience. Longer than this and the player is waiting. */
const REQUEST_TIMEOUT_MS = 8000;
/** Stop the queue growing without bound if the URL is simply wrong all day. */
const MAX_QUEUE = 2000;

export class SheetMirror {
  /**
   * @param {string} url    Apps Script /exec URL. Empty disables everything.
   * @param {string} token  Optional shared secret, matched by the script.
   * @param {string} queueFile  Where unsent rows wait for the network.
   */
  constructor({ url, token = '', queueFile }) {
    this.url = url || '';
    this.token = token || '';
    this.queueFile = queueFile;
    this.queue = [];
    this.timer = 0;
    this.flushing = false;
    this.stats = { sent: 0, queued: 0, failed: 0, lastError: '' };
  }

  get enabled() {
    return Boolean(this.url);
  }

  /** Loads anything left over from a previous run and starts the retry timer. */
  async start() {
    if (!this.enabled) return 0;

    try {
      const raw = await fs.readFile(this.queueFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.queue = parsed.slice(0, MAX_QUEUE);
    } catch {
      this.queue = [];
    }

    // unref() so a pending timer never holds the process open on shutdown.
    this.timer = setInterval(() => { this.flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    if (this.queue.length) this.flush().catch(() => {});
    return this.queue.length;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }

  /**
   * Sends one row. Never throws and never blocks the response: the player's
   * score is already on the board by the time this is called.
   */
  async send(row) {
    if (!this.enabled) return { ok: false, skipped: true };

    /* If anything is already waiting, this row joins the back of the queue
       instead of overtaking it. Sending directly would put a newer row above
       an older one in the sheet, and ties in the Winners tab break on
       submission order - so the sheet would name the wrong winner. */
    if (this.queue.length) {
      await this.enqueue(row);
      this.flush().catch(() => {});
      return { ok: false, queued: true, behind: this.queue.length - 1 };
    }

    for (let attempt = 1; attempt <= IMMEDIATE_ATTEMPTS; attempt += 1) {
      const result = await this.post(row);
      if (result.ok) {
        this.stats.sent += 1;
        return result;
      }
      this.stats.lastError = result.error;
      if (attempt < IMMEDIATE_ATTEMPTS) await delay(400 * attempt);
    }

    await this.enqueue(row);
    return { ok: false, queued: true, error: this.stats.lastError };
  }

  async post(row) {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.token ? { ...row, token: this.token } : row),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // Apps Script answers a POST with a 302 to script.googleusercontent.com.
        redirect: 'follow'
      });

      if (!res.ok) return { ok: false, error: 'sheet responded ' + res.status };

      /* Apps Script returns 200 with an HTML error page for several failure
         modes - a script exception, or access not actually being public. A
         non-JSON body therefore means "not working", not "fine". */
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        const hint = /accounts\.google\.com|sign in|Google Account/i.test(text)
          ? 'the web app is not shared with "Anyone" - redeploy with that access'
          : 'the script returned a page, not JSON (check the Apps Script logs)';
        return { ok: false, error: hint };
      }

      if (body && body.ok === false) return { ok: false, error: body.error || 'script refused the row' };
      return { ok: true, body };
    } catch (err) {
      const reason = err && err.name === 'TimeoutError' ? 'timed out' : (err && err.message) || 'network error';
      return { ok: false, error: reason };
    }
  }

  async enqueue(row) {
    if (this.queue.length >= MAX_QUEUE) {
      this.stats.failed += 1;
      return;
    }
    this.queue.push(row);
    this.stats.queued = this.queue.length;
    await this.persist();
  }

  /** Sends whatever is waiting, oldest first, stopping at the first failure. */
  async flush() {
    if (!this.enabled || this.flushing || !this.queue.length) return this.queue.length;
    this.flushing = true;

    try {
      while (this.queue.length) {
        const result = await this.post(this.queue[0]);
        if (!result.ok) {
          this.stats.lastError = result.error;
          break;
        }
        // Order matters in the sheet, so only drop the head once it is through.
        this.queue.shift();
        this.stats.sent += 1;
      }
      this.stats.queued = this.queue.length;
      await this.persist();
    } finally {
      this.flushing = false;
    }

    return this.queue.length;
  }

  async persist() {
    try {
      await fs.mkdir(path.dirname(this.queueFile), { recursive: true });
      if (!this.queue.length) {
        await fs.rm(this.queueFile, { force: true });
        return;
      }
      await fs.writeFile(this.queueFile, JSON.stringify(this.queue, null, 2), 'utf8');
    } catch (err) {
      console.error('[sheet] could not persist the queue', err.message);
    }
  }

  /** A one-line health summary for the boot banner and /api/health. */
  describe() {
    if (!this.enabled) return 'off';
    if (this.queue.length) return 'on, ' + this.queue.length + ' waiting to send';
    return 'on';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
