'use strict';

/**
 * Default renderer: a procedurally-drawn blob, no art assets required.
 *
 * Implements the Renderer interface that a future sprite-sheet renderer will
 * also implement — mount / setState / destroy. Keeping this contract narrow is
 * what makes the renderer pluggable rather than merely "replaceable one day".
 */
function createProceduralRenderer() {
  let root = null;
  let el = null;
  let currentState = null;
  let pulseTimer = null;

  /** One-shot animations report completion so the machine can advance. */
  const ONE_SHOT_DURATION_MS = {
    done: 900,
    subagent: 380,
    error: 520,
  };

  let settleTimer = null;

  function build() {
    const buddy = document.createElement('div');
    buddy.className = 'buddy';
    buddy.innerHTML = [
      '<div class="buddy__zzz">z</div>',
      '<div class="buddy__body">',
      '  <div class="buddy__eye buddy__eye--left"></div>',
      '  <div class="buddy__eye buddy__eye--right"></div>',
      '  <div class="buddy__mouth"></div>',
      '</div>',
    ].join('');
    return buddy;
  }

  return {
    mount(rootEl) {
      root = rootEl;
      el = build();
      root.appendChild(el);
      this.setState({ state: 'idle', previous: null, loop: true, next: null });
    },

    /**
     * @param {{state: string, previous: string|null, loop: boolean, next: string|null}} change
     */
    setState(change) {
      if (!el) return;

      // A resync is main catching us up after a page load. If we are already
      // showing this state we did not miss it, and re-applying would restart a
      // live one-shot's settle timer and replay its pulse. A genuine repeat
      // event (no resync flag) still replays, which is what you want when the
      // same thing happens twice.
      if (change.resync && change.state === currentState) return;

      if (currentState) el.classList.remove(`buddy--${currentState}`);
      currentState = change.state;
      el.classList.add(`buddy--${currentState}`);

      // Restart the attention pulse from scratch on every state entry.
      el.classList.remove('buddy--pulse');
      void el.offsetWidth; // force reflow so the animation replays
      el.classList.add('buddy--pulse');
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => el && el.classList.remove('buddy--pulse'), 460);

      // Tell the main process when a one-shot animation has finished.
      clearTimeout(settleTimer);
      if (!change.loop && change.next) {
        const duration = ONE_SHOT_DURATION_MS[change.state] ?? 600;
        settleTimer = setTimeout(() => window.buddy.animationEnded(), duration);
      }
    },

    destroy() {
      clearTimeout(pulseTimer);
      clearTimeout(settleTimer);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
      root = null;
      currentState = null;
    },
  };
}

window.createProceduralRenderer = createProceduralRenderer;
