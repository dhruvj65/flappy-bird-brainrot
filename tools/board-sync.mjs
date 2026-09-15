#!/usr/bin/env node
/**
 * Moves the leaderboard between the stall laptop and the hosted site.
 *
 *   npm run board:import    data/leaderboard.json  ->  Netlify Blobs
 *   npm run board:export    Netlify Blobs          ->  data/leaderboard.json
 *
 * Import is what you run once after the first deploy, to carry the scores
 * already earned at the event onto the public site. Export is the way back:
 * pull the hosted board down before an event so the stall laptop starts from
 * the real standings, or just to keep a backup.
 *
 * CREDENTIALS
 *
 * Both directions talk to the Netlify API and need two values:
 *
 *   NETLIFY_SITE_ID      Site configuration -> General -> Site ID
 *   NETLIFY_AUTH_TOKEN   User settings -> Applications -> personal access token
 *
 * Nothing is written to disk by import and nothing is uploaded by export, so
 * neither direction can surprise you.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '@netlify/blobs';
import { compareEntries, isUsableEntry, normaliseEntry } from '../lib/board.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'data', 'leaderboard.json');

const STORE_NAME = 'flappy-fest';
const BOARD_KEY = 'board';
const REPLAY_PREFIX = 'replay/';

function credentials() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) {
    console.error(
      '\nMissing credentials. Set both, then run again:\n\n' +
        '  Windows (PowerShell)\n' +
        '    $env:NETLIFY_SITE_ID="your-site-id"\n' +
        '    $env:NETLIFY_AUTH_TOKEN="your-token"\n\n' +
        '  macOS / Linux\n' +
        '    export NETLIFY_SITE_ID=your-site-id\n' +
        '    export NETLIFY_AUTH_TOKEN=your-token\n\n' +
        'Site ID: Netlify -> your site -> Site configuration -> General.\n' +
        'Token:   Netlify -> User settings -> Applications -> new access token.\n'
    );
    process.exit(1);
  }
  return { siteID, token };
}

function store() {
  const { siteID, token } = credentials();
  return getStore({ name: STORE_NAME, siteID, token, consistency: 'strong' });
}

async function readLocal() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(list)) throw new Error('data/leaderboard.json has no entries array');
  return list.filter(isUsableEntry).map(normaliseEntry).sort(compareEntries);
}

/* -------------------------------------------------------------------------- */

async function runImport() {
  const blobs = store();
  const local = await readLocal();
  console.log(`read ${local.length} entries from data/leaderboard.json`);

  const existing = await blobs.get(BOARD_KEY, { type: 'json', consistency: 'strong' });
  const already = existing && Array.isArray(existing.entries) ? existing.entries : [];
  console.log(`hosted board currently holds ${already.length} entries`);

  /* Merge rather than overwrite, keyed on entry id: running this twice must
     not duplicate anybody, and a score set on the live site between deploys
     must not be wiped by an older local file. */
  const byId = new Map();
  for (const entry of already) byId.set(entry.id, entry);

  let added = 0;
  let replays = 0;
  for (const entry of local) {
    if (byId.has(entry.id)) continue;

    const { replay, ...row } = entry;
    row.hasReplay = Boolean(replay);
    byId.set(entry.id, row);
    added += 1;

    // Recordings live in their own blobs, matching what the function writes.
    if (replay) {
      await blobs.setJSON(REPLAY_PREFIX + entry.id, replay);
      replays += 1;
    }
  }

  const merged = [...byId.values()].sort(compareEntries);
  await blobs.setJSON(BOARD_KEY, { version: 1, entries: merged });

  console.log(`\nadded ${added} new entries (${replays} with replays)`);
  console.log(`hosted board now holds ${merged.length} entries`);
  if (added === 0) console.log('nothing new - the hosted board was already up to date');
}

async function runExport() {
  const blobs = store();
  const hosted = await blobs.get(BOARD_KEY, { type: 'json', consistency: 'strong' });
  const entries = hosted && Array.isArray(hosted.entries) ? hosted.entries : [];
  console.log(`hosted board holds ${entries.length} entries`);

  // Pull each recording back inline, which is the shape server.js expects.
  let replays = 0;
  const full = [];
  for (const entry of entries) {
    const row = { ...entry };
    delete row.hasReplay;
    if (entry.hasReplay) {
      const replay = await blobs.get(REPLAY_PREFIX + entry.id, { type: 'json', consistency: 'strong' });
      if (replay) {
        row.replay = replay;
        replays += 1;
      }
    }
    full.push(row);
  }

  const sorted = full.filter(isUsableEntry).map(normaliseEntry).sort(compareEntries);

  // Never clobber the stall's file without leaving the old one behind.
  try {
    await fs.copyFile(DB_FILE, DB_FILE + '.backup-' + Date.now());
    console.log('existing data/leaderboard.json backed up alongside itself');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify({ version: 1, entries: sorted }, null, 2), 'utf8');
  console.log(`\nwrote ${sorted.length} entries (${replays} with replays) to data/leaderboard.json`);
  console.log('restart the stall server to pick them up');
}

/* -------------------------------------------------------------------------- */

const mode = process.argv[2];

if (mode === 'import') {
  await runImport();
} else if (mode === 'export') {
  await runExport();
} else {
  console.error(
    'Usage:\n' +
      '  npm run board:import    push data/leaderboard.json to the hosted site\n' +
      '  npm run board:export    pull the hosted board into data/leaderboard.json\n'
  );
  process.exit(1);
}
