/**
 * Engine - owns the single requestAnimationFrame loop.
 *
 * - Fixed timestep simulation (120 Hz) with an accumulator, so physics is
 *   identical on a 60 Hz laptop and a 144 Hz gaming monitor.
 * - A hard cap on catch-up steps: after a tab switch or a GC pause the game
 *   drops the missing time instead of simulating two seconds in one frame and
 *   teleporting the player into a pipe.
 * - Exactly one rAF handle exists at a time, and stop() cancels it. Nothing
 *   keeps running once a session ends.
 */

const FIXED_STEP = 1 / 120;
/* Catch-up budget per frame. 8 steps covers a 66ms frame, so the game keeps
   true speed all the way down to ~15fps and only drops into slow motion below
   that. Slow motion is the deliberate choice over skipping time: a dropped
   frame must never teleport the player through a pipe. */
const MAX_STEPS_PER_FRAME = 8;

export class Engine {
  constructor({ world, renderer, onEvents, onFrame, onStep }) {
    this.world = world;
    this.renderer = renderer;
    this.onEvents = onEvents || (() => {});
    this.onFrame = onFrame || (() => {});
    /* Called once per FIXED step, right after the world advances. Anything that
       must stay in lockstep with the simulation - the Challenge Mode ghost -
       hangs off this rather than off the frame, so a 30fps laptop and a 144Hz
       monitor advance it identically. */
    this.onStep = onStep || (() => {});

    this.frameHandle = 0;
    this.running = false;
    this.lastTime = 0;
    this.accumulator = 0;

    this.tick = this.tick.bind(this);
    this.handleVisibility = () => {
      // Coming back from a hidden tab: drop the elapsed wall-clock time.
      if (!document.hidden) this.lastTime = 0;
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = 0;
    this.accumulator = 0;
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    document.removeEventListener('visibilitychange', this.handleVisibility);
  }

  tick(now) {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.tick);

    if (!this.lastTime) this.lastTime = now;
    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;

    if (!Number.isFinite(frameTime) || frameTime < 0) frameTime = 0;
    if (frameTime > MAX_STEPS_PER_FRAME * FIXED_STEP) frameTime = MAX_STEPS_PER_FRAME * FIXED_STEP;

    this.accumulator += frameTime;

    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      const events = this.world.update(FIXED_STEP);
      if (events.length) this.onEvents(events);
      this.onStep(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps += 1;
    }

    this.renderer.updateEffects(frameTime);
    this.renderer.draw(this.world);
    this.onFrame(this.world);
  }
}
