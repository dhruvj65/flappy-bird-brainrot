/**
 * Canvas renderer - pixel art.
 *
 * Everything is authored at 1 unit = 1 pixel in VIEW space and blitted to a
 * backing store that is an INTEGER multiple of VIEW, with image smoothing off.
 * That is what keeps the art crisp: a non-integer scale would land sprite edges
 * between device pixels and the whole thing would shimmer.
 *
 * Static layers - sky, clouds, skyline, ground, pipe body, pipe cap, bird - are
 * pre-rendered once into offscreen canvases and blitted, so a long event does
 * not spend the afternoon re-running the same drawing code every frame.
 *
 * The pipe and bird artwork is original pixel art drawn in the classic arcade
 * style; no third-party sprite assets are used or reproduced.
 */

import { VIEW, PHYSICS, PIPES, CHALLENGE } from '../config.js';
import { FLOOR } from './world.js';

const PARTICLE_POOL = 48;
/** Twinkle is quantised into this many brightness steps. Bucketing the stars
 *  by step means one fillStyle change per step per frame instead of one per
 *  star - the cost stays flat however many stars a palette asks for. */
const STAR_LEVELS = 5;
const MAX_RENDER_SCALE = 4;
/** Bushes sit above the ground line, purely decorative - the collision floor
 *  is unchanged. Drawn as part of the ground strip so they scroll with it. */
const BUSH_HEIGHT = 22;

/* -------------------------------------------------------------------------- */
/* Sprite artwork                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The character, 17x12 cells drawn as 2x2 pixel blocks -> the classic 34x24
 * footprint. Used whenever no face image is supplied.
 *   K outline  Y body  C belly  W white  P pupil  O beak
 */
const BIRD_CELLS = [
  '.....KKKKK.......',
  '...KKYYYWWK......',
  '..KYYYYYWWKKKK...',
  '.KYYYYYYWPKOOOK..',
  '.KYYYYYYWPKOOOK..',
  'KYYWWWYYWWKOOOK..',
  'KYWWWWWYYYKKKK...',
  'KYWWWWWYYYYYK....',
  '.KYWWWYCCCCK.....',
  '..KYYYCCCCK......',
  '...KKCCCCK.......',
  '.....KKKK........'
];

const BIRD_PALETTE = {
  K: '#3b2716',
  Y: '#f7d51d',
  C: '#e0a91b',
  W: '#ffffff',
  P: '#20180f',
  O: '#f4801a'
};

/** Vertical shading bands of a pipe, as [width, colour] left to right (52px). */
const PIPE_BANDS = [
  [1, '#22400f'],
  [2, '#4b8f26'],
  [5, '#79c93f'],
  [4, '#a3e75a'],
  [2, '#d2f58d'],
  [28, '#6cbf3a'],
  [6, '#4b8f26'],
  [3, '#33690f'],
  [1, '#22400f']
];

/* -------------------------------------------------------------------------- */

export class Renderer {
  constructor(canvas, palette) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.palette = palette;
    this.scale = 1;
    this.shakeTime = 0;
    this.shakeMagnitude = 0;
    this.flashTime = 0;
    this.character = null;
    this.characterConfig = null;
    this.characterSprite = null;

    /* Challenge Mode's ghost. Kept as its own pre-tinted sprite so drawing it
       costs one blit: tinting per frame would mean a compositing pass on every
       frame of every challenge. Null whenever no challenge is running. */
    this.ghostWorld = null;
    this.ghostSprite = null;
    this.ghostConfig = null;
    this.ghostWidth = 0;
    this.ghostHeight = 0;
    this.time = 0;
    this.lastFlapAt = -10;

