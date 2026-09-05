/**
 * Challenge Mode - the rules of a head-to-head against a recorded run.
 *
 * Deliberately kept out of SessionMachine. A challenge is a single exhibition
 * attempt that neither consumes one of the three leaderboard attempts nor
 * posts a score, so none of the "best of three" invariants have to grow a
 * special case. SessionMachine sits at ATTRACT for the whole challenge and is
 * never touched.
 *
 * Like World and SessionMachine, this module is pure logic: no DOM, no audio,
 * no canvas. main.js wires it to the screens and the engine.
 *
 * THE SHAPE OF THE CONTEST
 * ------------------------
 * Both runs use the opponent's seed, so the pipes are identical and the bird's
 * x is fixed. That has a consequence worth designing around: while both are
 * alive they have necessarily passed the same pipes, so their scores are
 * always equal. The scores can only separate when somebody dies.
 *
 * So the contest is not a running score gap - it is "survive past the pipe
 * they died on". The standing reflects that:
 *
 *   chasing  ghost still flying, dead level with you
 *   clear    ghost is down; you need N more to pass their final score
 *   level    you have matched their score and are still alive
 *   ahead    you are past them, and every pipe extends the lead
 */

import { CHALLENGE } from '../config.js';
import { VARIANTS, DEFAULT_VARIANT } from '../assets/manifest.js';
import { GhostRunner } from './replay.js';

export const CHALLENGE_PHASE = Object.freeze({
  IDLE: 'idle',
  BRIEF: 'brief',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULT: 'result'
});

export const VERDICT = Object.freeze({
  WON: 'won',
  LOST: 'lost',
  TIED: 'tied'
});

export const STANDING = Object.freeze({
  CHASING: 'chasing',
  CLEAR: 'clear',
  LEVEL: 'level',
  AHEAD: 'ahead'
});

export class ChallengeController {
  constructor({ storage = safeStorage() } = {}) {
    this.storage = storage;
    this.phase = CHALLENGE_PHASE.IDLE;
    this.opponent = null;
    this.replay = null;
    this.ghost = null;
    this.playerName = '';
    this.playerScore = 0;
    this.result = null;
  }

  get active() {
    return this.phase !== CHALLENGE_PHASE.IDLE;
  }

  /** True once the player is actually flying (not the brief or countdown). */
  get isRunning() {
    return this.phase === CHALLENGE_PHASE.PLAYING;
  }

