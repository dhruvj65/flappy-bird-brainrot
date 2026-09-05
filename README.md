# Flappy Fest

An arcade Flappy-style game built for a university tech-fest stall. Every player
picks a character, gets **exactly three attempts**, and their **best** run goes
on a persistent leaderboard with their rank shown immediately.

Eight characters ship with it, each with its own artwork, sky palette,
background music and lose sound - picking a character reskins the entire scene,
not just the sprite.

| Character | Backdrop |
| --- | --- |
| Narendra Modi | Daytime city |
| Salman Bhai | Sunset city |
| Big B | Night city, with a twinkling starfield |
| Baburao | Overcast green-grey afternoon |
| Taylor Swift | Rose dusk |
| Ravi Kishan | Teal daybreak |
| Thalapathy | Golden hour |
| Haaland | Indigo twilight |

The character is chosen **before every attempt**, not once per session, so a
player can use all three of their tries on three different characters.

- **Portrait pixel art** at the classic 288x512 arcade scale, upscaled crisply to any screen
- Zero npm dependencies — `node server.js` and it runs
- No build step, no bundler, no transpiler
- Works fully offline (a laptop at a stall with no wifi is a supported setup)
- Character art and all audio are swappable files, declared in one manifest

## Running it

```bash
node server.js
```

Then open <http://localhost:3000>. The console also prints a LAN address so a
second screen or a tablet can show the same game.

```bash
npm start
```

does the same thing. To use a different port:

```bash
PORT=8080 node server.js
```

Requires Node 18 or newer (uses `crypto.randomUUID` and top-level `await`).

## Replacing the assets

All asset paths live in [`public/src/assets/manifest.js`](public/src/assets/manifest.js).
Drop files at these paths and reload — no code changes.

**Shared by every character** (`public/assets/audio/`):

| Sound | File |
| --- | --- |
| Flap | `flap.mp3` |
| Score blip | `point.mp3` |
| Collision | `collision.mp3` |
| Rank reveal | `fanfare.mp3` |

**Per character**, under that character's own id (`modi`, `salman`, `bigb`,
`baburao`, `taylor`, `ravikishan`, `thalapathy`, `haaland`):

| Asset | File |
| --- | --- |
| Artwork | `public/assets/character/<id>.png` |
| Background music | `public/assets/audio/<id>/music.mp3` |
| Lose sound | `public/assets/audio/<id>/gameover.mp3` |

To add a ninth character: add an entry to `VARIANTS` and list its id in
`ROSTER` in the manifest, add the id to `CHARACTER_IDS` in `server.js` (this
gates the cutout tool's upload endpoint, and the server must be restarted before
it takes effect), then drop in the three files above.

Artwork is a transparent head cutout drawn at its own aspect ratio. If the head
does not sit in the middle of the image — a side-on photo with hair trailing off
to one side, say — set `anchorX` on that character (0..1, where the head
actually sits across the width) so the collision circle still lands on the head
rather than on empty pixels.

Nothing is mandatory. A missing character image falls back to the built-in
pixel bird; a missing sound falls back to a WebAudio synth voice; missing music
is simply silent.

To pull background music off a video, run `npm run audio -- "<url>"` - it fetches
yt-dlp on first use and installs the track. It plays while an attempt is running
and stops the instant the player crashes. See
[`public/assets/README.md`](public/assets/README.md) for the options.

To cut a face out of a photo, open
**<http://localhost:3000/tools/character-cutout.html>** while the server is
running: drop the photo in, put the circle over the head, download `face.png`.
It previews the result at the exact in-game size. See [`public/assets/README.md`](public/assets/README.md)
for image guidance and for how to add a second character/audio **variant**
(switchable with `ACTIVE_VARIANT`, or per-URL with `?variant=<id>`).

Colours, gravity, flap strength, pipe speed and gap sizes are all in
[`public/src/config.js`](public/src/config.js) and the variant `palette`.

## Display and difficulty

The game runs on a fixed **288x512 portrait field** - the classic arcade pixel
scale - so physics and layout are identical on every screen. All artwork is
authored at 1 unit = 1 pixel in that space and blitted to a backing store that
is an **integer** multiple of it with image smoothing off; a fractional scale
would land sprite edges between device pixels and the whole scene would shimmer.
The character is 34x24 and the pipe 52 wide, the classic footprints.

The interface is sized in container-query units against the stage, so the HUD,
buttons and leaderboard scale with the game rather than drifting out of
proportion on a big monitor. Display type is sized against container *width*,
which is the constraining dimension in portrait. The whole interface is
sized in container-query units against the stage, which means the HUD, buttons
and leaderboard scale with the game rather than drifting out of proportion on a
big monitor. Below a 1:1 aspect ratio (a phone held upright) the two-column
screens stack instead.

