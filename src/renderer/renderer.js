'use strict';

(function main() {
  const stage = document.getElementById('stage');
  const badge = document.getElementById('badge');

  const procedural = window.createProceduralRenderer();
  procedural.mount(stage);

  /** Set once assets arrive; null means "procedural for everything". */
  let sprite = null;
  let sounds = null;
  let stateConfig = {};
  let active = procedural;
  let badgeTimer = null;

  /** The sprite renderer wins for any state its theme actually covers. */
  function rendererFor(state) {
    if (sprite && sprite.supports(state)) return sprite;
    return procedural;
  }

  function applyState(change) {
    const target = rendererFor(change.state);

    if (target !== active) {
      active.setActive(false);
      target.setActive(true);
      active = target;
    }

    target.setState(change);

    // When rules.js is active, main resolves the per-event behavior and attaches
    // it here; otherwise fall back to the theme/config defaults the renderer
    // already holds.
    const behavior = change.behavior;

    const pulse = behavior
      ? behavior.scalePulse
      : stateConfig[change.state] && stateConfig[change.state].scalePulse;
    if (Number.isFinite(pulse) && pulse !== 1) {
      stage.style.setProperty('--pulse', String(pulse));
      stage.classList.remove('pulsing');
      void stage.offsetWidth;
      stage.classList.add('pulsing');
    }

    if (behavior) {
      // soundUri: a data URI to play, or null for deliberate silence.
      if (sounds && behavior.soundUri) sounds.playUri(behavior.soundUri);
    } else if (sounds) {
      sounds.play(change.state);
    }

    badge.textContent = change.state;
    badge.classList.add('visible');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => badge.classList.remove('visible'), 1600);
  }

  window.buddy.onAssets((assets) => {
    stateConfig = assets.states || {};

    // The theme's own scale composes with the user's config.scale (--base-scale)
    // and the per-state pulse. A 240x270 frame dominates a 320x320 window, which
    // is exactly why a theme is allowed to ask to be drawn smaller.
    const themeScale = assets.theme && Number.isFinite(assets.theme.scale) ? assets.theme.scale : 1;
    stage.style.setProperty('--theme-scale', String(themeScale));

    if (assets.theme && assets.sheets) {
      sprite = window.createSpriteRenderer(assets.theme, assets.sheets);
      sprite.mount(stage);
      sprite.setActive(false);
    }

    sounds = window.createSoundPlayer({
      sounds: assets.sounds,
      enabled: assets.sound && assets.sound.enabled,
      volume: assets.sound && assets.sound.volume,
    });
  });

  window.buddy.onStateChange(applyState);
})();
