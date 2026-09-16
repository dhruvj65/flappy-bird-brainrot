#!/usr/bin/env node
/**
 * Writes the spreadsheets now, without waiting for the hour.
 *
 *   npm run export                 uses FLAPPY_EXPORT_DIR from .env.local
 *   npm run export -- "C:\some\folder"   writes somewhere else once
 *
 * The server does this automatically on the hour; this is for when you want
 * the files refreshed immediately - right before an announcement, say.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from '../lib/localEnv.mjs';
import { HourlyExport } from '../lib/hourlyExport.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
loadLocalEnv(path.join(ROOT, '.env.local'));

const outputDir = process.argv[2] || process.env.FLAPPY_EXPORT_DIR || '';
if (!outputDir) {
  console.error(
    '\nNo output folder.\n\n' +
      '  npm run export -- "C:\\path\\to\\folder"\n\n' +
      'or set FLAPPY_EXPORT_DIR in .env.local so it is used every time.\n'
  );
  process.exit(1);
}

const hourly = new HourlyExport({
  registerFile: path.join(ROOT, 'data', 'registrations.csv'),
  outputDir
});

const result = await hourly.run();

if (!result.ok) {
  console.error('\n  Export failed: ' + result.error + '\n');
  process.exit(1);
}

console.log('\n  Wrote to ' + outputDir);
console.log('    registrations.csv     ' + result.entries + ' session(s)');
console.log('    hourly-winners.csv    ' + result.hours + ' hour(s)');
if (result.hourFiles) console.log("    hour-<...>.csv        " + result.hourFiles + " completed hour(s)");
else console.log('    (no completed hours yet - the current hour is still running)');
if (result.notes && result.notes.length) for (const n of result.notes) console.log('    note: ' + n);
if (result.failed && result.failed.length) console.log('  FAILED: ' + result.failed.join(', '));
if (result.locked && result.locked.length) {
  console.log('');
  console.log('  OPEN IN EXCEL: ' + result.locked.join(', '));
  console.log('  Current data is in the matching "(LOCKED - latest)" file.');
  console.log('  Close them in Excel and the originals catch up by themselves.');
}
console.log('');
