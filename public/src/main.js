/**
 * Flappy Fest - application wiring.
 *
 * This module owns no rules of its own. It connects five independent pieces:
 *
 *   SessionMachine  decides what is allowed (3 attempts, best of 3, one submit)
 *   World           simulates the flight
 *   Renderer/Engine draw it
 *   LeaderboardService  persists and ranks
 *   ScreenController    shows it
 *
 * Anything that could leave the stall in a broken state - a pending timer, a
 * half-finished session, an attempt that never ended - is torn down in one
 * place: resetToAttract().
 */

import { RULES, LEADERBOARD, VIEW, CHALLENGE } from './config.js';
import { getVariant, resolveVariant, DEFAULT_VARIANT } from './assets/manifest.js';
import { loadCharacter } from './assets/loader.js';
import { AudioManager } from './audio/audioManager.js';
import { World, WORLD_EVENT } from './game/world.js';
import { Renderer } from './game/renderer.js';
import { Engine } from './game/engine.js';
import { InputManager } from './game/input.js';
import { SessionMachine, STATE } from './session/sessionMachine.js';
import { LeaderboardService } from './leaderboard/leaderboardService.js';
import { ScreenController } from './ui/screens.js';
import { ChallengeController, CHALLENGE_PHASE } from './challenge/challengeController.js';
import { ReplayRecorder, decodeReplay, replayByteLength } from './challenge/replay.js';

/** Whatever the URL asks for, else the default - the attract screen needs
 *  something on it before a character has been picked. */
const bootVariant = resolveVariant(window.location.search);
let activeVariant = bootVariant;

/** Character artwork, kept so switching back does not refetch. */
const characterImages = new Map();

const stage = document.getElementById('stage');
const canvas = document.getElementById('game');

const world = new World();
const renderer = new Renderer(canvas, bootVariant.palette);
const audio = new AudioManager(bootVariant.audio).init();
const session = new SessionMachine();
const leaderboard = new LeaderboardService(LEADERBOARD);
const challenge = new ChallengeController();

/* Challenge Mode recording. Every normal attempt is recorded so the row it
   produces can be raced later; the recording is a seed plus flap step indices,
   so this costs a few hundred bytes per attempt and nothing per frame. */
const recorder = new ReplayRecorder();
/** Recordings for this session's attempts, in the order they were played. */
let attemptReplays = [];
/** Cancels an in-flight countdown if the player walks away mid-count. */
let cancelCountdown = null;

/** Timers that must never outlive a session. */
let gameOverTimer = 0;
let lastInputAt = Date.now();
let idleTimer = 0;
let submitToken = 0;

const screens = new ScreenController({
  onStart: handleStart,
  onChooseCharacter: handleChooseCharacter,
  onContinue: handleContinue,
  onAbandon: resetToAttract,
  onNewPlayer: resetToAttract,
  onToggleSound: handleToggleSound,
  onChallenge: handleChallenge,
  onChallengeStart: handleChallengeStart,
  onChallengeCancel: exitChallenge,
  onChallengeExit: exitChallenge,
  onRematch: handleRematch
});

const engine = new Engine({
  world,
  renderer,
  onEvents: handleWorldEvents,
  onFrame: handleFrame,
  onStep: handleStep
});

const input = new InputManager(stage, {
  onFlap: handleFlap,
  onAnyInput: () => {
    lastInputAt = Date.now();
    audio.unlock();
  }
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function boot() {
  screens.setTagline(bootVariant.tagline);
  screens.setSoundLabel(audio.muted);

  renderer.resize();
  observeResize();

  await applyVariant(bootVariant.id);

  session.on(handleSessionChange);
  input.attach();
  engine.start();

  startIdleWatch();
  watchVisibility();

  // Restore a session interrupted by a refresh before showing anything.
  const restored = session.restore();
  if (restored && session.characterId !== activeVariant.id) {
    await applyVariant(session.characterId);
  }
  if (!restored) {
    session.reset();
  } else if (session.state === STATE.SUBMITTING) {
    // A refresh landed mid-submit: re-run it. The service and the server are
    // both idempotent on sessionId, so no second entry can appear.
    runSubmission();
  } else if (session.state === STATE.RESULT) {
    showCachedResult();
  } else {
    screens.toast('Session restored - ' + session.attemptsRemaining + ' attempt(s) left');
  }

  await refreshMiniBoard();

  /* Arriving from the standalone leaderboard page, which links to
     /?challenge=<entryId>. Done last so a failure here cannot stop the game
     itself from booting. */
  const requested = new URLSearchParams(window.location.search).get('challenge');
  if (requested && !session.sessionId) {
    // Drop the parameter so a refresh does not silently re-open the duel.
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch {
      /* ignore - the parameter is cosmetic */
    }
    handleChallenge({ id: requested, name: '', score: 0 });
  }
}

function observeResize() {
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => renderer.resize());
    observer.observe(stage);
  } else {
    window.addEventListener('resize', () => renderer.resize());
  }
}

