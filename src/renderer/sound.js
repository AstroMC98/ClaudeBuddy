'use strict';

/**
 * Per-state sound playback.
 *
 * Sounds arrive as data URIs, so there is no network fetch and no filesystem
 * access — `media-src data:` in the CSP is what permits them. Each sound is
 * decoded once and rewound on replay rather than re-created, so a rapid burst
 * of events cannot pile up Audio objects.
 */
function createSoundPlayer({ sounds = {}, enabled = true, volume = 0.5 } = {}) {
  const cache = new Map();
  const uriCache = new Map();
  let isEnabled = enabled;

  for (const [state, uri] of Object.entries(sounds)) {
    try {
      const audio = new Audio(uri);
      audio.volume = Math.min(1, Math.max(0, volume));
      audio.preload = 'auto';
      cache.set(state, audio);
    } catch {
      // A sound that will not construct is not worth failing the pet over.
    }
  }

  return {
    play(state) {
      if (!isEnabled) return;
      const audio = cache.get(state);
      if (!audio) return;
      try {
        audio.currentTime = 0;
        // play() rejects if the browser still blocks autoplay; ignore it
        // rather than surfacing an unhandled rejection every state change.
        const result = audio.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        /* never let audio break the animation */
      }
    },

    /**
     * Play an ad-hoc sound delivered as a data URI (used when rules.js selects
     * a sound per event). Cached by URI so a repeated sound is decoded once.
     */
    playUri(dataUri) {
      if (!isEnabled || !dataUri) return;
      let audio = uriCache.get(dataUri);
      if (!audio) {
        try {
          audio = new Audio(dataUri);
          audio.volume = Math.min(1, Math.max(0, volume));
          uriCache.set(dataUri, audio);
        } catch {
          return;
        }
      }
      try {
        audio.currentTime = 0;
        const r = audio.play();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {
        /* never let audio break the animation */
      }
    },

    setEnabled(value) {
      isEnabled = Boolean(value);
    },

    has(state) {
      return cache.has(state);
    },
  };
}

window.createSoundPlayer = createSoundPlayer;
