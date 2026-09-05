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

import { RULES, LEADERBOARD, VIEW } from './config.js';
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
  onToggleSound: handleToggleSound
});

const engine = new Engine({
  world,
  renderer,
  onEvents: handleWorldEvents,
  onFrame: handleFrame
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

  refreshMiniBoard();
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

function handleStart(rawName) {
  clearGameOverTimer();
  /* Unlock here so the browser's autoplay gate is already open by the time the
     player taps to fly. The music itself does not start until that tap - the
     name-entry and "tap to fly" screens stay quiet. */
  audio.unlock();

  session.startSession(normaliseName(rawName));
}

function handleContinue() {
  clearGameOverTimer();
  if (session.isComplete) session.finishSession();
  else session.continueSession();
}

function handleFlap() {
  if (session.state === STATE.READY) {
    // The tap that dismisses "TAP TO FLY" is also the first flap.
    if (session.beginAttempt()) {
      world.start();
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
    world.flap();
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
        session.setLiveScore(world.score);
        renderer.burst(world.bird.x + 18, world.bird.y, '#ffd166', 8, 150);
        break;

      case WORLD_EVENT.CRASH:
        handleCrash();
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
  if (session.state === STATE.PLAYING) {
    screens.setHudScore(world.score, true);
  }
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
      attempts: snapshot.scores
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
  submitToken += 1;
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
  VIEW,
  get variant() {
    return activeVariant;
  }
};
