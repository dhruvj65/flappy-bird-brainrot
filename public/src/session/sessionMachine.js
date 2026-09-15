/**
 * Session state machine - the rule keeper for "exactly three attempts".
 *
 * Every state change goes through transition(), which refuses anything not in
 * the TRANSITIONS table. There are no loose booleans deciding whether a player
 * may play again: the answer is always derived from scores.length, which is
 * append-only and capped at RULES.attemptsPerSession.
 *
 * Invariants enforced here:
 *   - attempts used can only ever increase, never past 3, never below 0
 *   - a fourth attempt is unreachable: continueSession() refuses it and
 *     beginAttempt() refuses it independently
 *   - the session score is MAX(attempt scores), computed in one place
 *   - a session can be submitted at most once (submission status is part of
 *     the state, not a flag somebody can forget to check)
 *   - the whole session survives an accidental refresh via localStorage, so a
 *     refresh cannot mint fresh attempts
 *   - the character is chosen before each attempt, so `characterId` tracks the
 *     attempt in progress rather than the session
 */

import { RULES, STORAGE } from '../config.js';
import { DEFAULT_VARIANT, VARIANTS } from '../assets/manifest.js';

export const STATE = Object.freeze({
  ATTRACT: 'attract',
  SELECT: 'select',
  READY: 'ready',
  PLAYING: 'playing',
  ATTEMPT_OVER: 'attemptOver',
  SUBMITTING: 'submitting',
  RESULT: 'result'
});

const TRANSITIONS = Object.freeze({
  [STATE.ATTRACT]: [STATE.SELECT],
  [STATE.SELECT]: [STATE.READY, STATE.ATTRACT],
  [STATE.READY]: [STATE.PLAYING, STATE.ATTRACT],
  [STATE.PLAYING]: [STATE.ATTEMPT_OVER, STATE.ATTRACT],
  [STATE.ATTEMPT_OVER]: [STATE.SELECT, STATE.SUBMITTING, STATE.ATTRACT],
  [STATE.SUBMITTING]: [STATE.RESULT, STATE.ATTRACT],
  [STATE.RESULT]: [STATE.ATTRACT]
});

const PERSIST_VERSION = 1;

