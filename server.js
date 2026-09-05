/**
 * Flappy Fest - stall server.
 *
 * Zero dependency Node HTTP server with two responsibilities:
 *   1. Serve the static game in ./public
 *   2. Own the persistent leaderboard (./data/leaderboard.json)
 *
 * The leaderboard file is append-only in spirit: entries are never removed by
 * normal gameplay, and every write goes through an atomic tmp+rename so a crash
 * (or somebody yanking the laptop power at the stall) cannot leave a half
 * written file behind.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'leaderboard.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MAX_NAME_LENGTH = 14;
const MAX_SCORE = 100000;
const MAX_ATTEMPTS = 3;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_BODY_BYTES = 8 * 1024;
/* A score submission now carries a Challenge Mode replay, which is a seed plus
   delta-encoded flap steps - small, but bigger than a bare score. The cap is
   generous for a legitimate run (a 3 minute flight is well under 8 KB) and
   still bounded. */
const MAX_SCORE_BODY_BYTES = 64 * 1024;
const MAX_REPLAY_BYTES = 24 * 1024;
const MAX_REPLAY_FLAPS = 20000;
const MAX_CHARACTER_BYTES = 4 * 1024 * 1024;
const CHARACTER_DIR = path.join(PUBLIC_DIR, 'assets', 'character');
/** Only these ids may be written, and the id maps straight to <id>.png. This
 *  is the whole allow-list - it stops the endpoint being coaxed into writing
 *  anywhere else. Keep it in step with the roster in manifest.js. */
const CHARACTER_IDS = new Set([
  'modi', 'salman', 'bigb', 'baburao', 'taylor', 'ravikishan', 'thalapathy',
  'haaland'
]);
/* Set FLAPPY_LOCK_ASSETS=1 to refuse character uploads - worth doing if the
   stall is on an open network and you have already installed the artwork. */
const ASSETS_LOCKED = process.env.FLAPPY_LOCK_ASSETS === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

/* -------------------------------------------------------------------------- */
/* Leaderboard store                                                          */
/* -------------------------------------------------------------------------- */

class LeaderboardStore {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.bySession = new Map();
    this.loaded = false;
    // Serialises every write so two concurrent submissions cannot interleave.
    this.writeChain = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.entries;
      if (Array.isArray(list)) {
        this.entries = list.filter(isUsableEntry).map(normaliseEntry);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.entries = [];
      } else {
        // Never destroy data we failed to understand - park it and start clean.
        const backup = this.file + '.corrupt-' + Date.now();
        try {
          await fs.rename(this.file, backup);
          console.error('[leaderboard] unreadable store moved to ' + backup, err.message);
        } catch (renameErr) {
          console.error('[leaderboard] unreadable store, backup failed', renameErr.message);
        }
        this.entries = [];
      }
    }
    this.reindex();
    this.loaded = true;
    return this.entries.length;
  }

  reindex() {
    this.entries.sort(compareEntries);
    this.bySession.clear();
    for (const entry of this.entries) {
      if (entry.sessionId) this.bySession.set(entry.sessionId, entry);
    }
  }

  /**
   * Idempotent on sessionId: replaying the same submission (double click,
   * refresh, retry after a timeout) returns the original entry instead of
   * inserting a second row for the same player session.
   */
  async submit({ sessionId, name, score, attempts, replay }) {
    const existing = sessionId ? this.bySession.get(sessionId) : null;
    if (existing) {
      return Object.assign({ entry: existing, duplicate: true }, this.locate(existing));
    }

    const entry = normaliseEntry({
      id: crypto.randomUUID(),
      sessionId: sessionId || crypto.randomUUID(),
      name,
      score,
      attempts,
      replay,
      createdAt: Date.now()
    });

    this.entries.push(entry);
    this.reindex();
    await this.persist();
    return Object.assign({ entry, duplicate: false }, this.locate(entry));
  }

  /**
   * Ranking strategy (deterministic, documented in the README):
   *   score DESC, then createdAt ASC (earlier submission wins a tie), then
   *   id ASC as a final tiebreak. Rank === 1-based position in that order, so
   *   the highlighted row and the announced rank can never disagree.
   */
  locate(entry) {
    const index = this.entries.findIndex((e) => e.id === entry.id);
    return { rank: index < 0 ? null : index + 1, total: this.entries.length };
  }

  top(limit) {
    return this.entries
      .slice(0, limit)
      .map((entry, i) => Object.assign(toPublicEntry(entry), { rank: i + 1 }));
  }

  /** The full recording for one entry, or null. */
  replayFor(id) {
    const entry = this.entries.find((e) => e.id === id);
    return entry && entry.replay ? entry.replay : null;
  }

  persist() {
    this.writeChain = this.writeChain
      .then(() => this.writeNow())
      .catch((err) => {
        console.error('[leaderboard] write failed', err.message);
      });
    return this.writeChain;
  }

  async writeNow() {
    const payload = JSON.stringify({ version: 1, entries: this.entries }, null, 2);
    const tmp = this.file + '.' + process.pid + '.tmp';
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, this.file);
  }
}

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return String(a.id).localeCompare(String(b.id));
}

