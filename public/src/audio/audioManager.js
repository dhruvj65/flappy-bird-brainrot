/**
 * Audio manager.
 *
 * Three layers of graceful degradation, because a stall laptop may have muted
 * hardware, a browser that blocks autoplay, or missing asset files:
 *
 *   1. the file named in the manifest, played from a small element pool
 *   2. a WebAudio synth voice with the same name (always available offline)
 *   3. silence
 *
 * Nothing here ever throws into the game loop: play() is safe to call in any
 * state, at any time, including before the first user gesture.
 */

import { STORAGE } from '../config.js';

const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

export class AudioManager {
  constructor(audioConfig) {
    this.config = audioConfig || {};
    this.pools = new Map();      // name -> { elements, index, config, available }
    this.music = null;
    this.musicConfig = null;
    this.ctx = null;
    this.duckTimer = 0;
    this.musicWanted = false;
    this.unlocked = false;
    this.muted = readMuted();
    this.enabled = true;         // flipped off if the platform has no audio at all
  }

  /**
   * Swaps in a different character's sound set, keeping mute state and the
   * autoplay unlock. Elements from the previous character are torn down so a
   * long event does not accumulate audio elements per character switch.
   */
  load(audioConfig) {
    this.stopMusic();
    this.releaseElements();
    this.config = audioConfig || {};
    this.musicConfig = null;
    this.init();

    // Rebuilt elements have not been primed, so re-open the autoplay gate for
    // the new set if it was already open for the old one.
    if (this.unlocked) {
      for (const pool of this.pools.values()) {
        if (!pool.available) continue;
        for (const element of pool.elements) primeElement(element);
      }
    }
    return this;
  }

  /** Detaches every audio element so the browser can release its buffers. */
  releaseElements() {
    for (const pool of this.pools.values()) {
      for (const element of pool.elements) {
        try {
          element.pause();
          element.removeAttribute('src');
          element.load();
        } catch {
          /* already gone */
        }
      }
    }
    this.pools.clear();
    if (this.music) {
      try {
        this.music.pause();
        this.music.removeAttribute('src');
        this.music.load();
      } catch {
        /* already gone */
      }
    }
    this.music = null;
  }

  /** Creates the element pools. Never awaits network - loading is lazy and
   *  failures are recorded on the element's error event. */
  init() {
    if (typeof Audio === 'undefined') {
      this.enabled = false;
      return this;
    }

    for (const [name, cfg] of Object.entries(this.config)) {
      if (cfg.music) {
        this.musicConfig = cfg;
        this.music = this.createElement(cfg, name);
        if (this.music) {
          this.music.loop = cfg.loop !== false;
          this.music.volume = 0;
        }
        continue;
      }

      const size = Math.max(1, cfg.pool || 2);
      const elements = [];
      for (let i = 0; i < size; i += 1) {
        const element = this.createElement(cfg, name);
        if (element) elements.push(element);
      }
      this.pools.set(name, { elements, index: 0, config: cfg, available: elements.length > 0 });
    }

    return this;
  }

  /**
   * `src` may be a single path or a list of candidates. The list matters
   * because tools/get-audio.mjs writes .mp3 when ffmpeg is available and .m4a
   * when it is not - listing both means either result just works, with no
   * config edit after downloading a track.
   */
  createElement(cfg, name) {
    try {
      const sources = Array.isArray(cfg.src) ? cfg.src.slice() : [cfg.src];
      const element = new Audio();
      element.preload = 'auto';
      element.volume = clamp01(cfg.volume == null ? 0.6 : cfg.volume);

      let index = 0;
      element.addEventListener('error', () => {
        index += 1;
        if (index < sources.length) {
          // Try the next container before giving up on this sound.
          element.src = sources[index];
          element.load();
          return;
        }
        const pool = this.pools.get(name);
        if (pool) pool.available = false;
        if (cfg.music) this.music = null;
      });

      element.src = sources[0];
      return element;
    } catch {
      return null;
    }
  }

  /** Must be called from a real user gesture. Idempotent. */
  unlock() {
    if (this.unlocked || !this.enabled) return;
    this.unlocked = true;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      try {
        this.ctx = new Ctx();
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});

    // Prime every usable element with a muted play/pause so later playback is
    // allowed. Pools whose file already failed to load are skipped - they will
    // use their synth voice instead.
    for (const pool of this.pools.values()) {
      if (!pool.available) continue;
      for (const element of pool.elements) primeElement(element);
    }

