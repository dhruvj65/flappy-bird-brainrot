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

- **Challenge Mode**: race any leaderboard run as a translucent ghost, on the
  exact pipes they flew
- **Portrait pixel art** at the classic 288x512 arcade scale, upscaled crisply to any screen
- Zero npm dependencies for the stall setup — `node server.js` and it runs
- No build step, no bundler, no transpiler, anywhere
- Works fully offline (a laptop at a stall with no wifi is a supported setup)
- Also deploys to Netlify, where one dependency replaces the file-backed store
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
| `GET /api/replay?id=<entryId>` | One entry's recorded run, for Challenge Mode |
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

## Challenge Mode

Any leaderboard row carrying a recording shows a **RACE** button - on the
attract screen's top-four panel and on every row of the full board. Pressing it
opens a brief (who you are racing, what you have to beat), counts down, and
flies their run beside you as a translucent ghost.

**The ghost is not an animation.** It is a second `World` - the same class the
live player is running - fed the opponent's recorded input. It obeys the same
gravity and dies on the same pipe they died on.

### How the recording works

`world.js` is deterministic: its only entropy is a seeded PRNG, and the engine
advances it in exact 1/120s steps. So a run is fully described by **a seed plus
the step indices the player flapped on** - about 300 bytes for a 40 second
flight, against tens of kilobytes for sampled positions. A frame drop cannot
desynchronise it, because the recording is indexed by simulation step rather
than by wall-clock time.

Every normal attempt is recorded. When a session is submitted, the recording of
the attempt that produced the best score rides along with it.

### Why it is a fair contest

The challenger plays **the opponent's seed**, so both face an identical pipe
layout. That has a consequence worth knowing: since the bird's x is fixed and
scoring is positional, two runs that are both still alive have necessarily
passed the same pipes and are **always tied**. Scores can only separate when
somebody dies.

So the contest is not a running score gap - it is *survive past the pipe they
died on*, and the HUD is built around that:

| Standing | Meaning |
| --- | --- |
| NECK AND NECK | both still flying, dead level |
| THEY ARE DOWN - n TO WIN | the ghost has crashed; the lead is now winnable |
| LEVEL - ONE MORE TO WIN | you have matched their score and are still alive |
| AHEAD BY n | past them, and every pipe extends it |

### Rules and edge cases

- **A challenge is an exhibition.** It does not consume any of the three
  leaderboard attempts and does not post a score, so the best-of-three contract
  the rest of the game rests on is untouched. `SessionMachine` sits at ATTRACT
  throughout and is never modified by Challenge Mode.
- **Only rows with a recording are challengeable.** Anything submitted before
  Challenge Mode existed has no button and says "no replay" - the honest answer
  rather than a button that fails when pressed.
- **The run raced is their best attempt** - the one that earned their place.
- **Self-challenges are refused**, matched on name, case and spacing insensitive.
- **A tie is not a win.** Matching the opponent exactly reads as DEAD HEAT,
  because the brief promised you had to beat them.
- **Quitting is free.** Abandoning, walking away (the idle reset applies to the
  brief and result screens, never mid-flight) or refreshing records nothing.
- **Personal bests are per device**, kept in `localStorage` under the player's
  name, which is what "NEW PERSONAL BEST" is measured against.

### Cost

A recording is a few hundred bytes and is fetched only when a challenge starts -
`GET /api/leaderboard` returns a `hasReplay` flag, never the blob, so a full
board stays small. The ghost costs one extra `World.update` per fixed step and
one pre-tinted blit per frame; its pipes are never drawn, because they are the
same pipes the live player already has on screen.

## The hourly prize draw

Players enter a name, a BITS ID and a WhatsApp number before their three
attempts. Every finished session appends one row to `data/registrations.csv`,
which is what the hourly winner is drawn from.

### Picking a winner

```bash
npm run winners -- now     the hour in progress, ready to read out
npm run winners            every hour so far
npm run winners -- csv     the same table as CSV
```

`-- now` prints the name, BITS ID, number and score of whoever currently leads
this hour, plus how many people have played in it. Ties go to whoever got there
first, the same rule the leaderboard uses.

### Where the details go, and where they do not

Contact details are **never** written to `data/leaderboard.json` and are never
returned by any API. They are not omitted from responses - they are not in that
store at all, so no endpoint can leak one by accident. The public board and the
second screen show a name and a score, exactly as before.