Difficulty is deliberately shaped for a queue:

- Pipes are spaced by **time, not distance** (`intervalSeconds`), so the climb
  between two gaps stays equally reachable however fast the run gets. Fixed
  pixel spacing would quietly make late pipes impossible as the speed ramped.
- The gap carries the difficulty curve and keeps tightening (125px down to
  95px). A run has to end, or one strong player blocks the stall for everyone.
- Measured with a frame-perfect bot, runs finish at a score of ~15-17 after
  roughly 26 seconds, while pixel-perfect placement still survives past 87 - so
  the ceiling is hard but never unfair. A first-time player should land in the
  low single digits, which is the spread you want on a leaderboard.

**The one relationship you must not break:** a gap has to comfortably exceed
`flap rise + character height`, because the character oscillates by one flap
rise while crossing it. Here that is 54 + 24 = 78px against a 125px opening -
about 47px of slack at the start of a run and 17px once the gap has tightened.
Change `flapVelocity`, `gravity`, `birdRadius` or the gap values and you must
re-check that sum, or the game quietly becomes unflyable.

Otherwise, to make the game easier or harder change `baseGap` / `gapPerPoint` /
`minGap` first; they move the curve far more than speed does.

## How the three-attempt system works

[`public/src/session/sessionMachine.js`](public/src/session/sessionMachine.js)
is the only place that decides what a player may do.

```
ATTRACT -> SELECT -> READY -> PLAYING -> ATTEMPT_OVER -> SELECT -> READY
        -> PLAYING -> ATTEMPT_OVER -> SELECT -> READY -> PLAYING
        -> ATTEMPT_OVER -> SUBMITTING -> RESULT -> ATTRACT
```

Every move goes through `transition()`, which rejects anything not in the
transition table. There is no boolean anywhere that says "can play again" — the
answer is always derived from `scores.length`, an append-only array capped at 3:

- `chooseCharacter()` only works in SELECT, and every attempt is preceded by a
  SELECT, so the character is locked for the duration of an attempt and can be
  changed between attempts
- `beginAttempt()` refuses when `attemptsUsed >= 3`
- `continueSession()` refuses when `attemptsUsed >= 3`
- `endAttempt()` refuses to append a fourth score, independently
- `finishSession()` refuses until all three are used

The session score is `MAX(score1, score2, score3)` — never a sum, never an
average — computed once in `bestScore` and used everywhere. The result screen
shows all three attempt scores with the best one highlighted, so the rule is
visible rather than asserted.

**Interrupted sessions.** The session is mirrored into `localStorage` on every
change. A browser refresh restores it, so a refresh cannot mint fresh attempts.
A refresh *during* an attempt banks that attempt at the score reached — it
neither punishes the player nor lets anyone refresh out of a bad run. Sessions
older than 15 minutes are discarded.

## How the leaderboard works

**Storage.** `data/leaderboard.json`, owned by the Node server. Writes are
serialised through a promise chain and land via tmp-file + rename, so a power
cut cannot corrupt the file. On boot, an unreadable file is renamed to
`leaderboard.json.corrupt-<timestamp>` rather than being overwritten. Normal
gameplay never deletes an entry. To start a fresh event, stop the server and
delete (or archive) `data/leaderboard.json`.

**API.**

| Endpoint | Purpose |
| --- | --- |
| `GET /api/leaderboard?limit=n` | Top n entries, ranked |
| `POST /api/scores` | Submit one session's best score |
| `GET /api/health` | Entry count and uptime |
| `POST /api/character?id=<id>` | Installs a PNG as that character's art (used by the cutout tool) |

`POST /api/character?id=<id>` accepts PNG data only, caps the body at 4 MB, and
refuses any id not in the `CHARACTER_IDS` allow-list in `server.js` — so it can
only ever overwrite a known character's artwork, never write an arbitrary path.
It is unauthenticated, though: run with `FLAPPY_LOCK_ASSETS=1` to disable it
once the artwork is in place.

**Ranking.** `score DESC`, then `createdAt ASC` (an earlier submission wins a
tie), then `id ASC`. Rank is the 1-based position in exactly that order, so the
announced rank and the highlighted row can never disagree. The board is
re-sorted on insert and the `POST` response carries the freshly ranked board,
so the player never sees a stale rank.

**Best-of-three is enforced server-side.** The client sends the three attempt
scores; the server stores `MAX(attempts)` regardless of what the client claims
the session score was.

**Duplicate submissions** are blocked at four independent layers:

