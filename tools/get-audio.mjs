#!/usr/bin/env node
/**
 * Extracts an audio track and installs it as a game sound. The source can be a
 * video URL or a local audio/video file already on disk.
 *
 *   node tools/get-audio.mjs <url>                      -> background music
 *   node tools/get-audio.mjs ./clip.mp3 --name gameover -> a local file
 *   node tools/get-audio.mjs <url> --start 0:42 --duration 90
 *
 * Dependencies are handled for you: yt-dlp is a single self-contained binary
 * and is fetched into tools/bin on first run. ffmpeg is OPTIONAL - without it
 * the original audio stream is saved as .m4a (which every modern browser
 * plays); with it, the audio is converted to .mp3 and can be trimmed.
 *
 * Only download material you have the right to use. At a public event that
 * usually means your own recording, or something published under a licence
 * that permits it (Creative Commons, royalty-free, etc).
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(__dirname, 'bin');
const AUDIO_DIR = path.join(ROOT, 'public', 'assets', 'audio');

/** Sound names the game knows about, from public/src/assets/manifest.js. */
const KNOWN_NAMES = ['music', 'flap', 'point', 'collision', 'gameover', 'fanfare'];

const YTDLP_RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const YTDLP_ASSET = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp'
};

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { url: null, name: 'music', character: null, start: null, duration: null, end: null, format: null, installOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install-only') opts.installOnly = true;
    else if (arg === '--name') opts.name = argv[++i];
    else if (arg === '--character' || arg === '--for') opts.character = argv[++i];
    else if (arg === '--start') opts.start = argv[++i];
    else if (arg === '--duration') opts.duration = argv[++i];
    else if (arg === '--end') opts.end = argv[++i];
    else if (arg === '--format') opts.format = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (!arg.startsWith('-') && !opts.url) opts.url = arg;
  }
  return opts;
}

function usage() {
  console.log(`
  Extract audio from a video URL into the game's assets.

    node tools/get-audio.mjs <url> [options]

  Options
    --name <name>       which sound to install (default: music)
                        one of: ${KNOWN_NAMES.join(', ')}
    --character <id>    install a per-character sound (music / gameover),
                        e.g. --character salman -> assets/audio/salman/
    --start <time>      trim start, e.g. 0:42 or 42        (needs ffmpeg)
    --end <time>        trim end, e.g. 1:13                  (needs ffmpeg)
    --duration <secs>   how much to keep, e.g. 90            (needs ffmpeg)
    --format mp3|m4a    output format (default: mp3 if ffmpeg is available)
    --install-only      just fetch yt-dlp, download nothing else

  Examples
    node tools/get-audio.mjs "https://youtu.be/XXXX"
    node tools/get-audio.mjs "https://youtu.be/XXXX" --start 0:30 --duration 75
    node tools/get-audio.mjs "./sounds/thud.mp3" --name gameover
    node tools/get-audio.mjs "https://youtu.be/XXXX" --character salman
    node tools/get-audio.mjs "https://youtu.be/XXXX" --character salman --name gameover --start 0:08
`);
}

/** Accepts 75, 1:15 or 1:02:03 and returns seconds. */
function toSeconds(value) {
  const parts = String(value).trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) throw new Error(`Cannot read the time "${value}".`);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

function commandExists(cmd) {
  const probe = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
  if (!probe.error) return true;
  const probe2 = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !probe2.error;
}

/**
 * Locates ffmpeg, returning { exe, dir, onPath } or null.
 *
 * PATH alone is not enough: a fresh `winget install` edits the PATH of future
 * shells, so the terminal that ran the install still cannot see it. Checking
 * the well-known install locations means the tool works immediately instead of
 * telling you to restart your terminal.
 */
