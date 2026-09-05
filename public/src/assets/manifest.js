/**
 * Character roster and asset manifest - the single place assets are named.
 *
 * Nothing in the gameplay, session or leaderboard code refers to a file path.
 * To add a character, add an entry here and list it in ROSTER; the select
 * screen, the renderer and the audio manager all read from this.
 *
 * Every entry degrades gracefully:
 *   - a character image that fails to load falls back to the drawn pixel bird,
 *     so a character whose art has not arrived yet is still playable
 *   - an audio file that fails to load (or a browser that blocks playback)
 *     falls back to the named WebAudio synth voice, and then to silence
 */

/**
 * Candidate paths for a sound, most-preferred first; the first that loads wins.
 *
 * tools/get-audio.mjs writes .mp3 when ffmpeg is available and .m4a when it is
 * not, so listing both means a downloaded clip works either way with no edit
 * here. Pass a folder for per-character sounds.
 */
function srcs(name, folder) {
  const base = folder ? `assets/audio/${folder}/${name}` : `assets/audio/${name}`;
  return ['mp3', 'm4a', 'ogg', 'wav'].map((ext) => `${base}.${ext}`);
}

/** Sounds every character shares. Per-character entries are merged over these. */
function commonAudio() {
  return {
    flap: { src: srcs('flap'), volume: 0.55, voice: 'flap', pool: 4 },
    point: { src: srcs('point'), volume: 0.5, voice: 'point', pool: 3 },
    hit: { src: srcs('collision'), volume: 0.7, voice: 'hit', pool: 2 },
    fanfare: { src: srcs('fanfare'), volume: 0.7, voice: 'fanfare', pool: 1 }
  };
}

/** Shared drawing options; only the artwork itself differs per character. */
function characterArt(src) {
  return {
    src,
    fallbackSrc: null,
    /** Multiplier on PHYSICS.faceHeight. */
    scale: 1,
    /**
     * false (default): the PNG is drawn exactly as supplied, at its own aspect
     * ratio and with nothing added - what a transparent head cutout wants.
     *
     * true: for a SQUARE photo that still has its background. The image is
     * clipped to a circle and `ringColor` outlines it.
     */
    circleCrop: false,
    ringColor: null,
    /**
     * Where the head sits across the artwork, 0..1. Leave at 0.5 for a normal
     * centred cutout; raise it when something (hair, a scarf) trails to the
     * left so the collision circle still lands on the head.
     */
    anchorX: 0.5
  };
}

