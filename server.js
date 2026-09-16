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
import { loadLocalEnv } from './lib/localEnv.mjs';
/* Ranking and validation are shared with the Netlify function so the stall
   laptop and the public site can never disagree about what a score is worth. */
import { RegistrationLog } from './lib/registrations.mjs';
import { SheetMirror } from './lib/sheetMirror.mjs';
import { HourlyExport } from './lib/hourlyExport.mjs';
import {
  DEFAULT_LIMIT,
  validateContact,
  compareEntries,
  isUsableEntry,
  normaliseEntry,
  rankedTop,
  resolveLimit,
  resolveScore,
  toPublicEntry
} from './lib/board.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Local, gitignored settings (the Sheet URL and token live here so they are
   not committed and not retyped on every restart). Loaded before anything
   below reads process.env. */
const localEnvCount = loadLocalEnv(path.join(__dirname, '.env.local'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'leaderboard.json');
/* The prize-draw register. Kept apart from the leaderboard so contact details
   can never reach a public API response - see lib/registrations.mjs. */
const REGISTER_FILE = path.join(DATA_DIR, 'registrations.csv');
/* Google Sheets. FLAPPY_SHEET_URL is an Apps Script web app URL; unset = off.
   FLAPPY_SHEET_TOKEN is an optional shared secret the script checks. */
const SHEET_URL = process.env.FLAPPY_SHEET_URL || '';
const SHEET_TOKEN = process.env.FLAPPY_SHEET_TOKEN || '';
/* Rows that could not be sent wait here until the network comes back. */
const SHEET_QUEUE_FILE = path.join(DATA_DIR, 'sheet-queue.json');
/* Hourly CSV export. FLAPPY_EXPORT_DIR is a folder to drop spreadsheets in;
   unset = off. Written on the hour, every hour. */
const EXPORT_DIR = process.env.FLAPPY_EXPORT_DIR || '';
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MAX_BODY_BYTES = 8 * 1024;
/* A score submission now carries a Challenge Mode replay, which is a seed plus
   delta-encoded flap steps - small, but bigger than a bare score. The cap is
   generous for a legitimate run (a 3 minute flight is well under 8 KB) and
   still bounded. */
const MAX_SCORE_BODY_BYTES = 64 * 1024;
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
    return rankedTop(this.entries, limit);
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

/* Ranking, name sanitising, score clamping, replay validation and the
   public-row shape all live in lib/board.mjs - see the import above. */

/* -------------------------------------------------------------------------- */
/* HTTP plumbing                                                              */
/* -------------------------------------------------------------------------- */

const store = new LeaderboardStore(DB_FILE);
const register = new RegistrationLog(REGISTER_FILE);
const sheet = new SheetMirror({
  url: SHEET_URL,
  token: SHEET_TOKEN,
  queueFile: SHEET_QUEUE_FILE
});
const hourly = new HourlyExport({
  registerFile: REGISTER_FILE,
  outputDir: EXPORT_DIR
});

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
      registrations: await register.count(),
      sheet: sheet.describe(),
      sheetQueued: sheet.queue.length,
      hourlyExport: hourly.describe(),
      lastExport: hourly.lastRun ? hourly.lastRun.toISOString() : null,
      uptime: Math.round(process.uptime())
    });
  }

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const limit = resolveLimit(url.searchParams.get('limit'));
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

    const { attempts, score } = resolveScore(body);

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

    /* Register the player for the hourly prize draw, once per session. A
       duplicate submission (double click, refresh, retry after a timeout) must
       not enter anybody into the draw twice. */
    if (!result.duplicate) {
      const contact = validateContact({
        name: body.name,
        bitsId: body.bitsId,
        dialCode: body.dialCode,
        phone: body.phone
      });

      /* Written even when the details are incomplete. The score is real and
         already on the board; dropping the row would quietly make that player
         ineligible for a prize with nobody noticing. A blank cell is visible
         in the sheet and can be chased. */
      const row = {
        name: result.entry.name,
        bitsId: contact.contact.bitsId,
        phone: contact.contact.phone,
        score: result.entry.score,
        attempts: result.entry.attempts,
        sessionId: result.entry.sessionId,
        at: new Date(result.entry.createdAt)
      };

      /* Both, independently. The CSV is a local append that cannot fail for
         network reasons; the Sheet is what gets read during the event. Neither
         is awaited - the player's score is already on the board and must not
         wait on a spreadsheet. */
      register.append(row);
      sheet.send(row).catch(() => {});
    }

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
const registered = await register.init();
const queued = await sheet.start();
const exported = await hourly.start();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  FLAPPY FEST  -  stall server running');
  console.log('  leaderboard : ' + DB_FILE + ' (' + count + ' entries loaded)');
  console.log('  prize draw  : ' + REGISTER_FILE + ' (' + registered + ' registered)');
  if (localEnvCount) console.log('  settings    : .env.local (' + localEnvCount + ' value(s))');
  if (sheet.enabled) {
    console.log('  google sheet: ' + sheet.describe());
  } else {
    console.log('  google sheet: off (set FLAPPY_SHEET_URL to enable)');
  }
  if (queued) console.log('  ' + queued + ' row(s) queued from a previous run - retrying');
  console.log('  hourly export: ' + hourly.describe());
  if (hourly.enabled && exported && exported.nextRunInMs != null) {
    console.log('  next export : in ' + Math.round(exported.nextRunInMs / 60000) + ' min (on the hour)');
  }
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