export class SessionMachine {
  constructor(storage = safeStorage()) {
    this.storage = storage;
    this.listeners = new Set();
    this.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Derived state                                                       */
  /* ------------------------------------------------------------------ */

  get attemptsUsed() {
    return this.scores.length;
  }

  get attemptsRemaining() {
    return Math.max(0, RULES.attemptsPerSession - this.attemptsUsed);
  }

  /** 1-based number of the attempt now being played or about to be played. */
  get attemptNumber() {
    return Math.min(RULES.attemptsPerSession, this.attemptsUsed + 1);
  }

  get isComplete() {
    return this.attemptsUsed >= RULES.attemptsPerSession;
  }

  get bestScore() {
    return this.scores.length ? Math.max.apply(null, this.scores) : 0;
  }

  get lastScore() {
    return this.scores.length ? this.scores[this.scores.length - 1] : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  on(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  emit() {
    const snapshot = this.snapshot();
    for (const handler of this.listeners) handler(snapshot);
  }

  snapshot() {
    return {
      state: this.state,
      sessionId: this.sessionId,
      playerName: this.playerName,
      contact: { ...this.contact },
      characterId: this.characterId,
      scores: this.scores.slice(),
      liveScore: this.liveScore,
      attemptNumber: this.attemptNumber,
      attemptsUsed: this.attemptsUsed,
      attemptsRemaining: this.attemptsRemaining,
      bestScore: this.bestScore,
      lastScore: this.lastScore,
      isComplete: this.isComplete,
      result: this.result,
      restored: this.restored
    };
  }

  /* ------------------------------------------------------------------ */
  /* Transitions                                                         */
  /* ------------------------------------------------------------------ */

  can(next) {
    const allowed = TRANSITIONS[this.state];
    return Boolean(allowed && allowed.includes(next));
  }

  transition(next) {
    if (!this.can(next)) return false;
    this.state = next;
    this.persist();
    this.emit();
    return true;
  }

  clear() {
    this.state = STATE.ATTRACT;
    this.sessionId = null;
    this.playerName = '';
    /* Prize-draw contact details. Carried through the session so a submission
       can register the player, and deliberately never shown on any screen or
       returned by any leaderboard call. */
    this.contact = { bitsId: '', phone: '', dialCode: '' };
    this.characterId = DEFAULT_VARIANT;
    this.scores = [];
    this.liveScore = 0;
    this.result = null;
    this.startedAt = 0;
    this.restored = false;
  }

  /** Starts a brand new player session. Always safe to call. */
  /**
   * Starts a player session.
   *
   * `entry` is the validated form record: { name, bitsId, phone, dialCode }.
   * A bare string is still accepted so nothing that only knows about names
   * has to change.
   */
  startSession(entry) {
    const record = typeof entry === 'string' ? { name: entry } : entry || {};
    this.clear();
    this.sessionId = createId();
    this.playerName =
      String(record.name || '').trim().slice(0, RULES.maxNameLength) || 'PLAYER';
    this.contact = {
      bitsId: String(record.bitsId || ''),
      phone: String(record.phone || ''),
      dialCode: String(record.dialCode || '')
    };
    this.startedAt = Date.now();
    this.state = STATE.ATTRACT;
    this.transition(STATE.SELECT);
    return this.sessionId;
  }

  /**
   * Sets the character for the attempt about to be played, then moves to the
   * "tap to fly" screen. Called before every attempt, not once per session.
   */
  chooseCharacter(id) {
    if (this.state !== STATE.SELECT) return false;
    this.characterId = VARIANTS[id] ? id : DEFAULT_VARIANT;
    return this.transition(STATE.READY);
  }

  beginAttempt() {
    if (this.isComplete) return false;
    this.liveScore = 0;
    return this.transition(STATE.PLAYING);
  }

  /** Called while playing so a refresh mid-attempt keeps the score earned. */
  setLiveScore(score) {
    if (this.state !== STATE.PLAYING) return;
    const value = Math.max(0, Math.floor(score) || 0);
    if (value === this.liveScore) return;
    this.liveScore = value;
    this.persist();
  }

  /**
   * Records the finished attempt. The score cap is enforced here as well as in
   * beginAttempt, so even a stray call cannot append a fourth score.
   */
  endAttempt(score) {
    if (this.state !== STATE.PLAYING) return false;
    if (this.scores.length >= RULES.attemptsPerSession) return false;
    this.scores.push(Math.max(0, Math.floor(score) || 0));
    this.liveScore = 0;
    return this.transition(STATE.ATTEMPT_OVER);
  }

  /**
   * Move on to the next attempt. Refuses once three attempts are used.
   *
   * This goes back to the character picker rather than straight to "tap to
   * fly": the player chooses again before every attempt, so a session can mix
   * characters. The three scores are still compared as one best-of-three.
   */
  continueSession() {
    if (this.isComplete) return false;
    return this.transition(STATE.SELECT);
  }

  /** Move to submission. Refuses unless all three attempts are used. */
  finishSession() {
    if (!this.isComplete) return false;
    return this.transition(STATE.SUBMITTING);
  }

  setResult(result) {
    this.result = result || null;
    return this.transition(STATE.RESULT);
  }

  /** Ends whatever was happening and returns to the attract loop. */
  reset() {
    this.clear();
    this.wipe();
    this.emit();
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  persist() {
    if (!this.storage) return;
    if (!this.sessionId || this.state === STATE.ATTRACT) {
      this.wipe();
      return;
    }
    try {
      this.storage.setItem(
        STORAGE.sessionKey,
        JSON.stringify({
          v: PERSIST_VERSION,
          sessionId: this.sessionId,
          playerName: this.playerName,
          /* Kept so a refresh mid-session still submits a registrable entry.
             Wiped with the rest of the session on handover. */
          contact: this.contact,
          characterId: this.characterId,
          scores: this.scores,
          liveScore: this.liveScore,
          state: this.state,
          result: this.result,
          startedAt: this.startedAt,
          savedAt: Date.now()
        })
      );
    } catch {
      /* private mode / full quota - the session just will not survive a refresh */
    }
  }

  wipe() {
    if (!this.storage) return;
    try {
      this.storage.removeItem(STORAGE.sessionKey);
    } catch {
      /* ignore */
    }
  }

  /**
   * Restores a session interrupted by a refresh.
   * A refresh during play is resolved as "that attempt ended with the score you
   * had reached" - it neither punishes the player with a lost attempt nor lets
   * anybody refresh their way out of a bad run.
   */
  restore() {
    if (!this.storage) return false;

    let raw;
    try {
      raw = this.storage.getItem(STORAGE.sessionKey);
    } catch {
      return false;
    }
    if (!raw) return false;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      this.wipe();
      return false;
    }

    const stale = !data || data.v !== PERSIST_VERSION || Date.now() - (data.savedAt || 0) > RULES.sessionTtlMs;
    if (stale || !data.sessionId || !Array.isArray(data.scores)) {
      this.wipe();
      return false;
    }

    this.sessionId = String(data.sessionId);
    this.playerName = String(data.playerName || 'PLAYER').slice(0, RULES.maxNameLength);
    const saved = data.contact && typeof data.contact === 'object' ? data.contact : {};
    this.contact = {
      bitsId: String(saved.bitsId || ''),
      phone: String(saved.phone || ''),
      dialCode: String(saved.dialCode || '')
    };
    this.characterId = VARIANTS[data.characterId] ? data.characterId : DEFAULT_VARIANT;
    this.scores = data.scores
      .slice(0, RULES.attemptsPerSession)
      .map((n) => Math.max(0, Math.floor(Number(n)) || 0));
    this.result = data.result || null;
    this.startedAt = Number(data.startedAt) || Date.now();
    this.liveScore = 0;
    this.restored = true;

    const savedState = data.state;

    if (savedState === STATE.PLAYING) {
      // Bank the in-progress attempt at the score reached, then continue.
      if (this.scores.length < RULES.attemptsPerSession) {
        this.scores.push(Math.max(0, Math.floor(Number(data.liveScore)) || 0));
      }
      this.state = STATE.ATTEMPT_OVER;
    } else if (savedState === STATE.SUBMITTING) {
      // The refresh landed mid-submit. Re-submitting is safe: the server is
      // idempotent on sessionId, so it returns the original entry and rank.
      this.state = STATE.SUBMITTING;
    } else if (TRANSITIONS[savedState]) {
      this.state = savedState;
    } else {
      this.wipe();
      this.clear();
      return false;
    }

    // A restored READY state means the player never actually started; treat the
    // preceding game-over screen as the resume point when attempts remain.
    if (this.state === STATE.READY && this.scores.length > 0) this.state = STATE.ATTEMPT_OVER;

    /* A refresh on the picker before the first attempt has nothing worth
       resuming. Between attempts it very much does - those banked scores are
       the player's, and dropping them would silently hand back attempts. */
    if (this.state === STATE.SELECT && this.scores.length === 0) {
      this.wipe();
      this.clear();
      return false;
    }

    this.persist();
    this.emit();
    return true;
  }
}

function createId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function safeStorage() {
  try {
    const probe = '__ff_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}