`data/registrations.csv` is gitignored. It holds real phone numbers, so keep it
off shared drives and delete it once the prizes are handed out.

### The CSV

| Column | |
| --- | --- |
| `submittedAt` | ISO timestamp, for sorting |
| `localTime` | the same moment in the stall's timezone |
| `hourBucket` | e.g. `2026-09-16 15:00` - group by this to find hourly winners |
| `name`, `bitsId`, `phone` | as entered, normalised |
| `score` | best of the three attempts |
| `attempt1..3` | the individual runs |
| `sessionId` | joins the row to its leaderboard entry |

It opens straight in Excel. Two details worth knowing:

- The file starts with a UTF-8 BOM, without which Excel mangles non-ASCII names.
- Cells beginning `=`, `+`, `-` or `@` are written with a leading apostrophe.
  Names are typed by strangers, and `=cmd|...` in a cell is a live formula when
  Excel opens it. The apostrophe is not shown in the cell and is stripped again
  by `npm run winners`. It is also why a phone number keeps its `+` instead of
  being read as a subtraction.

### Hourly spreadsheets

Point `FLAPPY_EXPORT_DIR` at a folder in `.env.local` and the server writes
spreadsheets into it on the hour, every hour, while it runs:

```
FLAPPY_EXPORT_DIR=C:\Users\you\OneDrive\Documents\flappy_excel
```

| File | |
| --- | --- |
| `registrations.csv` | every session, all hours |
| `hourly-winners.csv` | one row per hour: who won and how many played |
| `hour-<date>_<hh>-00.csv` | one completed hour on its own, winner marked |

The per-hour file is the one to open when announcing: only the people who
played in that hour, sorted by score, winner flagged in the first column.
Nothing to filter while a crowd waits.

The files are also refreshed a few seconds after anybody registers, so the
folder tracks the event rather than sitting up to an hour stale. A rush of
people finishing together collapses into one write.

`npm run export` writes them immediately, and takes an optional folder:
`npm run export -- "D:\somewhere\else"`.

The schedule follows the **local** clock, not an interval from startup - a
server started at 14:37 exports at 15:00, not 15:37. Each tick re-derives the
delay, so it stays on the hour rather than drifting. A file is written for every
completed hour rather than only the last one, so a restart across a boundary
does not leave a hole, and one `npm run export` after the event produces the
full set.

**If you leave a file open in Excel**, Excel takes an exclusive lock and nothing
can write to it - not even an overwrite. Rather than let the data quietly go
stale, the export parks it next to the original as
`registrations (LOCKED - latest).csv`. Close the original and the next export
updates it and deletes the stand-in. The boot banner, `/api/health` and
`npm run export` all say when a file is locked.

These are **derived files**. `data/registrations.csv` is the record and they
are regenerated from it every time, so a stale export, a file left open in
Excel, or a crash between hours cannot corrupt anything - the next run repairs
it. Writes go to a temp file and then rename, so a reader never catches a
half-written file, which matters when the folder is syncing to OneDrive.

### Google Sheets (optional, off by default)

The same registrations can go to a Google Sheet instead of, or as well as, the
folder. Setup is in the header of
[`tools/google-apps-script.js`](tools/google-apps-script.js): paste it into a
Sheet's Apps Script, deploy as a web app, then check it before the event:

```bash
npm run sheet:test -- "https://script.google.com/.../exec"
```

That proves the round trip and names the specific misconfiguration if it fails
(the usual one is the deployment not being shared with "Anyone"). Then set
`FLAPPY_SHEET_URL` in `.env.local`, and optionally `FLAPPY_SHEET_TOKEN` to
match `SHARED_TOKEN` in the script - the web app has to accept requests from
anyone, so without a token the URL is the only thing stopping a stranger
pushing rows.

| Command | |
| --- | --- |
| `npm run sheet:test` | check the connection |
| `npm run sheet:backfill` | push existing rows into the Sheet |
| `npm run sheet:queue` | list rows waiting for the network |
| `npm run sheet:flush` | send those rows now |

Event wifi drops, so a row that fails to send is retried, then written to
`data/sheet-queue.json` and flushed when the network returns - in submission
order, so ties still resolve to the right person.