  /** The character the challenged player used - the ghost wears their face. */
  get ghostCharacterId() {
    if (this.replay && VARIANTS[this.replay.characterId]) return this.replay.characterId;
    return DEFAULT_VARIANT;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Opens the confirmation screen for a challenge.
   *
   * `opponent` is the leaderboard entry; `replay` must already be decoded and
   * validated by replay.js. Refusing here rather than mid-run is deliberate:
   * an un-runnable challenge should never reach the countdown.
   */
  open(opponent, replay) {
    if (!opponent || !replay) return false;
    this.phase = CHALLENGE_PHASE.BRIEF;
    this.opponent = {
      id: String(opponent.id || ''),
      name: String(opponent.name || 'PLAYER'),
      score: Math.max(0, Math.floor(Number(opponent.score)) || 0),
      characterId: replay.characterId
    };
    this.replay = replay;
    this.ghost = null;
    this.playerScore = 0;
    this.result = null;
    return true;
  }

  /**
   * Rejects a self-challenge.
   *
   * Name-based rather than id-based on purpose: the challenger has not
   * submitted anything yet, so there is no id to compare. At a stall where
   * people type their own name this is the check that actually bites.
   */
  isSelfChallenge(name) {
    if (!this.opponent) return false;
    return normaliseName(name) === normaliseName(this.opponent.name);
  }

  setPlayerName(name) {
    this.playerName = String(name || '').trim().slice(0, 24) || 'YOU';
  }

  /** Brief -> countdown. The ghost is built here so the first step is cheap. */
  beginCountdown() {
    if (this.phase !== CHALLENGE_PHASE.BRIEF) return false;
    this.ghost = new GhostRunner(this.replay);
    this.playerScore = 0;
    this.phase = CHALLENGE_PHASE.COUNTDOWN;
    return true;
  }

  /**
   * Countdown -> playing. Returns the seed the live world must start with, so
   * both birds face the same pipes.
   */
  beginRun() {
    if (this.phase !== CHALLENGE_PHASE.COUNTDOWN) return null;
    if (this.ghost) this.ghost.reset();
    this.playerScore = 0;
    this.phase = CHALLENGE_PHASE.PLAYING;
    return this.replay.seed;
  }

  /**
   * Advances the ghost by one fixed step. Called from the same loop that steps
   * the live world, immediately after it, so the two never drift.
   */
  step(dt) {
    if (this.phase !== CHALLENGE_PHASE.PLAYING || !this.ghost) return false;
    this.ghost.step(dt);
    // Reported so the UI can mark the moment the lead becomes winnable.
    return this.ghost.justCrashed;
  }

  setPlayerScore(score) {
    this.playerScore = Math.max(0, Math.floor(score) || 0);
  }

  /* ------------------------------------------------------------------ */
  /* Live standing                                                       */
  /* ------------------------------------------------------------------ */

  /** Everything the in-play HUD needs, computed in one place. */
  standing() {
    const target = this.opponent ? this.opponent.score : 0;
    const mine = this.playerScore;
    const ghostAlive = Boolean(this.ghost && this.ghost.isAlive);
    const diff = mine - target;

    let state;
    if (diff > 0) state = STANDING.AHEAD;
    else if (diff === 0 && !ghostAlive) state = STANDING.LEVEL;
    else if (ghostAlive) state = STANDING.CHASING;
    else state = STANDING.CLEAR;

    return {
      mine,
      target,
      diff,
      needed: Math.max(0, target - mine + 1),
      ghostAlive,
      ghostScore: this.ghost ? this.ghost.score : 0,
      state,
      opponentName: this.opponent ? this.opponent.name : ''
    };
  }

  /* ------------------------------------------------------------------ */
  /* Result                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Ends the challenge and works out the verdict.
   *
   * A tie is explicitly NOT a win: the goal stated on the brief screen is to
   * beat the opponent, so matching them has to read as its own outcome rather
   * than being quietly rounded up.
   */
  finish(playerScore) {
    if (this.phase !== CHALLENGE_PHASE.PLAYING) return this.result;

    this.setPlayerScore(playerScore);
    const target = this.opponent ? this.opponent.score : 0;
    const mine = this.playerScore;

    let verdict;
    if (mine > target) verdict = VERDICT.WON;
    else if (mine === target) verdict = VERDICT.TIED;
    else verdict = VERDICT.LOST;

    const previousBest = this.readPersonalBest(this.playerName);
    const personalBest = mine > previousBest;
    if (personalBest) this.writePersonalBest(this.playerName, mine);

    this.result = {
      verdict,
      mine,
      target,
      margin: mine - target,
      opponentName: this.opponent ? this.opponent.name : '',
      personalBest,
      previousBest
    };
    this.phase = CHALLENGE_PHASE.RESULT;
    return this.result;
  }

  /** Same opponent, same seed, clean slate. */
  rematch() {
    if (this.phase !== CHALLENGE_PHASE.RESULT) return false;
    this.phase = CHALLENGE_PHASE.BRIEF;
    this.playerScore = 0;
    this.result = null;
    this.ghost = null;
    return true;
  }

  /** Abandon from anywhere - quitting mid-run records nothing. */
  cancel() {
    this.phase = CHALLENGE_PHASE.IDLE;
    this.opponent = null;
    this.replay = null;
    this.ghost = null;
    this.playerScore = 0;
    this.result = null;
  }

  /* ------------------------------------------------------------------ */
  /* Personal bests                                                      */
  /* ------------------------------------------------------------------ */

  /* Kept on the device rather than the server: a challenge score is not a
     leaderboard score, and the stall laptop is the same machine every time. */

  readAll() {
    if (!this.storage) return {};
    try {
      const raw = this.storage.getItem(CHALLENGE.personalBestKey);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  readPersonalBest(name) {
    const key = normaliseName(name);
    if (!key) return 0;
    const value = Number(this.readAll()[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  writePersonalBest(name, score) {
    if (!this.storage) return;
    const key = normaliseName(name);
    if (!key) return;
    try {
      const all = this.readAll();
      all[key] = Math.max(0, Math.floor(score) || 0);
      this.storage.setItem(CHALLENGE.personalBestKey, JSON.stringify(all));
    } catch {
      /* private mode or full quota - personal bests just will not persist */
    }
  }
}

function normaliseName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toUpperCase();
}

function safeStorage() {
  try {
    const probe = '__ff_challenge_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}
