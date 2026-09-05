/**
 * Central tuning. Every magic number the game feel depends on lives here so it
 * can be adjusted for the event without touching gameplay code.
 */

/** Fixed virtual resolution - portrait, at the classic arcade pixel scale.
 *  Every sprite is authored at 1 unit = 1 pixel in this space and the renderer
 *  upscales with nearest-neighbour, which is what keeps the art crisp instead
 *  of blurry. Physics is identical on every display because it all happens in
 *  these units. */
export const VIEW = Object.freeze({
  width: 288,
  height: 512,
  groundHeight: 88
});

export const PHYSICS = Object.freeze({
  /* The single most important relationship in the game: a gap must comfortably
     exceed (flap rise + character height), because the character oscillates by
     one flap-rise while crossing it. Here that is 54 + 24 = 78 against a 125px
     opening, leaving ~47px of slack at the start of a run and ~17px once the
     gap has tightened to its minimum. Scale these together or the game becomes
     unflyable. */
  gravity: 1400,          // px/s^2
  flapVelocity: -390,     // px/s applied instantly on flap (rise ~54px)
  maxFallSpeed: 600,      // terminal velocity, keeps the fall readable
  flapCooldown: 0.07,     // s - swallows machine-gun tapping, still feels instant
  birdX: 74,              // fixed horizontal position (~26% in)
  /* The collision circle has to fit inside the NARROWEST character that will
     be loaded. A head cutout is roughly 0.64 as wide as it is tall, so at
     faceHeight 30 it is ~19px across - hence a radius of 9. The drawn bird
     (34x24) is far wider than this, which just makes it forgiving. */
  birdRadius: 9,
  spriteWidth: 34,
  spriteHeight: 24,
  /** Drawn HEIGHT of a face character. Its width follows from the image's own
   *  aspect ratio, so a head cutout stays head-shaped instead of being squashed
   *  into a square. Keep it close to the bird's 24px so the hitbox still sits
   *  comfortably inside the artwork. */
  faceHeight: 30,
  maxRotationUp: -0.42,   // rad
  maxRotationDown: 1.5,   // rad
  rotationLerp: 9
});

export const PIPES = Object.freeze({
  width: 52,              // classic pipe footprint at this resolution
  capHeight: 26,
  capOverhang: 2,         // cap is 56 wide, 2px proud of the body each side
  /* Pipes are spaced by TIME, not by distance: spacing = speed * interval.
     Because the speed ramps up during a run, fixed pixel spacing would quietly
     shorten the window for the climb between two gaps until some transitions
     became physically impossible. Keeping the interval constant means the
     climb demand never changes and the difficulty comes from the gap alone. */
  /* 1.4s between pipes leaves ~95px of clear air between one pipe and the
     next, so the character is not inside a pipe half the time. */
  intervalSeconds: 1.4,
  baseSpeed: 105,         // px/s at score 0
  speedPerPoint: 1,       // ramps difficulty as the run goes on
  maxSpeed: 145,
  /* The gap carries the whole difficulty curve and never plateaus early: a run
     at a stall has to end, or one strong player blocks the queue. */
  baseGap: 120,
  gapPerPoint: -1,
  minGap: 92,
  minTopMargin: 30,       // keeps a gap reachable from the ceiling
  minBottomMargin: 30,
  /** Cap on how far the gap can move between consecutive pipes. Without it the
   *  random centre can jump the full range, which is close to unflyable and
   *  reads as unfair to a first-time player at a stall. */
  maxCenterDelta: 100,
  poolSize: 8             // reused forever; no per-pipe allocation during play
});

export const RULES = Object.freeze({
  attemptsPerSession: 3,
  /** A session left half finished on screen returns to the attract loop, so the
   *  next person in the queue never inherits somebody else's attempts. */
  idleResetMs: 60000,
  /** Restoring a refreshed session is only sensible for a short window. */
  sessionTtlMs: 15 * 60 * 1000,
  readyCountdownMs: 900,
  /** Minimum beat between crashing and the game-over panel. If a lose sound is
   *  installed and audible, the panel waits for it to finish instead. */
  crashToGameOverMs: 850,
  maxNameLength: 14
});

export const LEADERBOARD = Object.freeze({
  apiBase: '/api',
  displayLimit: 12,
  fetchLimit: 25,
  requestTimeoutMs: 6000,
  submitRetries: 2,
  storageKey: 'flappyfest.leaderboard.mirror.v1',
  queueKey: 'flappyfest.leaderboard.queue.v1',
  resultsKey: 'flappyfest.leaderboard.results.v1'
});

export const STORAGE = Object.freeze({
  sessionKey: 'flappyfest.session.v1',
  mutedKey: 'flappyfest.muted.v1'
});

/**
 * Challenge Mode - racing a recorded run from the leaderboard.
 *
 * A challenge is a single exhibition attempt: it does not consume any of the
 * three leaderboard attempts and does not itself go on the board, so the
 * "best of three" contract the rest of the game rests on is untouched.
 */
export const CHALLENGE = Object.freeze({
  /** Beats of the pre-run countdown, in milliseconds each. */
  countdownStepMs: 700,
  countdownBeats: ['3', '2', '1', 'GO'],
  /** How translucent the ghost is drawn. Low enough to read as "not you",
   *  high enough to actually follow at 288px wide. */
  ghostAlpha: 0.45,
  /** Cool wash laid over the ghost sprite so it never reads as a second live
   *  player, even when both characters are the same person. */
  ghostTint: '#7fd4ff',
  ghostTintStrength: 0.55,
  /** A replay bigger than this is refused rather than stored. */
  maxReplayBytes: 24 * 1024,
  /** Personal bests per player name, for the "new personal best" result. */
  personalBestKey: 'flappyfest.challenge.pb.v1',
  /** A challenge left sitting on the brief or result screen hands the stall
   *  back to the queue, same as the main game's idle reset. */
  idleResetMs: 60000
});