function findFfmpeg() {
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

  if (commandExists('ffmpeg')) return { exe: 'ffmpeg', dir: null, onPath: true };

  const candidates = [path.join(BIN_DIR, exeName)];

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winget = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    candidates.push(path.join(winget, 'Links', exeName));
    const packages = path.join(winget, 'Packages');
    try {
      for (const entry of fsSync.readdirSync(packages)) {
        if (!/ffmpeg/i.test(entry)) continue;
        // Builds nest the binary a couple of levels down; find it.
        const root = path.join(packages, entry);
        const stack = [root];
        while (stack.length) {
          const dir = stack.pop();
          for (const item of fsSync.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, item.name);
            if (item.isDirectory()) stack.push(full);
            else if (item.name.toLowerCase() === exeName) candidates.push(full);
          }
        }
      }
    } catch {
      /* no winget packages directory - fine */
    }
  }

  for (const exe of candidates) {
    if (!fsSync.existsSync(exe)) continue;
    const probe = spawnSync(exe, ['-version'], { stdio: 'ignore' });
    if (!probe.error) return { exe, dir: path.dirname(exe), onPath: false };
  }

  return null;
}

/** Returns a path to a usable yt-dlp, downloading it if necessary. */
async function ensureYtDlp() {
  // Prefer one already on PATH (installed via winget, brew, pip, apt...).
  if (commandExists('yt-dlp')) {
    console.log('  yt-dlp      : found on PATH');
    return 'yt-dlp';
  }

  const asset = YTDLP_ASSET[process.platform];
  if (!asset) throw new Error(`No yt-dlp build known for platform "${process.platform}". Install it manually and re-run.`);

  const target = path.join(BIN_DIR, asset);
  if (fsSync.existsSync(target)) {
    console.log('  yt-dlp      : ' + path.relative(ROOT, target));
    return target;
  }

  await fs.mkdir(BIN_DIR, { recursive: true });
  const url = YTDLP_RELEASES + asset;
  console.log('  yt-dlp      : downloading ' + url);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download yt-dlp (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(target, buf);
  if (process.platform !== 'win32') await fs.chmod(target, 0o755);

  console.log(`                (${(buf.length / 1024 / 1024).toFixed(1)} MB) -> ` + path.relative(ROOT, target));
  return target;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`))
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || (!opts.url && !opts.installOnly)) {
    usage();
    process.exit(opts.help ? 0 : 1);
  }

  if (!KNOWN_NAMES.includes(opts.name)) {
    console.warn(`  note        : "${opts.name}" is not one of ${KNOWN_NAMES.join(', ')}.`);
    console.warn('                It will be saved, but nothing will play it unless you');
    console.warn('                add it to public/src/assets/manifest.js.');
  }

  console.log('');

  /* A source that is not http(s) and exists on disk is used directly: no
     download, and the original file is only ever read, never moved. */
  const isRemote = /^https?:[/][/]/i.test(opts.url || '');
  const localSource = !isRemote && opts.url ? path.resolve(opts.url) : null;
  if (localSource && !fsSync.existsSync(localSource)) {
    throw new Error('No such file: ' + localSource);
  }

  const ytdlp = isRemote ? await ensureYtDlp() : null;
  if (localSource) console.log('  source file : ' + localSource);
  const ffmpeg = findFfmpeg();
  const hasFfmpeg = Boolean(ffmpeg);
  console.log(
    '  ffmpeg      : ' +
      (hasFfmpeg
        ? (ffmpeg.onPath ? 'found on PATH' : ffmpeg.exe) + '  (mp3 + trimming available)'
        : 'not found (will save .m4a, no trimming)')
  );

  if (opts.installOnly) {
    console.log('\n  Dependencies ready.\n');
    return;
  }

  const localExt = localSource ? path.extname(localSource).slice(1).toLowerCase() : null;

  const wantsTrim = Boolean(opts.start || opts.duration || opts.end);
  if (wantsTrim && !hasFfmpeg) {
    throw new Error('--start/--end/--duration need ffmpeg. Install it, or drop those options.');
  }

  const format = opts.format || (hasFfmpeg ? 'mp3' : 'm4a');
  if (format === 'mp3' && !hasFfmpeg) {
    throw new Error('mp3 output needs ffmpeg. Install it, or use --format m4a.');
  }

  const startSec = opts.start ? toSeconds(opts.start) : 0;
  let endSec = null;
  if (opts.end) endSec = toSeconds(opts.end);
  else if (opts.duration) endSec = startSec + toSeconds(opts.duration);
  if (endSec !== null && endSec <= startSec) {
    throw new Error('The clip ends before it starts - check --start/--end.');
  }

  /* Per-character sounds (music, gameover) live in assets/audio/<id>/ so each
     character can have its own; shared effects stay in assets/audio/. */
  const outDir = opts.character ? path.join(AUDIO_DIR, opts.character) : AUDIO_DIR;
  await fs.mkdir(outDir, { recursive: true });
  const stem = path.join(outDir, opts.name);
  const finalPath = `${stem}.${format}`;

  // Remove any older take so a failed run cannot leave two competing files.
  for (const ext of ['mp3', 'm4a', 'ogg', 'webm', 'opus', 'wav']) {
    const stale = `${stem}.${ext}`;
    if (fsSync.existsSync(stale)) await fs.rm(stale);
  }

  console.log('  source      : ' + opts.url);
  if (wantsTrim) {
    console.log('  clip        : ' + fmt(startSec) + ' -> ' + (endSec === null ? 'end' : fmt(endSec)) +
                (endSec === null ? '' : `  (${(endSec - startSec).toFixed(0)}s)`));
  }
  console.log('  installing  : ' + path.relative(ROOT, finalPath) + '\n');

  /* Download the whole audio stream first and cut afterwards with ffmpeg.
     yt-dlp's --download-sections cuts on keyframe boundaries, which is fine for
     video but drifts for a music loop; a plain ffmpeg -ss/-to on the finished
     file lands exactly on the requested timestamps. */
  let scratch = localSource;
  let scratchIsTemporary = false;

  if (isRemote) {
    const scratchStem = path.join(outDir, `.${opts.name}-source`);
    const ytArgs = ['--no-playlist', '-f', 'bestaudio/best', '-o', `${scratchStem}.%(ext)s`, opts.url];
    await run(ytdlp, ytArgs);

    scratch = (await fs.readdir(outDir))
      .filter((f) => f.startsWith(`.${opts.name}-source.`))
      .map((f) => path.join(outDir, f))[0];
    if (!scratch) throw new Error('yt-dlp finished but produced no file.');
    scratchIsTemporary = true;
  }

  try {
    const alreadyRightFormat = Boolean(localExt) && localExt === format;
    if ((format === 'mp3' || wantsTrim) && !(alreadyRightFormat && !wantsTrim)) {
      const ffArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
      if (startSec) ffArgs.push('-ss', String(startSec));
      if (endSec !== null) ffArgs.push('-to', String(endSec));
      ffArgs.push('-i', scratch);
      if (format === 'mp3') ffArgs.push('-codec:a', 'libmp3lame', '-q:a', '0');
      else ffArgs.push('-codec:a', 'copy');
      ffArgs.push(finalPath);
      console.log('  ' + (wantsTrim ? 'cutting     ' : 'converting  ') + ': ffmpeg\n');
      await run(ffmpeg.exe, ffArgs);
    } else if (scratchIsTemporary) {
      await fs.rename(scratch, finalPath);
    } else {
      // Already the right format with no trim: copy, so the original stays put.
      await fs.copyFile(scratch, finalPath);
    }
  } finally {
    if (scratchIsTemporary && fsSync.existsSync(scratch)) {
      await fs.rm(scratch).catch(() => {});
    }
  }

  const size = (await fs.stat(finalPath)).size;
  console.log('');
  console.log('  done        : ' + path.relative(ROOT, finalPath) + `  (${(size / 1024 / 1024).toFixed(2)} MB)`);
  if (opts.character) {
    console.log('                character: ' + opts.character);
  }
  if (opts.name === 'music') {
    console.log('                Reload the game - it loops while an attempt runs');
    console.log('                and stops the moment you crash.');
  }
  console.log('');
}

/** Seconds -> m:ss for the log line. */
function fmt(total) {
  const m = Math.floor(total / 60);
  const sec = Math.round(total % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

main().catch((err) => {
  console.error('\n  failed      : ' + err.message + '\n');
  process.exit(1);
});
