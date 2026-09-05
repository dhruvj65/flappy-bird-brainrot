/**
 * World - the pure simulation.
 *
 * No DOM, no canvas, no audio, no session knowledge. It advances state by a
 * fixed dt and reports what happened through a reused event array, so a full
 * day of play allocates nothing per frame.
 *
 * Modes: 'idle' -> 'running' -> 'dying' -> 'dead'
 * Collision is only tested in 'running', which is what makes a game over a
 * single event no matter how many frames the bird spends inside a pipe.
 */

import { VIEW, PHYSICS, PIPES } from '../config.js';

export const WORLD_EVENT = Object.freeze({
  FLAP: 'flap',
  SCORE: 'score',
  CRASH: 'crash',
  SETTLED: 'settled'
});

const FLOOR_Y = VIEW.height - VIEW.groundHeight;

export class World {
  constructor() {
    this.bird = { x: PHYSICS.birdX, y: 0, vy: 0, rotation: 0, flapTimer: 0 };

    // Fixed size pipe pool - recycled forever, never reallocated.
    this.pipes = [];
    for (let i = 0; i < PIPES.poolSize; i += 1) {
      this.pipes.push({ x: 0, gapY: 0, gapHalf: 0, scored: false, active: false });
    }

    this.events = [];
    this.reset();
  }

  reset() {
    this.mode = 'idle';
    this.score = 0;
    this.distance = 0;
    this.elapsed = 0;
    this.spawnCursor = 0;
    this.lastGapY = FLOOR_Y * 0.5;

    this.bird.y = FLOOR_Y * 0.42;
    this.bird.vy = 0;
    this.bird.rotation = 0;
    this.bird.flapTimer = 0;

    for (const pipe of this.pipes) pipe.active = false;
    this.events.length = 0;
  }

  /** Begins an attempt from a clean state. */
  start() {
    this.reset();
    this.mode = 'running';
    // The first pipe sits comfortably off screen so nobody dies before they
    // have understood which way is up.
    this.spawnCursor = VIEW.width + 200;
    // Opening pop upward. The FLAP event it queues is consumed by the caller
    // that started the attempt, so the sound plays exactly once.
    this.flap();
  }

  get speed() {
    return Math.min(PIPES.maxSpeed, PIPES.baseSpeed + this.score * PIPES.speedPerPoint);
  }

  get gapHeight() {
    return Math.max(PIPES.minGap, PIPES.baseGap + this.score * PIPES.gapPerPoint);
  }

  /** Distance to the next pipe, derived from the current speed so the time
   *  between pipes - and therefore the climb the player must manage - stays
   *  constant however fast the run gets. */
  get pipeSpacing() {
    return this.speed * PIPES.intervalSeconds;
  }

  get isAlive() {
    return this.mode === 'running';
  }

  flap() {
    if (this.mode !== 'running') return false;
    if (this.bird.flapTimer > 0) return false;
    this.bird.vy = PHYSICS.flapVelocity;
    this.bird.flapTimer = PHYSICS.flapCooldown;
    this.events.push(WORLD_EVENT.FLAP);
    return true;
  }

  spawnPipe(x) {
    const pipe = this.pipes.find((p) => !p.active);
    if (!pipe) return null;

    const gapHalf = this.gapHeight / 2;
    const minCenter = PIPES.minTopMargin + gapHalf;
    const maxCenter = FLOOR_Y - PIPES.minBottomMargin - gapHalf;

    // Keep each gap within reach of the previous one so every pipe is
    // survivable with a normal climb rate.
    const low = Math.max(minCenter, this.lastGapY - PIPES.maxCenterDelta);
    const high = Math.min(maxCenter, this.lastGapY + PIPES.maxCenterDelta);

    pipe.x = x;
    pipe.gapY = low + Math.random() * Math.max(0, high - low);
    this.lastGapY = pipe.gapY;
    pipe.gapHalf = gapHalf;
    pipe.scored = false;
    pipe.active = true;
    return pipe;
  }