    /* The music element is deliberately NOT primed. Priming swaps in a silent
       clip and then restores the real src with load(), which would cancel a
       play() issued immediately afterwards - and music is always started from
       inside the same user gesture that calls unlock(), so it never needed the
       priming trick in the first place. */
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    writeMuted(this.muted);
    if (this.music) this.music.volume = this.muted ? 0 : musicVolume(this.musicConfig);
    if (this.muted && this.music) this.music.pause();
    else if (!this.muted && this.musicWanted) this.startMusic();
    return this.muted;
  }

  toggleMuted() {
    return this.setMuted(!this.muted);
  }

  play(name) {
    if (!this.enabled || this.muted) return;

    const pool = this.pools.get(name);
    if (pool && pool.available && pool.elements.length) {
      const element = pool.elements[pool.index];
      pool.index = (pool.index + 1) % pool.elements.length;
      try {
        element.currentTime = 0;
        const result = element.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() => {
            pool.available = false;
            this.synth(pool.config.voice);
          });
        }
        return;
      } catch {
        pool.available = false;
      }
    }

    this.synth(pool ? pool.config.voice : name);
  }

  /**
   * How long a sound will occupy the mix, in milliseconds.
   *
   * Returns 0 when the sound will not actually be heard - muted, unavailable,
   * or still loading - so callers can use it as "how long to wait for this"
   * without ever stalling on silence.
   */
  durationMs(name) {
    if (!this.enabled || this.muted) return 0;
    const pool = this.pools.get(name);
    if (!pool || !pool.available || !pool.elements.length) return 0;
    const seconds = pool.elements[0].duration;
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  }

  /**
   * @param {{restart?: boolean}} [options] restart plays the track from the
   *        top, which is what each new attempt wants.
   */
  startMusic(options) {
    this.musicWanted = true;
    if (!this.enabled || this.muted || !this.music) return;
    try {
      if (options && options.restart) this.music.currentTime = 0;
      this.music.volume = musicVolume(this.musicConfig);
      const result = this.music.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* music is entirely optional */
    }
  }

  stopMusic() {
    this.musicWanted = false;
    if (!this.music) return;
    try {
      this.music.pause();
      this.music.currentTime = 0;
    } catch {
      /* ignore */
    }
  }

  /** Lowers music under the result fanfare, then restores it. */
  duckMusic(seconds = 2.5) {
    if (!this.music || this.muted) return;
    const full = musicVolume(this.musicConfig);
    this.music.volume = full * 0.25;
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => {
      if (this.music && !this.muted) this.music.volume = full;
    }, seconds * 1000);
  }

  /* ---------------------------------------------------------------------- */
  /* WebAudio fallback voices                                               */
  /* ---------------------------------------------------------------------- */

  synth(voice) {
    if (!voice || !this.ctx || this.muted) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});

    const now = this.ctx.currentTime;
    switch (voice) {
      case 'flap':
        this.blip(620, 980, now, 0.09, 'square', 0.16);
        break;
      case 'point':
        this.blip(880, 880, now, 0.06, 'triangle', 0.18);
        this.blip(1320, 1320, now + 0.07, 0.09, 'triangle', 0.16);
        break;
      case 'hit':
        this.noise(now, 0.18, 0.25);
        this.blip(220, 70, now, 0.22, 'sawtooth', 0.2);
        break;
      case 'gameover':
        this.blip(500, 500, now, 0.12, 'square', 0.14);
        this.blip(400, 400, now + 0.13, 0.12, 'square', 0.14);
        this.blip(300, 300, now + 0.26, 0.12, 'square', 0.14);
        this.blip(200, 160, now + 0.39, 0.3, 'square', 0.14);
        break;
      case 'fanfare':
        this.blip(523, 523, now, 0.12, 'triangle', 0.16);
        this.blip(659, 659, now + 0.12, 0.12, 'triangle', 0.16);
        this.blip(784, 784, now + 0.24, 0.12, 'triangle', 0.16);
        this.blip(1046, 1046, now + 0.36, 0.42, 'triangle', 0.18);
        break;
      default:
        break;
    }
  }

  blip(fromHz, toHz, at, duration, type, gainPeak) {
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(fromHz, at);
      if (toHz !== fromHz) osc.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), at + duration);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(gainPeak, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(at);
      osc.stop(at + duration + 0.02);
      // Oscillator nodes are one-shot; releasing references keeps memory flat
      // across a full day of play.
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    } catch {
      /* ignore */
    }
  }

  noise(at, duration, gainPeak) {
    try {
      const frames = Math.floor(this.ctx.sampleRate * duration);
      const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i += 1) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      }
      const source = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      source.buffer = buffer;
      gain.gain.setValueAtTime(gainPeak, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      source.connect(gain).connect(this.ctx.destination);
      source.start(at);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
    } catch {
      /* ignore */
    }
  }

  destroy() {
    this.stopMusic();
    clearTimeout(this.duckTimer);
    this.releaseElements();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

function primeElement(element) {
  try {
    const originalSrc = element.src;
    const originalVolume = element.volume;
    element.volume = 0;
    element.src = SILENT_WAV;
    const result = element.play();
    const restore = () => {
      element.pause();
      element.src = originalSrc;
      element.volume = originalVolume;
      element.load();
    };
    if (result && typeof result.then === 'function') result.then(restore, restore);
    else restore();
  } catch {
    /* ignore */
  }
}

function musicVolume(cfg) {
  return clamp01(cfg && cfg.volume != null ? cfg.volume : 0.3);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function readMuted() {
  try {
    return localStorage.getItem(STORAGE.mutedKey) === '1';
  } catch {
    return false;
  }
}

function writeMuted(muted) {
  try {
    localStorage.setItem(STORAGE.mutedKey, muted ? '1' : '0');
  } catch {
    /* storage unavailable - mute simply will not persist */
  }
}