    this.particles = [];
    for (let i = 0; i < PARTICLE_POOL; i += 1) {
      this.particles.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: '#fff' });
    }

    this.layers = {};
    this.buildStaticLayers();
  }

  /**
   * Swaps the scene palette and rebuilds the pre-rendered layers.
   *
   * The sky, clouds, skyline and ground are baked once at construction for
   * speed, so changing character colours means rebuilding them - cheap here
   * because it happens on the select screen, never during play.
   */
  setPalette(palette) {
    if (!palette || palette === this.palette) return;
    this.palette = palette;
    this.buildStaticLayers();
  }

  setCharacter(image, characterConfig) {
    this.character = image;
    this.characterConfig = characterConfig;
    const built = image ? buildCharacterSprite(image, characterConfig) : null;
    this.characterSprite = built ? built.canvas : null;
    this.faceWidth = built ? built.width : 0;
    this.faceHeight = built ? built.height : 0;
  }

  /**
   * The opponent world to draw alongside the live one, or null.
   *
   * Held here rather than threaded through the engine so the render loop stays
   * exactly as it was: Engine still calls draw(world) and knows nothing about
   * Challenge Mode.
   */
  setGhostWorld(ghostWorld) {
    this.ghostWorld = ghostWorld || null;
  }

  /**
   * Installs (or clears, with null) the artwork the ghost wears - the
   * character the challenged player actually used for their recorded run.
   *
   * The sprite is built once and baked with its cool wash already applied, so
   * the per-frame cost is a single drawImage at reduced alpha.
   */
  setGhostCharacter(image, characterConfig) {
    if (!image) {
      this.ghostSprite = null;
      this.ghostConfig = null;
      this.ghostWidth = 0;
      this.ghostHeight = 0;
      return;
    }

    const built = buildCharacterSprite(image, characterConfig);
    if (!built) {
      this.ghostSprite = null;
      this.ghostConfig = null;
      return;
    }

    this.ghostConfig = characterConfig;
    this.ghostWidth = built.width;
    this.ghostHeight = built.height;
    this.ghostSprite = tintSprite(built.canvas, CHALLENGE.ghostTint, CHALLENGE.ghostTintStrength);
  }

  /* ---------------------------------------------------------------------- */
  /* Sizing                                                                 */
  /* ---------------------------------------------------------------------- */

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Snap to a whole-number pixel scale. The CSS box may be any size; the
    // browser then scales this integer-sized buffer with image-rendering:
    // pixelated, which keeps every sprite pixel square.
    const wanted = (rect.width * dpr) / VIEW.width;
    const scale = Math.max(1, Math.min(MAX_RENDER_SCALE, Math.round(wanted)));

    const width = VIEW.width * scale;
    const height = VIEW.height * scale;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.scale = scale;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Pre-rendered layers                                                    */
  /* ---------------------------------------------------------------------- */

  buildStaticLayers() {
    const p = this.palette;
    this.buildStarField();

    this.layers.sky = this.makeLayer(VIEW.width, VIEW.height, (ctx) => {
      const grad = ctx.createLinearGradient(0, 0, 0, FLOOR);
      grad.addColorStop(0, p.skyTop);
      grad.addColorStop(1, p.skyBottom);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);
    });

    // Blocky clouds. The strip is exactly VIEW.width so drawing it at x and
    // x + width covers the screen with no seam.
    this.layers.clouds = this.makeLayer(VIEW.width, 72, (ctx) => {
      const rand = seededRandom(11);
      ctx.fillStyle = p.cloud;
      for (let i = 0; i < 6; i += 1) {
        const x = Math.floor(rand() * (VIEW.width - 60));
        const y = Math.floor(rand() * 34) + 6;
        drawPixelCloud(ctx, x, y, 3 + Math.floor(rand() * 2));
      }
    });

    this.layers.cityFar = this.makeLayer(VIEW.width, 96, (ctx) => {
      drawSkyline(ctx, VIEW.width, 96, p.cityFar, 30, 17);
    });
    this.layers.cityNear = this.makeLayer(VIEW.width, 116, (ctx) => {
      drawSkyline(ctx, VIEW.width, 116, p.cityNear, 48, 29);
    });

    this.layers.ground = this.makeLayer(VIEW.width, VIEW.groundHeight + BUSH_HEIGHT, (ctx) => {
      drawBushes(ctx, VIEW.width, BUSH_HEIGHT, p);
      ctx.translate(0, BUSH_HEIGHT);
      drawGround(ctx, VIEW.width, VIEW.groundHeight, p);
    });

    // One pixel-tall pipe body slice, stretched vertically at draw time.
    this.layers.pipeBody = this.makeLayer(PIPES.width, 1, (ctx) => {
      paintBands(ctx, 0, 0, 1, PIPE_BANDS);
    });

    this.layers.pipeCap = this.makeLayer(PIPES.width + PIPES.capOverhang * 2, PIPES.capHeight, (ctx) => {
      const w = PIPES.width + PIPES.capOverhang * 2;
      const h = PIPES.capHeight;
      // The cap uses the same banding stretched over its wider footprint.
      paintBands(ctx, 0, 0, h, PIPE_BANDS, w);
      // Top and bottom rims read as the lip of the pipe.
      ctx.fillStyle = '#22400f';
      ctx.fillRect(0, 0, w, 1);
      ctx.fillRect(0, h - 1, w, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(1, 1, w - 2, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(1, h - 2, w - 2, 1);
    });

    this.layers.bird = this.makeLayer(PHYSICS.spriteWidth, PHYSICS.spriteHeight, (ctx) => {
      drawCells(ctx, BIRD_CELLS, BIRD_PALETTE, 2);
    });
  }

  /**
   * Lays out a deterministic starfield for palettes that ask for one.
   *
   * Stars cannot live in the pre-rendered sky layer because they twinkle, so
   * they are held as plain data and drawn each frame. Positions come from a
   * seeded PRNG, so the sky looks the same every time the game boots.
   */
  buildStarField() {
    const cfg = this.palette && this.palette.stars;
    if (!cfg || !cfg.count) {
      this.stars = null;
      this.starShades = null;
      return;
    }

    const rand = seededRandom(cfg.seed || 91);
    /* Spread across the sky that is actually visible - the skyline covers the
       bottom quarter - while staying out of the lightest strip just above the
       horizon, where the gradient closes on a dim star's own brightness. */
    const band = Math.round(FLOOR * 0.46);
    const stars = [];
    for (let i = 0; i < cfg.count; i += 1) {
      stars.push({
        x: Math.floor(rand() * VIEW.width),
        y: Math.floor(rand() * band) + 4,
        size: rand() > 0.84 ? 2 : 1,
        phase: rand() * Math.PI * 2,
        speed: 1.5 + rand() * 2.5
      });
    }

    this.stars = stars;
    this.starShades = shadeSteps(cfg.color || '#ffffff', STAR_LEVELS);
    // Reused every frame; never reallocated.
    this.starBuckets = [];
    for (let i = 0; i < STAR_LEVELS; i += 1) this.starBuckets.push([]);
  }

  makeLayer(width, height, draw) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    draw(ctx);
    return canvas;
  }

  /* ---------------------------------------------------------------------- */
  /* Effects                                                                */
  /* ---------------------------------------------------------------------- */

  /** Drops every transient effect - used when a session is torn down. */
  clearEffects() {
    this.ghostWorld = null;
    this.shakeTime = 0;
    this.flashTime = 0;
    for (const particle of this.particles) particle.life = 0;
  }

  shake(seconds = 0.35, magnitude = 5) {
    this.shakeTime = seconds;
    this.shakeMagnitude = magnitude;
  }

  flash(seconds = 0.12) {
    this.flashTime = seconds;
  }

  noteFlap() {
    this.lastFlapAt = this.time;
  }

  burst(x, y, color, count, speed) {
    let spawned = 0;
    for (const particle of this.particles) {
      if (particle.life > 0) continue;
      const angle = Math.random() * Math.PI * 2;
      const velocity = speed * (0.4 + Math.random() * 0.8);
      particle.x = x;
      particle.y = y;
      particle.vx = Math.cos(angle) * velocity;
      particle.vy = Math.sin(angle) * velocity - 20;
      particle.maxLife = 0.35 + Math.random() * 0.3;
      particle.life = particle.maxLife;
      particle.size = 1 + Math.round(Math.random() * 2);
      particle.color = color;
      spawned += 1;
      if (spawned >= count) break;
    }
  }

  updateEffects(dt) {
    this.time += dt;
    if (this.shakeTime > 0) this.shakeTime = Math.max(0, this.shakeTime - dt);
    if (this.flashTime > 0) this.flashTime = Math.max(0, this.flashTime - dt);
    for (const particle of this.particles) {
      if (particle.life <= 0) continue;
      particle.life -= dt;
      particle.vy += 420 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * `ghostWorld` is the Challenge Mode opponent, or null in normal play.
   *
   * Only the live world's pipes are drawn. Both worlds run the same seed, so
   * while both are alive their pipe layouts are identical by construction -
   * drawing the ghost's as well would just overdraw the same pixels.
   */
  draw(world, ghostWorld) {
    const ghost = ghostWorld || this.ghostWorld;
    const ctx = this.ctx;
    ctx.save();

    if (this.shakeTime > 0) {
      const strength = (this.shakeTime / 0.35) * this.shakeMagnitude;
      // Whole pixels only - a sub-pixel shake would blur the art.
      ctx.translate(
        Math.round((Math.random() - 0.5) * strength),
        Math.round((Math.random() - 0.5) * strength)
      );
    }

    ctx.drawImage(this.layers.sky, 0, 0);
    this.drawStars(world);
    this.drawParallax(this.layers.clouds, world.distance * 0.12, 48);
    this.drawParallax(this.layers.cityFar, world.distance * 0.22, FLOOR - 96);
    this.drawParallax(this.layers.cityNear, world.distance * 0.38, FLOOR - 116);

    this.drawPipes(world);
    // Behind the ground and the live bird: the player must never lose track of
    // themselves behind a translucent opponent.
    if (ghost) this.drawGhost(ghost);
    this.drawGround(world);
    this.drawParticles(ctx);
    this.drawBird(world);

    ctx.restore();

    if (this.flashTime > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.75, this.flashTime / 0.12);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);
      ctx.restore();
    }
  }

  /**
   * Draws the twinkling starfield, if the active palette has one.
   *
   * Each star's brightness is a sine wave on its own phase and speed, so they
   * shimmer independently rather than pulsing in unison. Stars drift far slower
   * than the clouds, which reads as distance.
   */
  drawStars(world) {
    if (!this.stars) return;

    const ctx = this.ctx;
    const buckets = this.starBuckets;
    for (const bucket of buckets) bucket.length = 0;

    for (const star of this.stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(this.time * star.speed + star.phase);
      let level = (twinkle * STAR_LEVELS) | 0;
      if (level >= STAR_LEVELS) level = STAR_LEVELS - 1;
      buckets[level].push(star);
    }

    const drift = world.distance * 0.04;
    const width = VIEW.width;
    for (let level = 0; level < STAR_LEVELS; level += 1) {
      const bucket = buckets[level];
      if (!bucket.length) continue;
      ctx.fillStyle = this.starShades[level];
      for (const star of bucket) {
        // Wrap so the field never runs out, and land on whole pixels.
        let x = (star.x - drift) % width;
        if (x < 0) x += width;
        ctx.fillRect(Math.round(x), star.y, star.size, star.size);
      }
    }
  }

  drawParallax(layer, offset, y) {
    const width = layer.width;
    const x = -Math.round(offset % width);
    this.ctx.drawImage(layer, x, y);
    this.ctx.drawImage(layer, x + width, y);
  }

  drawPipes(world) {
    const ctx = this.ctx;
    const body = this.layers.pipeBody;
    const cap = this.layers.pipeCap;
    const capH = PIPES.capHeight;
    const over = PIPES.capOverhang;

    for (const pipe of world.activePipes) {
      if (!pipe.active) continue;
      const x = Math.round(pipe.x);
      if (x > VIEW.width || x + PIPES.width < 0) continue;

      const gapTop = Math.round(pipe.gapY - pipe.gapHalf);
      const gapBottom = Math.round(pipe.gapY + pipe.gapHalf);

      // Upper pipe: body stretched from the ceiling down to the cap.
      const upperBody = gapTop - capH;
      if (upperBody > 0) ctx.drawImage(body, 0, 0, PIPES.width, 1, x, 0, PIPES.width, upperBody);
      ctx.drawImage(cap, x - over, gapTop - capH);

      // Lower pipe.
      const lowerTop = gapBottom + capH;
      if (FLOOR - lowerTop > 0) {
        ctx.drawImage(body, 0, 0, PIPES.width, 1, x, lowerTop, PIPES.width, FLOOR - lowerTop);
      }
      ctx.drawImage(cap, x - over, gapBottom);
    }
  }

  drawGround(world) {
    const ctx = this.ctx;
    const layer = this.layers.ground;
    const x = -Math.round(world.distance % layer.width);
    // Drawn after the pipes so the bushes overlap the pipe bases, and offset
    // upward by the bush band so the ground line itself stays at FLOOR.
    ctx.drawImage(layer, x, FLOOR - BUSH_HEIGHT);
    ctx.drawImage(layer, x + layer.width, FLOOR - BUSH_HEIGHT);
  }

  drawParticles(ctx) {
    for (const particle of this.particles) {
      if (particle.life <= 0) continue;
      ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife);
      ctx.fillStyle = particle.color;
      ctx.fillRect(Math.round(particle.x), Math.round(particle.y), particle.size, particle.size);
    }
    ctx.globalAlpha = 1;
  }

  drawBird(world) {
    const ctx = this.ctx;
    const bird = world.bird;

    // Idle bob so the attract screen is never a still image.
    const bob = world.mode === 'idle' ? Math.round(Math.sin(this.time * 3) * 3) : 0;

    ctx.save();
    ctx.translate(Math.round(bird.x), Math.round(bird.y) + bob);
    ctx.rotate(bird.rotation);

    if (this.character) this.drawFaceCharacter(ctx);
    else this.drawPixelBird(ctx);

    ctx.restore();
  }

  /**
   * The opponent's recorded run, drawn translucent.
   *
   * Three cues separate it from the live player, because one is not enough at
   * 288px: it is see-through, washed cool, and trails a short motion echo. A
   * crashed ghost fades further still so a dead opponent stops competing for
   * attention while the player is still flying.
   */
  drawGhost(ghostWorld) {
    const ctx = this.ctx;
    const bird = ghostWorld.bird;
    const crashed = ghostWorld.mode !== 'running';
    const alpha = crashed ? CHALLENGE.ghostAlpha * 0.55 : CHALLENGE.ghostAlpha;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Motion echo: two faint copies trailing the ghost's own path.
    if (!crashed) {
      for (let i = 2; i >= 1; i -= 1) {
        ctx.globalAlpha = alpha * (0.16 * i);
        this.blitGhost(ctx, bird.x - i * 7, bird.y - bird.vy * 0.012 * i, bird.rotation);
      }
      ctx.globalAlpha = alpha;
    }

    this.blitGhost(ctx, bird.x, bird.y, bird.rotation);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** One ghost blit at a position/rotation, sprite or fallback silhouette. */
  blitGhost(ctx, x, y, rotation) {
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(rotation);

    if (this.ghostSprite) {
      const cfg = this.ghostConfig || {};
      const anchorX = Number.isFinite(cfg.anchorX) ? cfg.anchorX : 0.5;
      const shiftX = (0.5 - anchorX) * this.ghostWidth;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        this.ghostSprite,
        Math.round(-this.ghostWidth / 2 + shiftX),
        -Math.round(this.ghostHeight / 2),
        this.ghostWidth,
        this.ghostHeight
      );
      ctx.imageSmoothingEnabled = false;
    } else {
      // No artwork for the opponent's character: a plain puck still reads as
      // a competitor and keeps the challenge playable.
      ctx.fillStyle = CHALLENGE.ghostTint;
      ctx.beginPath();
      ctx.arc(0, 0, PHYSICS.birdRadius + 2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /** The drawn bird, with a wing beat driven by the last flap. */
  drawPixelBird(ctx) {
    const w = PHYSICS.spriteWidth;
    const h = PHYSICS.spriteHeight;
    ctx.drawImage(this.layers.bird, -Math.round(w / 2), -Math.round(h / 2));

    // Wing overlay: a small bar over the body that swings up on each flap.
    const beat = this.wingBeat();
    const wingY = Math.round(1 - beat * 7);
    ctx.fillStyle = '#3b2716';
    ctx.fillRect(-9, wingY - 1, 11, 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-8, wingY, 9, 5);
  }

  /**
   * The supplied face cutout, drawn exactly as provided - no wing, no beak, no
   * ring. It is pre-scaled once in buildCharacterSprite, so this is a plain
   * blit of a small bitmap.
   *
   * Smoothing is switched on for this one call and off again straight after: a
   * photograph shown at ~30px needs interpolation or it turns to noise, while
   * every other sprite in the scene must stay hard-edged pixel art.
   */
  drawFaceCharacter(ctx) {
    const sprite = this.characterSprite;
    if (!sprite) {
      this.drawPixelBird(ctx);
      return;
    }

    /* anchorX says where the character's HEAD sits across the artwork, as a
       fraction of its width. Artwork is normally centred (0.5), but a cutout
       with hair or a scarf trailing to one side has its head off-centre - and
       since the collision circle is fixed at the origin, drawing such art
       centred would put the hitbox over empty pixels. Shifting by the anchor
       lines the head up with the circle and lets the trailing part hang off. */
    const cfg = this.characterConfig || {};
    const anchorX = Number.isFinite(cfg.anchorX) ? cfg.anchorX : 0.5;
    const shiftX = (0.5 - anchorX) * this.faceWidth;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      sprite,
      Math.round(-this.faceWidth / 2 + shiftX),
      -Math.round(this.faceHeight / 2),
      this.faceWidth,
      this.faceHeight
    );
    ctx.imageSmoothingEnabled = false;
  }

  wingBeat() {
    const sinceFlap = this.time - this.lastFlapAt;
    return sinceFlap < 0.26 ? Math.sin((sinceFlap / 0.26) * Math.PI) : 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Drawing helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Paints [width, colour] bands across a region, optionally rescaled. */
function paintBands(ctx, x, y, height, bands, totalWidth) {
  const natural = bands.reduce((sum, b) => sum + b[0], 0);
  const scale = totalWidth ? totalWidth / natural : 1;
  let cursor = 0;
  for (const band of bands) {
    const start = Math.round(cursor * scale);
    const end = Math.round((cursor + band[0]) * scale);
    ctx.fillStyle = band[1];
    ctx.fillRect(x + start, y, Math.max(1, end - start), height);
    cursor += band[0];
  }
}

/** Renders a character-grid sprite at `cell` pixels per cell. */
function drawCells(ctx, rows, palette, cell) {
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y];
    for (let x = 0; x < row.length; x += 1) {
      const colour = palette[row[x]];
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
}

function drawPixelCloud(ctx, x, y, unit) {
  // Built from whole blocks so it stays on the pixel grid.
  ctx.fillRect(x + unit * 2, y, unit * 6, unit * 2);
  ctx.fillRect(x + unit, y + unit * 2, unit * 9, unit * 2);
  ctx.fillRect(x, y + unit * 4, unit * 12, unit * 2);
}

function drawSkyline(ctx, width, height, colour, maxBuildingHeight, seed) {
  const rand = seededRandom(seed);
  ctx.fillStyle = colour;

  let x = 0;
  while (x < width) {
    const w = 14 + Math.floor(rand() * 20);
    const h = 20 + Math.floor(rand() * maxBuildingHeight);
    // Stop before the edge so the strip tiles without slicing a building.
    if (x + w > width) break;
    ctx.fillRect(x, height - h, w, h);
    x += w + 3 + Math.floor(rand() * 8);
  }
}

/** A row of blocky bushes along the horizon, on an 8px grid. */
function drawBushes(ctx, width, height, palette) {
  const rand = seededRandom(7);
  const base = height;
  let x = 0;
  while (x < width) {
    const w = 24 + Math.floor(rand() * 3) * 8;
    if (x + w > width) break;
    const h = 10 + Math.floor(rand() * 2) * 6;

    ctx.fillStyle = palette.grass;
    ctx.fillRect(x, base - h, w, h);
    ctx.fillRect(x + 6, base - h - 6, w - 12, 6);
    ctx.fillStyle = palette.grassLight;
    ctx.fillRect(x + 4, base - h - 4, w - 16, 4);
    ctx.fillRect(x + 2, base - h + 2, 6, 4);

    x += w + Math.floor(rand() * 2) * 8;
  }
}

function drawGround(ctx, width, height, palette) {
  // Grass lip
  ctx.fillStyle = palette.grassLight;
  ctx.fillRect(0, 0, width, 8);
  ctx.fillStyle = palette.grass;
  ctx.fillRect(0, 8, width, 4);

  // Zigzag where grass meets soil, on an 8px period that divides 288 exactly.
  ctx.fillStyle = palette.grassLight;
  for (let x = 0; x < width; x += 8) ctx.fillRect(x, 12, 4, 2);

  ctx.fillStyle = palette.groundDark;
  ctx.fillRect(0, 14, width, 3);

  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, 17, width, height - 17);

  // Diagonal stripes on a 24px period (288 / 24 = 12 whole repeats). The loop
  // starts off the left edge so the stripes that run past the right edge of one
  // tile reappear on the left of the next - without that the tile seam shows as
  // a blank wedge.
  ctx.fillStyle = palette.groundDark;
  const stripeRows = Math.floor((height - 24) / 2);
  const lead = stripeRows * 2 + 24;
  for (let x = -lead; x < width; x += 24) {
    for (let i = 0; i < stripeRows; i += 1) {
      ctx.fillRect(x + i * 2, 20 + i * 2, 8, 2);
      ctx.fillRect(x + 12 + i * 2, 20 + i * 2, 8, 2);
    }
  }

  ctx.fillStyle = palette.groundDark;
  ctx.fillRect(0, height - 4, width, 4);
}

/**
 * Pre-scales a character image to its drawn size (at the maximum render scale,
 * so it still has detail to spare when the stage is large). Doing the expensive
 * high-quality downscale once here keeps it out of the frame loop.
 *
 * Returns the drawn size in VIEW units alongside the bitmap: the width comes
 * from the image's own aspect ratio so a head cutout is not squashed square.
 */
/**
 * Returns a copy of a sprite washed toward `color`, preserving its alpha.
 *
 * 'source-atop' paints only where the sprite is already opaque, so a head
 * cutout keeps its silhouette instead of gaining a coloured box. Done once per
 * challenge, never per frame.
 */
function tintSprite(sprite, color, strength) {
  const canvas = document.createElement('canvas');
  canvas.width = sprite.width;
  canvas.height = sprite.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return sprite;

  ctx.drawImage(sprite, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = Math.max(0, Math.min(1, strength));
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}

function buildCharacterSprite(image, config) {
  const cfg = config || {};
  const source = trimTransparentEdges(image);
  const iw = source.width;
  const ih = source.height;
  if (!iw || !ih) return null;

  let height = Math.max(4, Math.round(PHYSICS.faceHeight * (cfg.scale || 1)));
  let width = cfg.circleCrop ? height : Math.max(4, Math.round(height * (iw / ih)));

  /* The collision circle must fit inside the artwork, or players die on
     apparent near-misses. A head cutout is narrower than it is tall, so WIDTH
     is the binding dimension - the character is drawn at its natural size and
     `birdRadius` is chosen to sit inside it (see config.js). Anything taller
     than the circle simply overhangs, which is forgiving rather than unfair. */
  const span = PHYSICS.birdRadius * 2;
  if (width < span) {
    const grow = span / width;
    width = Math.round(width * grow);
    height = Math.round(height * grow);
    console.warn(
      '[character] artwork is narrower than the hitbox (' + span + 'px); ' +
      'scaled up to fit. Lower PHYSICS.birdRadius or use a wider crop.'
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = width * MAX_RENDER_SCALE;
  canvas.height = height * MAX_RENDER_SCALE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (cfg.circleCrop) {
    // A square photo that still has its background: clip it to a circle.
    const r = canvas.width / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();
    drawImageCover(ctx, image, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    if (cfg.ringColor) {
      ctx.lineWidth = 2 * MAX_RENDER_SCALE;
      ctx.strokeStyle = cfg.ringColor;
      ctx.beginPath();
      ctx.arc(r, r, r - ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    // A transparent cutout: draw it as supplied.
    ctx.drawImage(
      image,
      source.x, source.y, source.width, source.height,
      0, 0, canvas.width, canvas.height
    );
  }

  return { canvas, width, height };
}

/**
 * Finds the bounding box of the non-transparent pixels in a character image.
 *
 * Without this, transparent padding around a cutout counts towards its drawn
 * size, so the visible face ends up smaller than the collision circle even
 * though the sprite box covers it. Trimming also means a supplied cutout does
 * not have to be cropped tightly - the game does it.
 *
 * Falls back to the whole image if the pixels cannot be read (a cross-origin
 * image would taint the canvas).
 */
function trimTransparentEdges(image) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const whole = { x: 0, y: 0, width: w, height: h };
  if (!w || !h) return whole;

  try {
    const probe = document.createElement('canvas');
    probe.width = w;
    probe.height = h;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (px[(y * w + x) * 4 + 3] < 8) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return whole;   // fully transparent
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  } catch {
    return whole;
  }
}

/** Draws an image "cover" style inside a square without distorting it. */
function drawImageCover(ctx, image, x, y, w, h) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;

  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** Builds `steps` rgba strings from a hex colour, dimmest to brightest. */
function shadeSteps(hex, steps) {
  const clean = String(hex).replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) || 255;
  const g = parseInt(clean.slice(2, 4), 16) || 255;
  const b = parseInt(clean.slice(4, 6), 16) || 255;

  const shades = [];
  for (let i = 0; i < steps; i += 1) {
    // The dimmest step stays clearly readable rather than sinking into the sky.
    const alpha = 0.38 + (i / (steps - 1)) * 0.62;
    shades.push('rgba(' + r + ',' + g + ',' + b + ',' + alpha.toFixed(2) + ')');
  }
  return shades;
}

/** Deterministic PRNG so a strip looks the same every time it is rebuilt. */
function seededRandom(seed) {
  let n = seed;
  return () => {
    n = (n * 1103515245 + 12345) % 2147483648;
    return n / 2147483648;
  };
}