export const VARIANTS = Object.freeze({
  modi: {
    id: 'modi',
    name: 'Narendra Modi',
    tagline: 'Three tries. One legend.',
    character: characterArt('assets/character/modi.png'),
    audio: {
      ...commonAudio(),
      gameover: { src: srcs('gameover', 'modi'), volume: 0.8, voice: 'gameover', pool: 1 },
      music: { src: srcs('music', 'modi'), volume: 0.28, loop: true, music: true }
    },
    /** Daytime city. The pipes carry their own shading bands in the renderer;
     *  these colours cover the sky, clouds, skyline and ground. */
    palette: {
      skyTop: '#4ec0e0',
      skyBottom: '#9fe0f2',
      cloud: '#ffffff',
      cityFar: '#8fd8ea',
      cityNear: '#74c8de',
      grassLight: '#8ed94f',
      grass: '#5ea832',
      ground: '#ded895',
      groundDark: '#c4b872'
    }
  },

  salman: {
    id: 'salman',
    name: 'Salman Bhai',
    tagline: 'Sunglasses on. Three tries.',
    character: characterArt('assets/character/salman.png'),
    audio: {
      ...commonAudio(),
      gameover: { src: srcs('gameover', 'salman'), volume: 0.8, voice: 'gameover', pool: 1 },
      music: { src: srcs('music', 'salman'), volume: 0.28, loop: true, music: true }
    },
    /** Sunset city - a visibly different sky, skyline and ground. */
    palette: {
      skyTop: '#f2803c',
      skyBottom: '#ffd9a0',
      cloud: '#fff3e0',
      cityFar: '#d98a5f',
      cityNear: '#b8663f',
      grassLight: '#c9a227',
      grass: '#8f6f18',
      ground: '#e8c98a',
      groundDark: '#c2a066'
    }
  },

  bigb: {
    id: 'bigb',
    name: 'Big B',
    tagline: 'The baritone takes flight.',
    character: characterArt('assets/character/bigb.png'),
    audio: {
      ...commonAudio(),
      gameover: { src: srcs('gameover', 'bigb'), volume: 0.8, voice: 'gameover', pool: 1 },
      music: { src: srcs('music', 'bigb'), volume: 0.28, loop: true, music: true }
    },
    /** Night city - the third distinct sky, so all three read apart at a glance.
     *  `stars` is optional: only a palette that declares it gets a starfield,
     *  so the daytime characters cost nothing for the feature. */
    palette: {
      skyTop: '#1b1b3a',
      skyBottom: '#5b4b8a',
      stars: { count: 54, color: '#ffffff', seed: 91 },
      cloud: '#c9c2e8',
      cityFar: '#3b3566',
      cityNear: '#2a2550',
      grassLight: '#4a7c59',
      grass: '#2f5d43',
      ground: '#6b5f8a',
      groundDark: '#4e456b'
    }
  },

  baburao: {
    id: 'baburao',
    name: 'Baburao',
    tagline: 'Chaos, with a moustache.',
    character: characterArt('assets/character/baburao.png'),
    audio: {
      ...commonAudio(),
      gameover: { src: srcs('gameover', 'baburao'), volume: 0.8, voice: 'gameover', pool: 1 },
      music: { src: srcs('music', 'baburao'), volume: 0.28, loop: true, music: true }
    },
    /** Overcast green-grey afternoon - the fourth distinct sky. */
    palette: {
      skyTop: '#7fa88c',
      skyBottom: '#d9e4c9',
      cloud: '#f2f6ea',
      cityFar: '#9db8a4',
      cityNear: '#7d9a86',
      grassLight: '#7ec850',
      grass: '#4e8c37',
      ground: '#cbbf8a',
      groundDark: '#a89a6b'
    }
  },

  taylor: {
    id: 'taylor',
    name: 'Taylor Swift',
    tagline: 'Pop flight, no crash landing.',
    character: characterArt('assets/character/taylor.png'),
    audio: {
      ...commonAudio(),
      gameover: { src: srcs('gameover', 'taylor'), volume: 0.8, voice: 'gameover', pool: 1 },
      music: { src: srcs('music', 'taylor'), volume: 0.28, loop: true, music: true }
    },
    /** Rose dusk. */
    palette: {
      skyTop: '#e0729b',
      skyBottom: '#ffd9e8',
      cloud: '#fff2f7',
      cityFar: '#e79ab8',
      cityNear: '#cc7a9c',
      grassLight: '#8fd4a8',
      grass: '#5aa87a',
      ground: '#f0d5c0',
      groundDark: '#d0b09a'
    }
  },

  ravikishan: {
    id: 'ravikishan',
    name: 'Ravi Kishan',
    tagline: 'Full-throttle takeoff.',
    character: characterArt('assets/character/ravikishan.png'),
    audio: {
      ...commonAudio(),
      gameover: { src: srcs('gameover', 'ravikishan'), volume: 0.8, voice: 'gameover', pool: 1 },
      music: { src: srcs('music', 'ravikishan'), volume: 0.28, loop: true, music: true }
    },
    /** Teal daybreak. */
    palette: {
      skyTop: '#1f7a8c',
      skyBottom: '#a8dadc',
      cloud: '#e8f7f8',
      cityFar: '#4a9aa8',
      cityNear: '#2f7c8a',
      grassLight: '#7ec850',
      grass: '#4e8c37',
      ground: '#e6d5a8',
      groundDark: '#c4b083'
    }
  },

  thalapathy: {
    id: 'thalapathy',
    name: 'Thalapathy',
    tagline: 'Golden hour, top speed.',
    character: characterArt('assets/character/thalapathy.png'),
    audio: {
      ...commonAudio(),
      gameover: { src: srcs('gameover', 'thalapathy'), volume: 0.8, voice: 'gameover', pool: 1 },
      music: { src: srcs('music', 'thalapathy'), volume: 0.28, loop: true, music: true }
    },
    /** Golden hour - warm but clearly apart from Salman's orange and Taylor's rose. */
    palette: {
      skyTop: '#d4a017',
      skyBottom: '#ffeaa7',
      cloud: '#fffaf0',
      cityFar: '#c9973f',
      cityNear: '#a8792c',
      grassLight: '#8fbf3f',
      grass: '#5f8a26',
      ground: '#e3cf94',
      groundDark: '#bfa871'
    }
  },

  haaland: {
    id: 'haaland',
    name: 'Haaland',
    tagline: 'Striker mode: engaged.',
    /* Measured from the cutout: the head occupies the right side, with hair
       streaming left, so its centre of mass sits at 0.70 across the image. */
    character: { ...characterArt('assets/character/haaland.png'), anchorX: 0.7 },
    audio: {
      ...commonAudio(),
      gameover: { src: srcs('gameover', 'haaland'), volume: 0.8, voice: 'gameover', pool: 1 },
      music: { src: srcs('music', 'haaland'), volume: 0.28, loop: true, music: true }
    },
    /** Indigo twilight - the eighth sky, kept clear of the existing blues. */
    palette: {
      skyTop: '#4c3f9e',
      skyBottom: '#b8a9e8',
      cloud: '#efeaff',
      cityFar: '#6a5cb8',
      cityNear: '#50449a',
      grassLight: '#6fc06a',
      grass: '#3f8a44',
      ground: '#c9bfa0',
      groundDark: '#a89a7d'
    }
  }
});

/** Order the characters appear on the select screen. */
export const ROSTER = Object.freeze([
  'modi',
  'salman',
  'bigb',
  'baburao',
  'taylor',
  'ravikishan',
  'thalapathy',
  'haaland'
]);

/** Used when nothing has been chosen yet. */
export const DEFAULT_VARIANT = 'modi';

export function getVariant(id) {
  return VARIANTS[id] || VARIANTS[DEFAULT_VARIANT];
}

/** Query string override, handy for demoing one character without clicking. */
export function resolveVariant(search) {
  let requested = null;
  try {
    requested = new URLSearchParams(search || '').get('variant');
  } catch {
    requested = null;
  }
  return getVariant(requested);
}
