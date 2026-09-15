/**
 * Leaderboard service - the only module that talks to the backend.
 *
 * Duplicate submissions are blocked at four independent layers, because at a
 * stall every one of them will be attempted by somebody:
 *
 *   1. the session machine only reaches SUBMITTING once
 *   2. an in-flight promise map collapses double clicks into one request
 *   3. a persisted result cache short-circuits a refresh mid-submit
 *   4. the server is idempotent on sessionId
 *
 * When the backend is unreachable the submission is queued locally, the player
 * still gets a rank (computed against the last known board plus the queue), and
 * the queue is flushed automatically on the next successful contact.
 */

import { LEADERBOARD } from '../config.js';

export class LeaderboardService {
  constructor(config = LEADERBOARD) {
    this.config = config;
    this.inflight = new Map();
    this.online = true;
    this.mirror = readJson(config.storageKey, { entries: [], total: 0, savedAt: 0 });
    this.queue = readJson(config.queueKey, []);
    this.results = readJson(config.resultsKey, {});
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  async fetchTop() {
    try {
      const data = await this.request(
        this.config.apiBase + '/leaderboard?limit=' + this.config.fetchLimit,
        { method: 'GET' }
      );
      this.online = true;
      this.mirror = { entries: data.entries || [], total: data.total || 0, savedAt: Date.now() };
      writeJson(this.config.storageKey, this.mirror);
      // Good moment to retry anything stranded by an earlier outage.
      this.flushQueue();
      return { ok: true, source: 'server', entries: this.mirror.entries, total: this.mirror.total };
    } catch (err) {
      this.online = false;
      const merged = this.mergedBoard();
      return {
        ok: false,
        source: 'cache',
        error: err.message,
        entries: merged,
        total: Math.max(this.mirror.total, merged.length)
      };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Writes                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Submits the session's best score. Safe to call repeatedly with the same
   * sessionId: the same result comes back and no second entry is created.
   */
  submit({ sessionId, name, score, attempts, replay, contact }) {
    if (!sessionId) return Promise.reject(new Error('A sessionId is required to submit a score.'));

    const cached = this.results[sessionId];
    if (cached && !cached.pending) return Promise.resolve(cached);

    const existing = this.inflight.get(sessionId);
    if (existing) return existing;

    const promise = this.performSubmit({ sessionId, name, score, attempts, replay, contact }).finally(() => {
      this.inflight.delete(sessionId);
    });

    this.inflight.set(sessionId, promise);
    return promise;
  }

  async performSubmit(payload) {
    const body = {
      sessionId: payload.sessionId,
      name: payload.name,
      score: payload.score,
      attempts: Array.isArray(payload.attempts) ? payload.attempts : []
    };
    /* The recording of the attempt that produced the best score, so this row
       can be challenged later. Omitted entirely when there is nothing to send,
       which keeps an offline queue entry the same size it always was. */
    if (payload.replay) body.replay = payload.replay;

    /* Prize-draw details, flattened onto the body the server already reads.
       Queued offline submissions carry them too, so a score that lands after
       the network comes back still registers its player. */
    if (payload.contact) {
      body.bitsId = payload.contact.bitsId || '';
      body.phone = payload.contact.phone || '';
      body.dialCode = payload.contact.dialCode || '';
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.config.submitRetries; attempt += 1) {
      try {
        const data = await this.request(this.config.apiBase + '/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        this.online = true;
        this.mirror = {
          entries: data.entries || this.mirror.entries,
          total: data.total || this.mirror.total,
          savedAt: Date.now()
        };
        writeJson(this.config.storageKey, this.mirror);

        const result = {
          ok: true,
          pending: false,
          source: 'server',
          rank: data.rank,
          total: data.total,
          entryId: data.entry ? data.entry.id : null,
          entries: this.mirror.entries,
          score: data.entry ? data.entry.score : payload.score,
          name: data.entry ? data.entry.name : payload.name,
          sessionId: payload.sessionId
        };

        this.rememberResult(payload.sessionId, result);
        this.removeFromQueue(payload.sessionId);
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < this.config.submitRetries) await delay(350 * (attempt + 1));
      }
    }

    // Offline path: keep the score, keep the player moving.
    this.online = false;
    return this.queueSubmission(body, lastError);
  }

  queueSubmission(body, error) {
    const entry = {
      id: 'local-' + body.sessionId,
      sessionId: body.sessionId,
      name: body.name,
      score: body.score,
      attempts: body.attempts,
      createdAt: Date.now(),
      local: true
    };

    if (!this.queue.some((item) => item.sessionId === body.sessionId)) {
      this.queue.push(entry);
      writeJson(this.config.queueKey, this.queue);
    }

    const board = this.mergedBoard();
    const rank = board.findIndex((item) => item.sessionId === body.sessionId) + 1;

    const result = {
      ok: false,
      pending: true,
      source: 'local',
      rank: rank || board.length,
      total: Math.max(this.mirror.total + this.queue.length, board.length),
      entryId: entry.id,
      entries: board,
      score: body.score,
      name: body.name,
      sessionId: body.sessionId,
      error: error ? error.message : 'Leaderboard unavailable'
    };

    this.rememberResult(body.sessionId, result);
    return result;
  }

  /** Best effort retry of everything stranded by an outage. Never throws. */
  async flushQueue() {
    if (!this.queue.length) return;

    const pending = this.queue.slice();
    for (const item of pending) {
      try {
        const data = await this.request(this.config.apiBase + '/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: item.sessionId,
            name: item.name,
            score: item.score,
            attempts: item.attempts
          })
        });

        this.removeFromQueue(item.sessionId);

        const previous = this.results[item.sessionId];
        if (previous) {
          this.rememberResult(item.sessionId, {
            ...previous,
            ok: true,
            pending: false,
            source: 'server',
            rank: data.rank,
            total: data.total,
            entryId: data.entry ? data.entry.id : previous.entryId
          });
        }
      } catch {
        // Still offline; leave the rest of the queue for the next attempt.
        return;
      }
    }
  }

