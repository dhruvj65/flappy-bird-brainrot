# Assets

Every path below is declared in `public/src/assets/manifest.js`. Drop a file at
the matching path and it is picked up on the next page load — no code changes.
Anything missing degrades gracefully, so the game always runs.

## Characters

The roster lives in `public/src/assets/manifest.js`. Each character owns its
artwork, background music, lose sound and sky palette:

| id | Name | Artwork | Music | Lose sound |
| --- | --- | --- | --- | --- |
| `modi` | Narendra Modi | `character/modi.png` | `audio/modi/music.*` | `audio/modi/gameover.*` |
| `salman` | Salman Bhai | `character/salman.png` | `audio/salman/music.*` | `audio/salman/gameover.*` |
| `bigb` | Big B | `character/bigb.png` | `audio/bigb/music.*` | `audio/bigb/gameover.*` |

Anything missing degrades rather than breaks: a character with no artwork flies
as the built-in pixel bird and its card reads "Art coming soon"; a missing sound
falls back to its synth voice.

### Adding a character

1. Add an entry to `VARIANTS` in `manifest.js` and list its id in `ROSTER`
2. Add the id to `CHARACTER_IDS` in `server.js` (the upload allow-list)
3. Drop in `character/<id>.png` and `audio/<id>/music.*` + `audio/<id>/gameover.*`

Give each one a visibly different `palette` - the sky is how players tell them
apart at a glance.

**Recommended:** a PNG cutout of the head on a transparent background, roughly
256-512 px. It does not need to be square or tightly cropped - the game trims
the transparent padding for you.

The cutout is drawn **exactly as supplied**: no wing, no beak, no outline, and
at its own aspect ratio, so a head stays head-shaped. It is sized to
`PHYSICS.faceHeight` (30px) tall.

**Width is the constraint that matters.** A head crop is taller than it is
wide, so its width is what has to cover the collision circle - otherwise players
die on apparent near-misses. `PHYSICS.birdRadius` (9, i.e. 18px across) is set
to sit inside a typical head cutout at that height. If you load artwork narrower
than that, the console warns and the sprite is scaled up to compensate; the
better fix is a wider crop or a smaller radius. Anything taller than the circle
just overhangs, which is forgiving rather than unfair.

### Making one from a photo

Start the server and open **<http://localhost:3000/tools/character-cutout.html>**.

1. Drop the photo in
2. Drag the circle onto the head and scroll to size it around the head + beard
3. Nudge "background clean-up" up if a flat backdrop still shows in the corners
   (it flood-fills from the circle edge, anchored to the sampled backdrop
   colour, so it will not eat the face)
4. Download `face.png` and drop it into `assets/character/`

The page can also POST straight to `/api/character`, which writes
`assets/character/face.png` for you. That endpoint only ever writes that one
path, only accepts PNG data, and caps the size at 4 MB - but it is
unauthenticated, so on an open network set `FLAPPY_LOCK_ASSETS=1` to disable it
once the artwork is installed.

The panel previews the result at the exact in-game size, which matters: at 24px
a face only reads if it has strong high-contrast features - a hairline, a beard,
glasses. Crop tight to the head; a wide crop turns to mush at that size.

Tuning lives in `manifest.js` under `character`:

| Option | Effect |
| --- | --- |
| `scale` | multiplier on `PHYSICS.faceHeight` - make the character bigger or smaller |
| `circleCrop` | `false` (default) draws the cutout as-is. Set `true` only for a **square photo that still has its background**: it clips the image to a circle |
| `ringColor` | outline colour, drawn only when `circleCrop` is true |

## Audio

| File | Plays when | If missing |
| --- | --- | --- |
| `audio/flap.mp3` | the player flaps | synth blip |
| `audio/point.mp3` | a pipe is passed | synth two-tone |
| `audio/collision.mp3` | the character hits something | synth noise burst |
| `audio/gameover.mp3` | the game-over screen appears | synth descending motif |
| `audio/fanfare.mp3` | the final rank is revealed | synth arpeggio |
| `audio/music.mp3` | background loop, starts on the first tap | silence |

`.mp3`, `.ogg`, `.wav` and `.m4a` are all served correctly. The music entry
lists several extensions and uses the first that loads, so `music.mp3` and
`music.m4a` both work with no config edit.

### Pulling a track off a video

```bash
npm run audio -- "<url>" --character bigb
npm run audio -- "./clip.mp3" --character bigb --name gameover
```

`tools/get-audio.mjs` fetches yt-dlp on first run (a single self-contained
binary, into `tools/bin/`) and saves the audio as the background music.

The source can be a **video URL or a local file** already on disk. A local file
is only ever read - it is copied, never moved, and left where it is.

| Option | Effect |
| --- | --- |
| `--name <sound>` | install as a different sound, e.g. `--name gameover` |
| `--start <time>` | trim start, e.g. `0:42` *(needs ffmpeg)* |
| `--duration <s>` | how much to keep, e.g. `90` *(needs ffmpeg)* |
| `--character <id>` | install a per-character sound, e.g. `--character bigb` |
| `--format mp3\|m4a` | default is mp3 when ffmpeg is available, else m4a |
| `--install-only` | fetch yt-dlp and stop |

Both dependencies are installed: yt-dlp (fetched into `tools/bin/`) and ffmpeg
(via `winget install Gyan.FFmpeg`), so mp3 output and trimming are available.

If ffmpeg ever goes missing the tool still works - it falls back to saving the
original `.m4a` stream, which every modern browser plays, and only `--start` /
`--duration` become unavailable. The tool looks for ffmpeg on PATH and in the
winget install locations, so a fresh install works without restarting your
terminal.

Only download material you have the right to use. At a public event that
normally means your own recording, or something released under a licence that
permits it.

### When the music plays

It starts when an attempt starts and **stops the moment the player crashes** -
the silence is the feedback that the run is over. Each attempt restarts the
track from the top, and returning to the attract screen always stops it.
To make it play continuously instead, remove the `audio.stopMusic()` call in
`handleCrash` in `public/src/main.js`.

Keep sound effects short (< 1 s) and normalised — per-file volume is set in
`manifest.js` (`volume`, 0–1).

Audio never blocks gameplay. Browsers block sound until the first user gesture,
so playback is unlocked on the first tap/keypress; if the browser or the
hardware refuses entirely, the game runs silently.

## Adding a second character / audio set

Add a new entry to `VARIANTS` in `manifest.js`:

```js
export const VARIANTS = Object.freeze({
  default: { /* ... */ },
  dean: {
    id: 'dean',
    label: 'The Dean',
    tagline: 'Attendance is mandatory.',
    character: { src: 'assets/character/dean.png', fallbackSrc: CHARACTER_FALLBACK, scale: 1.05 },
    audio: { /* same shape as default */ },
    palette: { /* same shape as default */ }
  }
});
```

Then either set `ACTIVE_VARIANT = 'dean'` or open the game as `/?variant=dean`.