function isUsableEntry(entry) {
  return entry && typeof entry === 'object' && Number.isFinite(Number(entry.score));
}

function normaliseEntry(entry) {
  const attempts = Array.isArray(entry.attempts)
    ? entry.attempts.slice(0, MAX_ATTEMPTS).map((n) => clampScore(n))
    : [];
  return {
    id: String(entry.id || crypto.randomUUID()),
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
 * Structural validation of a replay. The client validates it again before
 * running it, so this only has to stop the store filling up with junk: right
 * shape, sane sizes, no nested objects.
 */
function sanitiseReplay(replay) {
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) return null;
  if (Number(replay.v) !== 1) return null;

  const seed = Number(replay.seed);
  const steps = Number(replay.steps);
  if (!Number.isFinite(seed) || !Number.isFinite(steps)) return null;
  if (steps <= 0 || steps > 120 * 60 * 12) return null;

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

  // Final guard on the encoded size, so one huge record cannot bloat the file.
  if (Buffer.byteLength(JSON.stringify(clean)) > MAX_REPLAY_BYTES) return null;
  return clean;
}

/** Board rows never carry replay blobs - only whether one exists. Fetching the
 *  recording itself is a separate request, made only when a challenge starts. */
function toPublicEntry(entry) {
  const { replay, ...rest } = entry;
  return Object.assign(rest, { hasReplay: Boolean(replay) });
}

function stripControlCharacters(value) {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    // C0 controls, DEL and the C1 block: never legitimate in a display name.
    if (code < 32 || (code >= 127 && code <= 159)) continue;
    out += ch;
  }
  return out;
}

function sanitiseName(value) {
  const cleaned = stripControlCharacters(String(value == null ? '' : value))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || 'PLAYER';
}

function clampScore(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_SCORE);
}

/* -------------------------------------------------------------------------- */
/* HTTP plumbing                                                              */
/* -------------------------------------------------------------------------- */

