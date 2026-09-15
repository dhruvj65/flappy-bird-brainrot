/**
 * The leaderboard API, for the Netlify deployment.
 *
 * server.js does this job on the stall laptop, backed by a JSON file. That
 * cannot work here: a serverless function gets a fresh, read-only container on
 * every invocation, so there is no disk to keep a leaderboard on. This uses
 * Netlify Blobs instead.
 *
 * Every rule about what an entry is worth - ranking, name sanitising, the
 * best-of-three authority, replay validation - is imported from lib/board.mjs,
 * the same module server.js uses. Only the storage differs.
 *
 * STORAGE SHAPE
 *
 *   board            { version, entries[] }  entries carry a hasReplay marker
 *   replay/<entryId> the recording itself
 *
 * Replays live in their own blobs rather than inside the board. The board is
 * read on every leaderboard request and rewritten on every submission, so
 * keeping kilobytes of recordings out of it matters; a recording is fetched
 * only when somebody actually starts a challenge.
 *
 * CONCURRENCY
 *
 * The stall server serialises writes through a promise chain because it is one
 * process. Here, two players can submit at the same instant into two separate
 * containers. Blobs' ETag conditional write (`onlyIfMatch`) turns that into
 * optimistic concurrency: if the board changed underneath us the write is
 * refused and we retry against fresh state, so no entry is ever lost.
 */

import { getStore } from '@netlify/blobs';
import {
  DEFAULT_LIMIT,
  compareEntries,
  isUsableEntry,
  newId,
  normaliseEntry,
  rankedTop,
  resolveLimit,
  resolveScore
} from '../../lib/board.mjs';

const STORE_NAME = 'flappy-fest';
const BOARD_KEY = 'board';
const REPLAY_PREFIX = 'replay/';
/** Retries for a conditional write losing a race. Five is far beyond what a
 *  stall queue can actually collide with. */
const WRITE_ATTEMPTS = 5;
const MAX_BODY_BYTES = 64 * 1024;

/* Strong consistency: a player must see their own score the instant it lands,
   and the eventual-consistency default can lag by up to a minute. */
function board() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Board access                                                               */
/* -------------------------------------------------------------------------- */

async function readBoard(store) {
  const found = await store.getWithMetadata(BOARD_KEY, { type: 'json', consistency: 'strong' });
  const data = found && found.data ? found.data : null;
  const list = data && Array.isArray(data.entries) ? data.entries : [];
  return {
    etag: found ? found.etag : null,
    entries: list.filter(isUsableEntry).sort(compareEntries)
  };
}

/**
 * Read-modify-write against the board under optimistic concurrency.
 *
 * `mutate` receives the current entries and returns either
 *   { done: <result> }            nothing to write (an idempotent replay)
 *   { entries: [...], result }    the new board to attempt
 */
async function updateBoard(store, mutate) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const { etag, entries } = await readBoard(store);
    const outcome = await mutate(entries);
    if (outcome.done !== undefined) return outcome.done;

    const next = outcome.entries.slice().sort(compareEntries);
    const { modified } = await store.setJSON(
      BOARD_KEY,
      { version: 1, entries: next },
      // No etag means the board does not exist yet; onlyIfNew stops two
      // simultaneous first writes from clobbering each other.
      etag ? { onlyIfMatch: etag } : { onlyIfNew: true }
    );

    if (modified) return outcome.result;
    // Somebody wrote first. Loop and rebuild against what they left behind.
  }
  throw Object.assign(new Error('The leaderboard is busy - try again.'), { status: 503 });
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The routing, with the store passed in.
 *
 * Separated from the default export purely so the concurrency behaviour can be
 * exercised against an in-memory store in tests - the retry loop is the one
 * piece of genuinely new logic here and guessing at it was not good enough.
 */