**The Sheet URL is effectively a password.** That is why it lives in a
gitignored `.env.local` and not in `launch.json` or `netlify.toml`, both of
which are committed.

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

## Two places this runs

The game is built for a stall laptop, and that is still the primary target.
It also deploys to Netlify unchanged. The difference is only ever storage:

| | Stall (`node server.js`) | Netlify |
| --- | --- | --- |
| Static files | served from `./public` | served from `./public` |
| Leaderboard | `data/leaderboard.json`, atomic tmp+rename | Netlify Blobs |
| Concurrency | one process, writes serialised through a promise chain | ETag conditional writes with retry |
| Dependencies | none | `@netlify/blobs` |
| Character upload | works | refused (a serverless filesystem is read-only) |

Everything that decides what a score is *worth* - the ranking order, the
best-of-three authority, name sanitising, replay validation - lives in
[`lib/board.mjs`](lib/board.mjs) and is imported by both. That is deliberate:
if those rules were duplicated, the same three scores could earn different
ranks depending on where they were submitted.

### Deploying to Netlify

1. Push the repository to GitHub.
2. In Netlify, **Add new site -> Import an existing project**, and pick it.
3. Take the detected settings as they are - [`netlify.toml`](netlify.toml)
   already sets the publish directory (`public`), the functions directory and
   the Node version. There is no build step to configure.
4. Deploy. The API comes up at `/api/*`, backed by Blobs, with an empty board.

To carry existing scores across, set two environment variables locally and run
the import once:

```bash
npm run board:import
```

It needs `NETLIFY_SITE_ID` (Site configuration -> General) and
`NETLIFY_AUTH_TOKEN` (User settings -> Applications). The import merges on
entry id, so running it twice cannot duplicate anybody, and a score set on the
live site is never overwritten by an older local file.
[`npm run board:export`](tools/board-sync.mjs) is the way back - it pulls the
hosted board into `data/leaderboard.json` (backing up whatever was there) so
the stall laptop can start an event from the real standings.

### What to know before making it public

- **The bundled media becomes publicly reachable.** Netlify sites are public on
  the free tier. Everything in [ASSETS.md](ASSETS.md) applies with more force
  once the site has a URL: the character photographs and the music are other
  people's work. Password protection is a paid Netlify feature, so on the free
  tier the honest options are to replace `public/assets/` with material you own,
  or to accept that it is published.
- **Scores are unauthenticated**, exactly as they are at the stall. On a LAN
  behind a table that is fine; on the open internet anyone can POST a score.
  The server still recomputes best-of-three and clamps the values, so the worst
  case is a fake name with a plausible number beside it, not a broken board.
- **Player names go public.** The board carries the names people typed at the
  event. Consider whether you want to import them before running
  `board:import`, or start the hosted board empty.
- **Audio is the payload.** The `public/assets/audio` directory is the bulk of
  the site. Music elements use `preload="metadata"` and stream, so a character
  switch does not block on a whole track, but a long track is still a long
  download for whoever hears it through. `npm run audio` can re-cut any of them
  shorter; only the first half minute or so is heard in an attempt.

## Project layout

```
server.js                     Node HTTP server + leaderboard store (the stall)
lib/board.mjs                 ranking + validation, shared by both backends
lib/registrations.mjs         the prize-draw CSV writer
lib/registerRead.mjs          reading it back + hourly winners
lib/hourlyExport.mjs          the spreadsheets written on the hour
lib/localEnv.mjs              .env.local loader
data/registrations.csv        who played, how to reach them (gitignored)
tools/winners.mjs             hourly winners, for announcing
tools/google-apps-script.js   optional Google Sheets mirror
netlify.toml                  hosting config: publish dir, headers, functions
netlify/functions/api.mjs     the same API on Netlify Blobs
tools/board-sync.mjs          move the leaderboard between the two
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
    shared/contact.js         name / BITS ID / phone rules, shared with the server
    challenge/replay.js       recording + ghost playback
    challenge/challengeController.js  the rules of a duel
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

All gameplay, rendering, session and leaderboard code here is original work
written for this project; nothing is vendored from another repository.

The stall runtime has **no dependencies at all** - `node server.js` needs
nothing installed. The Netlify deployment has exactly one, `@netlify/blobs`,
which exists only because a serverless function has no disk to keep a
leaderboard on. Nothing in `public/` imports it, so the game itself is still
dependency-free in the browser.
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
