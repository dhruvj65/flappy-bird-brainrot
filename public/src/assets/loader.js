/**
 * Image loading with graceful degradation.
 *
 * Loading never rejects: a missing or broken asset resolves to null and the
 * renderer draws its procedural stand-in. The game must start at a stall even
 * if somebody deleted the wrong file five minutes before the doors opened.
 */

const IMAGE_TIMEOUT_MS = 8000;

export function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);

    const image = new Image();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };

    const timer = setTimeout(() => {
      image.src = '';
      finish(null);
    }, IMAGE_TIMEOUT_MS);

    image.onload = () => finish(image.naturalWidth > 0 ? image : null);
    image.onerror = () => finish(null);
    image.decoding = 'async';
    image.src = src;
  });
}

/**
 * Loads the character artwork for a variant, walking src -> fallbackSrc.
 * Returns { image, source } where source is 'primary' | 'fallback' | 'procedural'.
 */
export async function loadCharacter(characterConfig) {
  const primary = await loadImage(characterConfig.src);
  if (primary) return { image: primary, source: 'primary' };

  const fallback = await loadImage(characterConfig.fallbackSrc);
  if (fallback) return { image: fallback, source: 'fallback' };

  return { image: null, source: 'procedural' };
}