function watchVisibility() {
  // A hidden tab must not keep a rAF loop (or the music) running all afternoon.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      engine.stop();
      audio.stopMusic();
    } else {
      engine.start();
      // Only an attempt in progress has music; READY is pre-tap, so it is quiet.
      if (session.state === STATE.PLAYING) audio.startMusic();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Session flow                                                               */
/* -------------------------------------------------------------------------- */

function handleSessionChange(snapshot) {
  screens.render(snapshot);

  if (snapshot.state === STATE.READY) {
    // Show the idle character behind the "tap to fly" prompt.
    world.reset();
  }

  if (snapshot.state === STATE.ATTRACT) {
    // Every route back to the attract screen ends the music, not just the
    // buttons - a session reset from anywhere leaves the stall quiet.
    audio.stopMusic();
  }

  if (snapshot.state === STATE.SUBMITTING) {
    runSubmission();
  }
}

/**
 * Switches the game over to a character: artwork, background palette and its
 * own music/lose sounds. Everything a character owns is swapped here, so
 * adding a character never means touching gameplay code.
 */
async function applyVariant(id) {
  const variant = getVariant(id);
  activeVariant = variant;

  if (!characterImages.has(variant.id)) {
    const { image, source } = await loadCharacter(variant.character);
    characterImages.set(variant.id, image);
    if (source !== 'primary') {
      // Not fatal - the drawn pixel bird stands in until the art arrives.
      console.info(
        '[assets] no artwork for "%s" at %s - using the drawn bird',
        variant.id,
        variant.character.src
      );
    }
  }

  renderer.setCharacter(characterImages.get(variant.id), variant.character);
  renderer.setPalette(variant.palette);
  audio.load(variant.audio);
  screens.setSoundLabel(audio.muted);
}

async function handleChooseCharacter(id) {
  clearGameOverTimer();
  // Load first, then advance - so the ready screen already shows the right
  // character and its sky rather than flashing the previous one.
  await applyVariant(id);
  session.chooseCharacter(id);
}

/** `entry` is the validated form record from the screen controller. */
function handleStart(entry) {
  clearGameOverTimer();
  /* Unlock here so the browser's autoplay gate is already open by the time the
     player taps to fly. The music itself does not start until that tap - the
     name-entry and "tap to fly" screens stay quiet. */
  audio.unlock();

  const record = typeof entry === 'string' ? { name: entry } : entry || {};
  session.startSession({ ...record, name: normaliseName(record.name) });
}

function handleContinue() {
  clearGameOverTimer();
  if (session.isComplete) session.finishSession();
  else session.continueSession();
}

function handleFlap() {
  /* Challenge Mode runs while SessionMachine sits at ATTRACT, so it has to be
     checked before any session state is. */
  if (challenge.active) {
    if (challenge.isRunning && world.isAlive) world.flap();
    // Taps on the brief, the countdown and the result must never fly.
    return;
  }

  if (session.state === STATE.READY) {
    // The tap that dismisses "TAP TO FLY" is also the first flap.
    if (session.beginAttempt()) {
      world.start();
      // Recorded from here so this attempt can be challenged if it makes the
      // board. world.start() performs the opening pop itself, so it is not
      // recorded - the replay reproduces it for free.
      recorder.begin(world.seed, session.characterId);
      renderer.noteFlap();
      // "Tap to fly" is what starts the music, and every attempt gets it from
      // the top. The element is always paused at 0 here - a crash rewinds it -
      // so this never seeks a playing track.
      audio.startMusic({ restart: true });
      audio.play('flap');
    }
    return;
  }

  if (session.state === STATE.PLAYING && world.isAlive) {
    // Only a flap that actually moved the bird is recorded; one swallowed by
    // the cooldown changed nothing, so replaying it would be noise.
    if (world.flap()) recorder.recordFlap(world.steps);
  }
}

function handleToggleSound() {
  lastInputAt = Date.now();
  audio.unlock();
  const muted = audio.toggleMuted();
  screens.setSoundLabel(muted);
  // Unmuting mid-flight resumes the track; unmuting anywhere else stays quiet.
  if (!muted && session.state === STATE.PLAYING) audio.startMusic();
}

/* -------------------------------------------------------------------------- */
/* World events                                                               */
/* -------------------------------------------------------------------------- */

function handleWorldEvents(events) {
  for (const event of events) {
    switch (event) {
      case WORLD_EVENT.FLAP:
        renderer.noteFlap();
        audio.play('flap');
        break;

      case WORLD_EVENT.SCORE:
        audio.play('point');
        if (challenge.isRunning) challenge.setPlayerScore(world.score);
        else session.setLiveScore(world.score);
        renderer.burst(world.bird.x + 18, world.bird.y, '#ffd166', 8, 150);
        break;

      case WORLD_EVENT.CRASH:
        if (challenge.isRunning) handleChallengeCrash();
        else handleCrash();
        break;

      default:
        break;
    }
  }
}

/**
 * A crash is a one-shot transition. The World stops testing collisions the
 * moment it enters 'dying', and this timer is the only path to endAttempt, so
 * multiple collision frames cannot produce multiple game overs.
 */
function handleCrash() {
  /* Order matters: cut the music first so the lose sting lands in the silence
     it leaves behind. The sting fires here rather than on the ATTEMPT_OVER
     screen so it hits the instant the player loses; being ~2s long it is still
     playing as the panel appears, which ties the two together. */
  audio.stopMusic();
  audio.play('gameover');
  audio.play('hit');
  renderer.shake(0.35, 11);
  renderer.flash(0.12);
  renderer.burst(world.bird.x, world.bird.y, '#ef476f', 16, 260);

  clearGameOverTimer();
  const scoreAtCrash = world.score;

  /* Banked here rather than in the game-over timer so it lands in the same
     order as session.scores even if the timer is cancelled. */
  const recording = recorder.end(world.steps, scoreAtCrash);
  if (recording) attemptReplays.push(recording);

  /* Hold the game-over panel until the lose sound has finished, so the sting
     is never cut off and NEXT ATTEMPT cannot be pressed over the top of it.
     Derived from the clip's real duration rather than a fixed number, so
     swapping in a longer or shorter sound needs no code change. When there is
     no sound to wait for - muted, or no file installed - it falls straight
     back to the normal beat. */
  const stingMs = audio.durationMs('gameover');
  const holdMs = Math.max(RULES.crashToGameOverMs, stingMs);

  gameOverTimer = window.setTimeout(() => {
    gameOverTimer = 0;
    // Guard against a reset that happened while the timer was pending.
    if (session.state !== STATE.PLAYING) return;
    session.endAttempt(scoreAtCrash);
  }, holdMs);
}

function handleFrame() {
  if (challenge.isRunning) {
    challenge.setPlayerScore(world.score);
    screens.setVersus(challenge.standing());
    return;
  }
  if (session.state === STATE.PLAYING) {
    screens.setHudScore(world.score, true);
  }
}

/**
 * One fixed simulation step. The ghost advances here, immediately after the
 * live world, so the two share an identical clock: same dt, same order, every
 * step, on any hardware.
 */
function handleStep(dt) {
  if (!challenge.isRunning) return;
  /* Once the player crashes the scene freezes for the death animation, so the
     ghost freezes with it - otherwise it flies on through stopped pipes for
     the ~850ms the game-over hold lasts. */
  if (!world.isAlive) return;

  const ghostJustCrashed = challenge.step(dt);
  if (!ghostJustCrashed) return;

  /* The moment the duel becomes winnable. Given its own sound and burst
     because it is the single most important beat in a challenge - everything
     before it is a dead heat by construction. */
  const ghostBird = challenge.ghost.world.bird;
  renderer.burst(ghostBird.x, ghostBird.y, CHALLENGE.ghostTint, 14, 220);
  audio.play('hit');
  screens.toast(challenge.opponent.name + ' is down - keep flying!');
}

function clearGameOverTimer() {
  if (gameOverTimer) {
    clearTimeout(gameOverTimer);
    gameOverTimer = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Submission + results                                                       */
/* -------------------------------------------------------------------------- */

async function runSubmission() {
  const snapshot = session.snapshot();
  const token = ++submitToken;

  screens.render(snapshot);

  let result;
  try {
    result = await leaderboard.submit({
      sessionId: snapshot.sessionId,
      name: snapshot.playerName,
      score: snapshot.bestScore,
      attempts: snapshot.scores,
      replay: bestAttemptReplay(snapshot),
      /* For the hourly prize draw. The server writes these to the register
         only - they never enter the leaderboard store. */
      contact: snapshot.contact
    });
  } catch (err) {
    result = {
      ok: false,
      pending: false,
      rank: null,
      total: 0,
      entries: leaderboard.mergedBoard(),
      error: err.message
    };
  }

  // A new player may have started while the request was in flight; their
  // session must not be overwritten by this one's result.
  if (token !== submitToken || session.sessionId !== snapshot.sessionId) return;

  session.setResult({
    rank: result.rank,
    total: result.total,
    pending: Boolean(result.pending),
    ok: result.ok !== false
  });

  screens.renderResult(session.snapshot(), result, LEADERBOARD.displayLimit);

  if (result.ok !== false) audio.play('fanfare');
  else screens.toast(result.error || 'Leaderboard unavailable - score saved locally');

  refreshMiniBoard();
}

/** Re-renders the result screen after a refresh, without re-submitting. */
function showCachedResult() {
  const snapshot = session.snapshot();
  const cached = leaderboard.getCachedResult(snapshot.sessionId);
  const result = cached || {
    ok: snapshot.result ? snapshot.result.ok : false,
    pending: snapshot.result ? snapshot.result.pending : false,
    rank: snapshot.result ? snapshot.result.rank : null,
    total: snapshot.result ? snapshot.result.total : 0,
    entries: leaderboard.mergedBoard()
  };
  screens.render(snapshot);
  screens.renderResult(snapshot, result, LEADERBOARD.displayLimit);
}

async function refreshMiniBoard() {
  const board = await leaderboard.fetchTop();
  screens.renderMiniBoard(board.entries);
  if (!board.ok && board.entries.length === 0) {
    screens.toast('Leaderboard offline - scores are saved on this device');
  }
}

/* -------------------------------------------------------------------------- */
/* Reset + idle handling                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The single teardown path. Cancels pending timers, invalidates any in-flight
 * submission, wipes the session and puts a clean attract screen in front of the
 * next player.
 */
function resetToAttract() {
  clearGameOverTimer();
  clearChallenge();
  submitToken += 1;
  attemptReplays = [];
  world.reset();
  renderer.clearEffects();
  audio.stopMusic();
  session.reset();
  screens.unlockAll();
  screens.focusName();
  lastInputAt = Date.now();
  refreshMiniBoard();
}

function startIdleWatch() {
  // One interval for the whole app; no per-screen timers to leak.
  idleTimer = window.setInterval(() => {
    const idleFor = Date.now() - lastInputAt;
    if (idleFor < RULES.idleResetMs) return;

    /* A challenge parked on the brief or the result screen hands the stall
       back to the queue, exactly as the main game does. A challenge actually
       being flown is left alone. */
    if (challenge.active) {
      if (challenge.isRunning || challenge.phase === CHALLENGE_PHASE.COUNTDOWN) return;
      resetToAttract();
      screens.toast('Ready for the next player');
      return;
    }

    const state = session.state;
    const abandonable =
      state === STATE.SELECT ||
      state === STATE.READY ||
      state === STATE.ATTEMPT_OVER ||
      state === STATE.RESULT;
    if (!abandonable) return;

    resetToAttract();
    screens.toast('Ready for the next player');
  }, 1000);
}

window.addEventListener('pagehide', () => {
  clearGameOverTimer();
  clearInterval(idleTimer);
  engine.stop();
  input.detach();
  audio.destroy();
});

/* -------------------------------------------------------------------------- */
/* Challenge Mode                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Picks the recording that belongs to the score being submitted.
 *
 * Attempt recordings are pushed in play order, so they normally line up with
 * session.scores index for index. A session restored from a refresh can have a
 * banked score with no recording behind it, so the score is verified rather
 * than trusted: a mismatch sends no replay at all, and that row is simply not
 * challengeable. Better than offering a duel against the wrong run.
 */
function bestAttemptReplay(snapshot) {
  const scores = snapshot.scores;
  if (!scores.length || !attemptReplays.length) return null;

  const bestIndex = scores.indexOf(snapshot.bestScore);
  const recording = attemptReplays[bestIndex];
  if (!recording || recording.score !== snapshot.bestScore) return null;

  if (replayByteLength(recording) > CHALLENGE.maxReplayBytes) return null;
  return recording;
}

/** Opens the brief for a leaderboard row, fetching its recording first. */
async function handleChallenge(entry) {
  if (!entry || !entry.id) return;
  // Never let a duel start on top of a session in progress.
  if (session.sessionId && session.state !== STATE.ATTRACT) {
    screens.toast('Finish your session first');
    return;
  }

  screens.toast('Loading ' + (entry.name || 'that run') + '...');
  const response = await leaderboard.fetchReplay(entry.id);

  if (!response.ok) {
    screens.toast(response.error || 'That run cannot be challenged');
    return;
  }

  const replay = decodeReplay(response.replay);
  if (!replay) {
    screens.toast('That recording is unreadable - pick another rival');
    return;
  }

  // The server's copy of the row is authoritative for the name and score.
  const opponent = response.entry || entry;
  if (!challenge.open(opponent, replay)) {
    screens.toast('That run cannot be challenged');
    return;
  }

  await applyGhostVariant(challenge.ghostCharacterId);
  screens.renderChallengeBrief(
    opponent,
    getVariant(challenge.ghostCharacterId),
    activeVariant,
    ''
  );
}

/** Brief -> countdown -> flying. */
async function handleChallengeStart(rawName) {
  if (challenge.phase !== CHALLENGE_PHASE.BRIEF) return;

  const name = normaliseName(rawName);
  if (!rawName || !String(rawName).trim()) {
    screens.showChallengeError('Enter your name first');
    return;
  }
  if (challenge.isSelfChallenge(name)) {
    screens.showChallengeError('That is you - pick a different rival');
    return;
  }

  screens.showChallengeError('');
  challenge.setPlayerName(name);
  audio.unlock();

  if (!challenge.beginCountdown()) return;
  screens.setVersusIdentity(name, challenge.opponent.name);

  cancelCountdown = screens.runCountdown(() => {
    cancelCountdown = null;
    beginChallengeRun();
  });
}

function beginChallengeRun() {
  const seed = challenge.beginRun();
  if (seed == null) return;

  /* The same seed the recording used, so both birds face identical pipes.
     That is what makes the comparison meaningful rather than decorative. */
  world.start(seed);
  renderer.noteFlap();
  renderer.setGhostWorld(challenge.ghost.world);
  audio.startMusic({ restart: true });
  audio.play('flap');

  screens.setScreen('challengePlaying');
  screens.setVersus(challenge.standing());
}

function handleChallengeCrash() {
  audio.stopMusic();
  audio.play('gameover');
  audio.play('hit');
  renderer.shake(0.35, 11);
  renderer.flash(0.12);
  renderer.burst(world.bird.x, world.bird.y, '#ef476f', 16, 260);

  const scoreAtCrash = world.score;
  clearGameOverTimer();

  const holdMs = Math.max(RULES.crashToGameOverMs, audio.durationMs('gameover'));
  gameOverTimer = window.setTimeout(() => {
    gameOverTimer = 0;
    if (!challenge.isRunning) return;

    const result = challenge.finish(scoreAtCrash);
    // The ghost stops competing for attention once the duel is decided.
    renderer.setGhostWorld(null);
    screens.renderChallengeResult(result);
    if (result.verdict === 'won') audio.play('fanfare');
  }, holdMs);
}

/** Same opponent, same seed, clean slate. */
async function handleRematch() {
  if (!challenge.rematch()) return;
  world.reset();
  renderer.clearEffects();
  renderer.setGhostWorld(null);
  screens.renderChallengeBrief(
    challenge.opponent,
    getVariant(challenge.ghostCharacterId),
    activeVariant,
    challenge.playerName
  );
}

/** Leaves Challenge Mode from anywhere and returns to the attract screen. */
function exitChallenge() {
  resetToAttract();
}

/** Tears down everything a challenge owns. Safe to call when none is running. */
function clearChallenge() {
  if (cancelCountdown) {
    cancelCountdown();
    cancelCountdown = null;
  }
  challenge.cancel();
  renderer.setGhostWorld(null);
  renderer.setGhostCharacter(null, null);
}

/** Loads the artwork the ghost wears - the character its player actually used. */
async function applyGhostVariant(id) {
  const variant = getVariant(id);
  if (!characterImages.has(variant.id)) {
    const { image } = await loadCharacter(variant.character);
    characterImages.set(variant.id, image);
  }
  renderer.setGhostCharacter(characterImages.get(variant.id), variant.character);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function normaliseName(raw) {
  const cleaned = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RULES.maxNameLength);
  return cleaned || 'PLAYER';
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  screens.toast('Something went wrong loading the game - please refresh.');
});

// Exposed purely for quick diagnostics from the console at the event.
window.flappyFest = {
  world,
  session,
  leaderboard,
  audio,
  renderer,
  engine,
  challenge,
  recorder,
  /** Opens a challenge by leaderboard entry id, for console diagnostics. */
  handleChallengeById: (id) => handleChallenge({ id, name: '', score: 0 }),
  get attemptReplays() {
    return attemptReplays;
  },
  VIEW,
  get variant() {
    return activeVariant;
  }
};