1. the session machine can only reach `SUBMITTING` once
2. an in-flight promise map collapses double clicks into a single request
3. a persisted result cache short-circuits a refresh landing mid-submit
4. the server is idempotent on `sessionId` — a replay returns the original
   entry and rank instead of inserting a second row

**If the backend is down**, the score is queued in `localStorage`, the player
still gets a rank computed against the last known board, the screen says so
plainly, and the queue is flushed automatically on the next successful contact.

## The leaderboard screen

**<http://localhost:3000/leaderboard.html>** is a standalone page meant for a
second monitor at the stall. It shows the full board — rank, player, all three
attempt scores with the counted one highlighted, how long ago they played, and
their best — and refreshes itself every 10 seconds. Polling pauses while the tab
is hidden, and the live indicator turns red if the server stops answering, so a
board left up all day is obviously stale rather than quietly wrong.

## Event-mode behaviour

- One tap starts an attempt — no countdown, no menu tree
- Attempt number, attempts-remaining pips and score are always on screen
- Big single-action buttons; double taps and repeated presses are swallowed
- After 60 s of no input on a non-playing screen the stall resets itself to the
  attract screen, so someone walking away mid-session does not block the queue
- "NEXT PLAYER" is a full teardown: pending timers cancelled, in-flight
  submissions invalidated, session wiped
- Audio unlocks on the first tap (browser autoplay policies), and the game is
  fully playable with sound blocked, muted or missing
- A hidden tab stops the animation loop and the music

## Project layout

```
server.js                     Node HTTP server + leaderboard store
data/leaderboard.json         persisted scores (created on first submit)
public/
  index.html                  screen markup
  leaderboard.html            standalone board for a second screen
  styles.css                  arcade styling
  tools/character-cutout.html in-browser photo -> transparent cutout tool
  assets/character/<id>.png   one cutout per character
  assets/audio/<id>/          that character's music + lose sound
  assets/audio/*.mp3          sounds shared by every character
  src/
    config.js                 all tuning constants
    main.js                   wiring only - owns no rules
    assets/manifest.js        asset paths and variants
    assets/loader.js          image loading with fallbacks
    audio/audioManager.js     pooled playback + synth fallback voices
    game/world.js             pure simulation (no DOM, no canvas)
    game/renderer.js          canvas drawing
    game/engine.js            fixed-timestep loop
    game/input.js             pointer/keyboard, attach/detach
    session/sessionMachine.js the three-attempt rules
    leaderboard/leaderboardService.js  API, dedupe, offline queue
    ui/screens.js             every DOM read/write
```

The layers only talk downward: `world.js` knows nothing about sessions, the
session machine knows nothing about the leaderboard, and `screens.js` is the
only module that touches an element.

## Performance notes

- Fixed 120 Hz simulation with an accumulator, capped at 8 catch-up steps: true
  speed down to ~15fps, and below that the game slows rather than skipping time,
  because a dropped frame must never teleport the player through a pipe
- The stage is the CSS sizing container, so a resize costs one canvas
  reconfigure rather than a cascade of relayouts
- Sky, clouds, skyline, ground, pipe body, pipe cap and the character are each
  pre-rendered once into an offscreen canvas; the frame loop only blits
- Pipes and particles are fixed-size pools — the hot loop allocates nothing
- Sky, skyline and ground strips are pre-rendered once into offscreen canvases
- Device pixel ratio is capped at 2
- HUD text is written only when a value actually changes
- Exactly one `requestAnimationFrame` handle and one interval exist at a time;
  listeners are attached once and removed in `pagehide`

## Third-party code

None. All gameplay, rendering, session and leaderboard code here is original
work written for this project, and the runtime has no dependencies — nothing is
vendored from another repository, so no third-party licence obligations apply.
Public Flappy Bird clones were consulted only for well-known behavioural
conventions (constant horizontal scroll, impulse-based flap, score on pipe
pass, rotation tied to vertical velocity); the physics constants here were
tuned independently and live in `config.js`.

**The pixel art is also original.** The pipes and the character are drawn in
code (`renderer.js`: `BIRD_CELLS`, `PIPE_BANDS`) in the classic arcade style.
No sprite sheet from Flappy Bird or any other commercial game is copied,
embedded or redistributed - those assets are their authors' copyright.

**The bundled media is a different matter.** The character photographs and the
music/lose clips under `public/assets/` were gathered for one university event
and are *not* covered by this project's MIT licence — they belong to their
respective rights holders. If you fork this, replace them with material you own.
See [ASSETS.md](ASSETS.md) for the full provenance note and a one-command way to
strip them.