export async function handleRequest(req, store) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, '');

  try {

    /* ---- health ---- */
    if (route === '/api/health') {
      const { entries } = await readBoard(store);
      return json(200, {
        ok: true,
        entries: entries.length,
        replays: entries.reduce((n, e) => n + (e.hasReplay ? 1 : 0), 0),
        backend: 'netlify-blobs'
      });
    }

    /* ---- the board ---- */
    if (route === '/api/leaderboard' && req.method === 'GET') {
      const { entries } = await readBoard(store);
      const limit = resolveLimit(url.searchParams.get('limit'));
      return json(200, { ok: true, entries: rankedTop(entries, limit), total: entries.length });
    }

    /* ---- one recorded run, for Challenge Mode ---- */
    if (route === '/api/replay' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '').slice(0, 64);
      if (!id) return json(400, { ok: false, error: 'An entry id is required.' });

      const { entries } = await readBoard(store);
      const entry = entries.find((e) => e.id === id);
      if (!entry) return json(404, { ok: false, error: 'No such leaderboard entry.' });

      const replay = await store.get(REPLAY_PREFIX + id, { type: 'json', consistency: 'strong' });
      if (!replay) {
        return json(404, {
          ok: false,
          error: 'That run was recorded before Challenge Mode, so it has no replay.'
        });
      }

      return json(200, {
        ok: true,
        replay,
        entry: { id: entry.id, name: entry.name, score: entry.score, createdAt: entry.createdAt }
      });
    }

    /* ---- submit a session ---- */
    if (route === '/api/scores' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'Payload too large' });

      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(400, { ok: false, error: 'Invalid JSON body' });
      }

      const { attempts, score } = resolveScore(body);
      if (!Number.isFinite(score)) {
        return json(400, { ok: false, error: 'A numeric score is required.' });
      }

      const sessionId = body.sessionId ? String(body.sessionId).slice(0, 64) : null;

      /* Validated before the entry is built so the marker on the board and the
         blob that backs it can never disagree. */
      const candidate = normaliseEntry({
        id: newId(),
        sessionId: sessionId || newId(),
        name: body.name,
        score,
        attempts,
        replay: body.replay,
        createdAt: Date.now()
      });
      const replay = candidate.replay;

      /* The recording is written first, under the entry's own id. A recording
         with no board row is invisible; a row promising a recording that is
         not there would be a broken challenge. */
      if (replay) {
        await store.setJSON(REPLAY_PREFIX + candidate.id, replay);
      }

      const stored = await updateBoard(store, (entries) => {
        // Idempotent on sessionId: a double click, a refresh or a retry after a
        // timeout returns the original entry rather than inserting a second row.
        const existing = sessionId ? entries.find((e) => e.sessionId === sessionId) : null;
        if (existing) {
          return { done: { entry: existing, entries, duplicate: true } };
        }

        const row = { ...candidate, hasReplay: Boolean(replay) };
        delete row.replay;

        const next = entries.concat(row);
        return { entries: next, result: { entry: row, entries: next, duplicate: false } };
      });

      const ordered = stored.entries.slice().sort(compareEntries);
      const index = ordered.findIndex((e) => e.id === stored.entry.id);
      const rank = index < 0 ? null : index + 1;

      return json(stored.duplicate ? 200 : 201, {
        ok: true,
        duplicate: stored.duplicate,
        entry: Object.assign({}, stored.entry, { rank, hasReplay: Boolean(stored.entry.hasReplay) }),
        rank,
        total: ordered.length,
        entries: rankedTop(ordered, DEFAULT_LIMIT)
      });
    }

    /* ---- character upload: local-only by nature ---- */
    if (route === '/api/character') {
      return json(403, {
        ok: false,
        error:
          'Character artwork cannot be uploaded to the hosted site - a serverless ' +
          'filesystem is read-only and would be discarded anyway. Run the cutout ' +
          'tool against a local server, commit the PNG, and redeploy.'
      });
    }

    return json(404, { ok: false, error: 'Unknown endpoint' });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    console.error('[api]', route, err && err.message);
    return json(status, { ok: false, error: (err && err.message) || 'Server error' });
  }
}

export default async (req) => handleRequest(req, board());

export const config = {
  path: '/api/*'
};
