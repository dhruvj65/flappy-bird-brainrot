/**
 * Loads .env.local, if it exists.
 *
 * The Sheet URL is effectively a password - anyone holding it can append rows -
 * so it must not go in netlify.toml or .claude/launch.json, both of which are
 * committed. This keeps it in one gitignored file instead of being retyped into
 * a shell every time the stall laptop restarts.
 *
 * Deliberately tiny and dependency-free: KEY=value, # comments, optional
 * surrounding quotes. Anything already set in the real environment wins, so a
 * one-off `FLAPPY_SHEET_URL=... node server.js` still overrides the file.
 */

import fs from 'node:fs';

export function loadLocalEnv(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }

  let loaded = 0;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;

    const eq = text.indexOf('=');
    if (eq < 1) continue;

    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1).trim();

    // Strip one matching pair of quotes, so a URL with #, spaces or ; survives.
    if (value.length > 1 && ((value[0] === '"' && value.endsWith('"')) ||
        (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    // A real environment variable always wins over the file.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}
