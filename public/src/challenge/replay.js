/**
 * Replay recording and ghost playback.
 *
 * WHY THIS IS SO SMALL
 * --------------------
 * World is deterministic: given a seed and the same flaps at the same fixed
 * step indices it reproduces a run exactly (see the note at the top of
 * world.js). So a "recording" is not a stream of positions - it is a seed plus
 * the step numbers on which the player flapped. A 40 second run is roughly 150
 * numbers, a few hundred bytes once delta encoded, against tens of kilobytes
 * for sampled positions.
 *
 * It also means a ghost is not an animation. It is the same simulation class
 * the live player is running, fed recorded input, which is why it collides with
 * pipes and dies in exactly the place the original player did.
 *
 * Because the challenger plays the opponent's seed, both worlds lay out
 * identical pipes - so the two runs are directly comparable, and the renderer
 * only ever draws one set of pipes.
 */

import { World } from '../game/world.js';
import { VARIANTS, DEFAULT_VARIANT } from '../assets/manifest.js';

export const REPLAY_VERSION = 1;

/** A hostile or corrupt replay must never be able to hang the browser. */
const MAX_FLAPS = 20000;
const MAX_STEPS = 120 * 60 * 12; // 12 minutes of simulation
/** Once the recording is exhausted the ghost is given this long to finish its
 *  death fall before it is considered done. */
const GHOST_TAIL_STEPS = 300;

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Records one attempt.
 *
 * Only SUCCESSFUL flaps are recorded - a tap swallowed by the flap cooldown
 * changed nothing in the world, so replaying it would be noise. The opening
 * pop is not recorded either: World.start() performs it itself, so the ghost
 * reproduces it for free.
 */
export class ReplayRecorder {
  constructor() {
    this.active = false;
    this.seed = 0;
    this.characterId = DEFAULT_VARIANT;
    this.flaps = [];
    this.steps = 0;
    this.score = 0;
  }

  /** Called immediately after world.start(). */
  begin(seed, characterId) {
    this.active = true;
    this.seed = seed >>> 0;
    this.characterId = VARIANTS[characterId] ? characterId : DEFAULT_VARIANT;
    this.flaps = [];
    this.steps = 0;
    this.score = 0;
  }

  /** Called only when world.flap() returned true, with the world's step count. */
  recordFlap(step) {
    if (!this.active) return;
    if (this.flaps.length >= MAX_FLAPS) return;
    this.flaps.push(step);
  }

  /** Called when the attempt ends, with the world's final step count/score. */
  end(steps, score) {
    if (!this.active) return null;
    this.active = false;
    this.steps = steps;
    this.score = score;
    return this.toData();
  }

  toData() {
    return {
      v: REPLAY_VERSION,
      seed: this.seed,
      characterId: this.characterId,
      steps: this.steps,
      score: this.score,
      flaps: encodeFlaps(this.flaps)
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Wire format                                                                */
/* -------------------------------------------------------------------------- */

/** Absolute step indices -> gaps between them, which are far smaller numbers. */
function encodeFlaps(steps) {
  const out = [];
  let previous = 0;
  for (const step of steps) {
    out.push(step - previous);
    previous = step;
  }
  return out;
}

function decodeFlaps(deltas) {
  const out = [];
  let accumulated = 0;
  for (const delta of deltas) {
    const value = Math.floor(Number(delta));
    // A negative gap would rewind the clock and desynchronise the ghost.
    if (!Number.isFinite(value) || value < 0) continue;
    accumulated += value;
    if (accumulated > MAX_STEPS) break;
    out.push(accumulated);
    if (out.length >= MAX_FLAPS) break;
  }
  return out;
}

/**
 * Validates and normalises a replay that arrived over the network.
 *
 * Returns null for anything unusable, so a bad record degrades to "this player
 * cannot be challenged" rather than to a broken game.
 */
export function decodeReplay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.v) !== REPLAY_VERSION) return null;

  const seed = Number(raw.seed);
  if (!Number.isFinite(seed)) return null;

  const steps = Math.floor(Number(raw.steps));
  if (!Number.isFinite(steps) || steps <= 0 || steps > MAX_STEPS) return null;

  if (!Array.isArray(raw.flaps)) return null;
  const flaps = decodeFlaps(raw.flaps);

  const score = Math.max(0, Math.floor(Number(raw.score)) || 0);
  const characterId = VARIANTS[raw.characterId] ? raw.characterId : DEFAULT_VARIANT;

  return { v: REPLAY_VERSION, seed: seed >>> 0, characterId, steps, score, flaps };
}

/** Rough byte cost, used to keep a submission inside the server's body cap. */
export function replayByteLength(data) {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length;
  } catch {
    return JSON.stringify(data).length;
  }
}

/* -------------------------------------------------------------------------- */
/* Playback                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Drives a second World from a recording.
 *
 * This runs the real simulation rather than interpolating stored positions, so
 * the ghost obeys the same gravity and dies on the same pipe. It is stepped in
 * lockstep with the live world (same dt, same order), which is what keeps the
 * two in sync without any drift correction.
 */
export class GhostRunner {
  constructor(replay) {
    this.replay = replay;
    this.world = new World();
    this.cursor = 0;
    this.finished = false;
    /** Step at which the recorded run crashed - the moment the lead opens up. */
    this.crashStep = 0;
    this.justCrashed = false;
    this.reset();
  }

  reset() {
    this.world.start(this.replay.seed);
    this.cursor = 0;
    this.finished = false;
    this.crashStep = 0;
    this.justCrashed = false;
  }

  /** One fixed step, called from the same loop that steps the live world. */
  step(dt) {
    this.justCrashed = false;
    if (this.finished) return;

    const wasAlive = this.world.mode === 'running';

    // Apply every flap due on or before this step. "<=" rather than "===" so a
    // recording that somehow skipped a step still lands its input.
    const flaps = this.replay.flaps;
    while (this.cursor < flaps.length && flaps[this.cursor] <= this.world.steps) {
      this.world.flap();
      this.cursor += 1;
    }

    this.world.update(dt);

    if (wasAlive && this.world.mode !== 'running') {
      this.crashStep = this.world.steps;
      this.justCrashed = true;
    }

    // Done once the bird has settled, or once the recording has run out with a
    // little slack for the fall.
    if (this.world.mode === 'dead') this.finished = true;
    else if (this.cursor >= flaps.length && this.world.steps > this.replay.steps + GHOST_TAIL_STEPS) {
      this.finished = true;
    }
  }

  get score() {
    return this.world.score;
  }

  get isAlive() {
    return this.world.mode === 'running';
  }

  /** The score the recording ended on - the number the challenger must beat. */
  get finalScore() {
    return this.replay.score;
  }
}