  removeFromQueue(sessionId) {
    const next = this.queue.filter((item) => item.sessionId !== sessionId);
    if (next.length !== this.queue.length) {
      this.queue = next;
      writeJson(this.config.queueKey, this.queue);
    }
  }

  rememberResult(sessionId, result) {
    this.results[sessionId] = result;

    // Keep the cache small: a stall laptop should not accumulate a thousand
    // results in localStorage over a two day event.
    const keys = Object.keys(this.results);
    if (keys.length > 40) {
      for (const key of keys.slice(0, keys.length - 40)) delete this.results[key];
    }
    writeJson(this.config.resultsKey, this.results);
  }

  getCachedResult(sessionId) {
    return sessionId ? this.results[sessionId] || null : null;
  }

  /** Last known server board merged with anything still queued locally. */
  mergedBoard() {
    const combined = this.mirror.entries.slice();
    for (const item of this.queue) {
      if (!combined.some((entry) => entry.sessionId === item.sessionId)) combined.push(item);
    }
    combined.sort(compareEntries);
    return combined.map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  /* ------------------------------------------------------------------ */
  /* Transport                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Fetches the recording behind one leaderboard row, for Challenge Mode.
   *
   * Never queued and never retried: a challenge is an immediate, interactive
   * request, and failing fast lets the UI say "no replay" rather than hanging
   * the player on a spinner.
   */
  async fetchReplay(entryId) {
    if (!entryId) return { ok: false, error: "That row has no id." };
    try {
      const data = await this.request(
        this.config.apiBase + "/replay?id=" + encodeURIComponent(entryId),
        { method: "GET" }
      );
      return { ok: true, replay: data.replay, entry: data.entry };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) {
        /* The API sends a human-readable reason in the body ("that run has no
           replay"), which is far more use to a player than the status code.
           Fall back to the code only when there is no message to show. */
        let reason = '';
        try {
          const body = await response.json();
          reason = body && typeof body.error === 'string' ? body.error : '';
        } catch {
          reason = '';
        }
        throw new Error(reason || 'Leaderboard responded ' + response.status);
      }
      const data = await response.json();
      if (!data || data.ok === false) throw new Error((data && data.error) || 'Leaderboard error');
      return data;
    } catch (err) {
      throw err.name === 'AbortError' ? new Error('Leaderboard timed out') : err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Same ordering the server uses, so an offline rank never jumps on reconnect. */
function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return String(a.id).localeCompare(String(b.id));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable - degrade to in-memory only */
  }
}