const store = new LeaderboardStore(DB_FILE);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      entries: store.entries.length,
      replays: store.entries.reduce((n, e) => n + (e.replay ? 1 : 0), 0),
      uptime: Math.round(process.uptime())
    });
  }

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const requested = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.floor(requested), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    return sendJson(res, 200, { ok: true, entries: store.top(limit), total: store.entries.length });
  }

  /* Character upload, used by /tools/character-cutout.html.
     Deliberately narrow: one fixed destination path that the client cannot
     influence, PNG magic bytes required, and a hard size cap. The worst a
     stranger on the LAN can do is change the character artwork. */
  if (url.pathname === '/api/character' && req.method === 'POST') {
    if (ASSETS_LOCKED) {
      return sendJson(res, 403, { ok: false, error: 'Asset uploads are locked (FLAPPY_LOCK_ASSETS=1).' });
    }

    const id = (url.searchParams.get('id') || 'modi').toLowerCase();
    if (!CHARACTER_IDS.has(id)) {
      return sendJson(res, 400, { ok: false, error: 'Unknown character id "' + id + '".' });
    }

    const body = await readBinaryBody(req, MAX_CHARACTER_BYTES);
    const isPng =
      body.length > 8 &&
      body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47;
    if (!isPng) {
      return sendJson(res, 400, { ok: false, error: 'Only PNG data is accepted.' });
    }

    const target = path.join(CHARACTER_DIR, id + '.png');
    await fs.mkdir(CHARACTER_DIR, { recursive: true });
    const tmp = target + '.' + process.pid + '.tmp';
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, target);
    console.log('[character] wrote ' + target + ' (' + body.length + ' bytes)');
    return sendJson(res, 201, { ok: true, bytes: body.length, path: 'assets/character/' + id + '.png' });
  }

  /* Challenge Mode: the recording behind one leaderboard row. Served on its
     own rather than inside the board so the board stays small - a full board
     with replays inlined would be megabytes. */
  if (url.pathname === '/api/replay' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '').slice(0, 64);
    if (!id) return sendJson(res, 400, { ok: false, error: 'An entry id is required.' });

    const entry = store.entries.find((e) => e.id === id);
    if (!entry) return sendJson(res, 404, { ok: false, error: 'No such leaderboard entry.' });

    const replay = entry.replay;
    if (!replay) {
      return sendJson(res, 404, {
        ok: false,
        error: 'That run was recorded before Challenge Mode, so it has no replay.'
      });
    }

    return sendJson(res, 200, {
      ok: true,
      replay,
      entry: { id: entry.id, name: entry.name, score: entry.score, createdAt: entry.createdAt }
    });
  }

  if (url.pathname === '/api/scores' && req.method === 'POST') {
    const body = await readBody(req, MAX_SCORE_BODY_BYTES);

    const attempts = Array.isArray(body.attempts)
      ? body.attempts.slice(0, MAX_ATTEMPTS).map(clampScore)
      : [];

    // The server is the authority on "best of three": when the client sends the
    // per-attempt scores, the stored score is MAX(attempts) regardless of what
    // the client claimed the session total was.
    const score = attempts.length ? Math.max.apply(null, attempts) : clampScore(body.score);

    if (!Number.isFinite(score)) {
      return sendJson(res, 400, { ok: false, error: 'A numeric score is required.' });
    }

    const result = await store.submit({
      sessionId: body.sessionId ? String(body.sessionId).slice(0, 64) : null,
      name: body.name,
      score,
      attempts,
      replay: body.replay
    });

    return sendJson(res, result.duplicate ? 200 : 201, {
      ok: true,
      duplicate: result.duplicate,
      entry: Object.assign(toPublicEntry(result.entry), { rank: result.rank }),
      rank: result.rank,
      total: result.total,
      entries: store.top(DEFAULT_LIMIT)
    });
  }

  return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
}

function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveStatic(req, res, url) {
  const decoded = decodeURIComponent(url.pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);

  // Path traversal guard: everything must stay inside ./public
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }

  let filePath = target;
  let fileStat = stat;
  if (stat.isDirectory()) {
    filePath = path.join(target, 'index.html');
    try {
      fileStat = await fs.stat(filePath);
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': fileStat.size
    });
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': fileStat.size,
    // Assets are meant to be hot-swapped between events; never let a stale
    // character image or audio file survive a refresh.
    'Cache-Control': 'no-cache'
  });

  const stream = fsSync.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url);
    } else {
      res.writeHead(405).end('Method not allowed');
    }
  } catch (err) {
    const status = err.status || 500;
    console.error('[server]', req.method, url.pathname, err.message);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message });
    else res.end();
  }
});

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const count = await store.load();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  FLAPPY FEST  -  stall server running');
  console.log('  leaderboard : ' + DB_FILE + ' (' + count + ' entries loaded)');
  console.log('  local       : http://localhost:' + PORT);
  for (const address of localAddresses()) {
    console.log('  network     : http://' + address + ':' + PORT);
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  shutting down, flushing leaderboard...');
    store.writeChain.finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  });
}
