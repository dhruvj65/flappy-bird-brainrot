/**
 * Leaderboard rules, shared by both backends.
 *
 * The game runs in two places and they must agree exactly:
 *
 *   server.js                  the stall laptop - a file-backed Node server
 *   netlify/functions/api.mjs  the public site - Netlify Blobs
 *
 * If ranking or validation drifted between them, the same three scores would
 * earn different ranks depending on where they were submitted. So everything
 * that decides what an entry IS, or where it sits, lives here.
 *
 * This module is pure: no filesystem, no network, no Node-only globals. That
 * is what lets it run unchanged in a serverless function.
 *
 * Player identity rules - name, BITS ID, WhatsApp number - live one level down
 * in public/src/shared/contact.js and are re-exported here. They sit under
 * public/ because the browser can only load what the static server serves, and
 * the entry form has to validate with exactly this code: otherwise a number
 * the form accepted could be rejected the moment it arrived.
 */

export {
  DIAL_CODES,
  MAX_BITS_ID_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PHONE_DIGITS,
  MIN_BITS_ID_LENGTH,
  MIN_PHONE_DIGITS,
  sanitiseBitsId,
  sanitiseName,
  validateBitsId,
  validateContact,
  validatePhone
} from '../public/src/shared/contact.js';

import { sanitiseName } from '../public/src/shared/contact.js';

export const MAX_SCORE = 100000;
export const MAX_ATTEMPTS = 3;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;
export const MAX_REPLAY_BYTES = 24 * 1024;
export const MAX_REPLAY_FLAPS = 20000;
/** 12 minutes of simulation at the fixed 120 Hz step. */
export const MAX_REPLAY_STEPS = 120 * 60 * 12;

/** Works in Node 18+ and in every serverless runtime; avoids node:crypto. */
export function newId() {
  return globalThis.crypto.randomUUID();
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

/**
 * Ranking, in one place:
 *   score DESC, then createdAt ASC (an earlier submission wins a tie), then
 *   id ASC as a final tiebreak. Rank is the 1-based position in exactly that
 *   order, so an announced rank and a highlighted row can never disagree.
 */
export function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return String(a.id).localeCompare(String(b.id));
}

export function isUsableEntry(entry) {
  return entry && typeof entry === 'object' && Number.isFinite(Number(entry.score));
}

export function clampScore(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_SCORE);
}

/**
 * Structural validation of a Challenge Mode replay. The client validates it
 * again before running it, so this only has to stop the store filling with
 * junk: right shape, sane sizes, no nested objects.
 */
export function sanitiseReplay(replay) {
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) return null;
  if (Number(replay.v) !== 1) return null;

  const seed = Number(replay.seed);
  const steps = Number(replay.steps);
  if (!Number.isFinite(seed) || !Number.isFinite(steps)) return null;
  if (steps <= 0 || steps > MAX_REPLAY_STEPS) return null;

  if (!Array.isArray(replay.flaps) || replay.flaps.length > MAX_REPLAY_FLAPS) return null;
  const flaps = [];
  for (const value of replay.flaps) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return null;
    flaps.push(n);
  }

  const clean = {
    v: 1,
    seed: seed >>> 0,
    characterId: String(replay.characterId || '').slice(0, 32),
    steps: Math.floor(steps),
    score: clampScore(replay.score),
    flaps
  };

  // Final guard on encoded size, so one huge record cannot bloat the store.
  if (byteLength(JSON.stringify(clean)) > MAX_REPLAY_BYTES) return null;
  return clean;
}

export function normaliseEntry(entry) {
  const attempts = Array.isArray(entry.attempts)
    ? entry.attempts.slice(0, MAX_ATTEMPTS).map((n) => clampScore(n))
    : [];
  return {
    id: String(entry.id || newId()),
    sessionId: entry.sessionId ? String(entry.sessionId).slice(0, 64) : null,
    name: sanitiseName(entry.name),
    score: clampScore(entry.score),
    attempts,
    createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now(),
    /* Challenge Mode: the recording of this player's best attempt, or null.
       Entries written before Challenge Mode existed simply have none, which is
       exactly the "not challengeable" state the client already handles. */
    replay: sanitiseReplay(entry.replay)
  };
}

/**
 * Board rows never carry replay blobs - only whether one exists. Fetching the
 * recording itself is a separate request, made only when a challenge starts.
 *
 * The two backends store replays differently and this handles both: the stall
 * server keeps the recording on the entry, while the Netlify function keeps
 * recordings in their own blobs and leaves a `hasReplay` marker behind, so the
 * board it reads on every request stays small.
 */
export function toPublicEntry(entry) {
  const { replay, ...rest } = entry;
  return Object.assign(rest, { hasReplay: Boolean(replay) || Boolean(entry.hasReplay) });
}

/**
 * The server is the authority on "best of three": when the client sends its
 * per-attempt scores, the stored score is MAX(attempts) regardless of what the
 * client claimed the session total was.
 */
export function resolveScore(body) {
  const attempts = Array.isArray(body.attempts)
    ? body.attempts.slice(0, MAX_ATTEMPTS).map(clampScore)
    : [];
  const score = attempts.length ? Math.max.apply(null, attempts) : clampScore(body.score);
  return { attempts, score };
}

/** Clamps a caller-supplied ?limit= into the allowed range. */
export function resolveLimit(raw) {
  const requested = Number(raw);
  return Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
}

/** Sorted, ranked, replay-free rows for the board. */
export function rankedTop(entries, limit) {
  return entries
    .slice(0, limit)
    .map((entry, i) => Object.assign(toPublicEntry(entry), { rank: i + 1 }));
}
