'use strict';

(function main() {
  const stage = document.getElementById('stage');
  const badge = document.getElementById('badge');
  const bubble = document.getElementById('bubble');

  const procedural = window.createProceduralRenderer();
  procedural.mount(stage);

  let pokeTimer = null;
  // A poke: clicking the pet plays a quick wobble. Purely cosmetic and local.
  stage.addEventListener('click', () => {
    stage.classList.remove('poked');
    void stage.offsetWidth; // restart the animation
    stage.classList.add('poked');
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(() => stage.classList.remove("poked"), 420);
  });

  /** Set once assets arrive; null means "procedural for everything". */
  let sprite = null;
  let sounds = null;
  let stateConfig = {};
  let active = procedural;
  let badgeTimer = null;
  let bubbleTimer = null;

  function showBubble(message) {
    if (!message) return;
    // textContent, never innerHTML: the message is untrusted (hook/rules text).
    bubble.textContent = message;
    bubble.classList.add('visible');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('visible'), 4000);
  }

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

    showBubble(change.message);
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

  let clickThrough = false;
  window.buddy.onInteraction((cfg) => {
    clickThrough = Boolean(cfg && cfg.clickThrough);
  });

  // While click-through is on, tell main whether the cursor is over the pet's
  // rendered box so it can toggle mouse capture. The window forwards mousemove
  // even while ignoring clicks, so this keeps firing.
  let overPet = false;
  document.addEventListener('mousemove', (e) => {
    if (!clickThrough) return;
    const el = active === sprite && sprite ? document.querySelector('.sprite') : document.querySelector('.buddy');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside !== overPet) {
      overPet = inside;
      window.buddy.setInteractive(inside);
    }
  });
})();