  /**
   * Advances the simulation by dt seconds. Events for this step are left in
   * this.events for the caller to drain.
   */
  update(dt) {
    if (this.mode === 'idle') {
      // Keep the attract screen alive: scenery drifts, nothing else moves.
      this.events.length = 0;
      this.distance += PIPES.baseSpeed * 0.3 * dt;
      this.elapsed += dt;
      return this.events;
    }

    this.events.length = 0;
    if (this.mode === 'dead') return this.events;

    this.elapsed += dt;

    const bird = this.bird;
    if (bird.flapTimer > 0) bird.flapTimer = Math.max(0, bird.flapTimer - dt);

    bird.vy = Math.min(PHYSICS.maxFallSpeed, bird.vy + PHYSICS.gravity * dt);
    bird.y += bird.vy * dt;

    const targetRotation =
      bird.vy < 0
        ? PHYSICS.maxRotationUp
        : Math.min(PHYSICS.maxRotationDown, (bird.vy / PHYSICS.maxFallSpeed) * PHYSICS.maxRotationDown);
    bird.rotation += (targetRotation - bird.rotation) * Math.min(1, PHYSICS.rotationLerp * dt);

    if (this.mode === 'dying') {
      // Pipes freeze; the bird finishes its fall so the crash reads clearly.
      if (bird.y + PHYSICS.birdRadius >= FLOOR_Y) {
        bird.y = FLOOR_Y - PHYSICS.birdRadius;
        bird.vy = 0;
        this.mode = 'dead';
        this.events.push(WORLD_EVENT.SETTLED);
      }
      return this.events;
    }

    const step = this.speed * dt;
    this.distance += step;
    this.spawnCursor -= step;

    for (const pipe of this.pipes) {
      if (!pipe.active) continue;
      pipe.x -= step;

      if (!pipe.scored && pipe.x + PIPES.width < bird.x - PHYSICS.birdRadius) {
        pipe.scored = true;
        this.score += 1;
        this.events.push(WORLD_EVENT.SCORE);
      }

      if (pipe.x + PIPES.width < -40) pipe.active = false;
    }

    // spawnCursor rides along with the pipes; when it reaches the right edge a
    // new pair is placed exactly there, keeping spacing constant at any speed.
    // Spawn while the cursor is still off screen so a pipe never pops into
    // existence inside the visible field.
    while (this.spawnCursor <= VIEW.width + PIPES.width) {
      this.spawnPipe(this.spawnCursor);
      this.spawnCursor += this.pipeSpacing;
    }

    // Ceiling: bounce the player back rather than instantly killing them, which
    // is far friendlier for a first time player at a stall.
    if (bird.y - PHYSICS.birdRadius < 0) {
      bird.y = PHYSICS.birdRadius;
      if (bird.vy < 0) bird.vy = 0;
    }

    if (this.checkCollisions()) this.kill();

    return this.events;
  }

  checkCollisions() {
    const bird = this.bird;
    const r = PHYSICS.birdRadius;

    if (bird.y + r >= FLOOR_Y) return true;

    for (const pipe of this.pipes) {
      if (!pipe.active) continue;
      // Cheap horizontal reject first - most pipes are nowhere near the bird.
      if (pipe.x > bird.x + r || pipe.x + PIPES.width < bird.x - r) continue;

      const gapTop = pipe.gapY - pipe.gapHalf;
      const gapBottom = pipe.gapY + pipe.gapHalf;
      if (circleHitsRect(bird.x, bird.y, r, pipe.x, 0, PIPES.width, gapTop)) return true;
      if (circleHitsRect(bird.x, bird.y, r, pipe.x, gapBottom, PIPES.width, FLOOR_Y - gapBottom)) return true;
    }

    return false;
  }

  /** Single transition into the death sequence; repeated calls are ignored. */
  kill() {
    if (this.mode !== 'running') return false;
    this.mode = 'dying';
    if (this.bird.vy < 0) this.bird.vy = 0;
    this.events.push(WORLD_EVENT.CRASH);
    return true;
  }

  /** Read-only snapshot for the renderer/HUD. Allocation free. */
  get activePipes() {
    return this.pipes;
  }
}

function circleHitsRect(cx, cy, r, rx, ry, rw, rh) {
  const nearestX = cx < rx ? rx : cx > rx + rw ? rx + rw : cx;
  const nearestY = cy < ry ? ry : cy > ry + rh ? ry + rh : cy;
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy < r * r;
}

export const FLOOR = FLOOR_Y;
