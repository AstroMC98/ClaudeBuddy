'use strict';

/**
 * Sprite-sheet renderer.
 *
 * Implements the same contract as the procedural blob — mount / setState /
 * setActive / destroy — plus `supports(state)`, because a theme may cover only
 * some states and the orchestrator falls back per state.
 *
 * Sheets arrive as data URIs from the main process; this renderer never touches
 * the filesystem. Frames are stepped by moving the background position, which
 * keeps the whole sheet as one decoded image rather than re-decoding per frame.
 */

const { frameOffset, framesOf, pickVariant } = window.frameMath;

function createSpriteRenderer(theme, sheets) {
  let root = null;
  let el = null;
  let currentState = null;
  let timer = null;
  let settleTimer = null;
  let entryCount = 0;

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    clearTimeout(settleTimer);
    settleTimer = null;
  }

  function show(spec, index) {
    const { x, y } = frameOffset(index, spec.cols, spec.frame);
    // spec.offset nudges a sheet whose baseline disagrees with its siblings,
    // so the character does not jump vertically when states swap.
    el.style.backgroundPosition = `${x + spec.offset.x}px ${y + spec.offset.y}px`;
  }

  /** How long to show borrowed `idle` art before acking a one-shot. */
  const FALLBACK_ONE_SHOT_MS = 700;

  /**
   * Play a state.
   *
   * The visual loop and the `animation-ended` ack are deliberately independent.
   * When we are showing borrowed `idle` art for a one-shot state, the art loops
   * forever but the ack must still fire — otherwise `completeOneShot()` never
   * runs, the machine stays stuck in `done`, and since `tick()` only sleeps from
   * `idle` the buddy would never sleep again. That is the Phase 1 wedge, and
   * tying the ack to the end of the animation would reintroduce it here.
   */
  function play(spec, change, isFallback) {
    const range = pickVariant(spec.variants, spec.variantPick, entryCount);
    const frames = framesOf(range);
    const loopVisually = isFallback ? true : spec.loop;
    let i = 0;

    el.style.width = `${spec.frame.width}px`;
    el.style.height = `${spec.frame.height}px`;
    el.style.backgroundImage = `url("${sheets[spec.sheet]}")`;
    show(spec, frames[0]);

    const intervalMs = Math.max(16, Math.round(1000 / spec.fps));

    timer = setInterval(() => {
      i += 1;
      if (i >= frames.length) {
        if (loopVisually) {
          i = 0;
        } else {
          // Hold the final frame rather than snapping back.
          clearInterval(timer);
          timer = null;
          return;
        }
      }
      show(spec, frames[i]);
    }, intervalMs);

    if (change.next) {
      const ackMs = isFallback
        ? FALLBACK_ONE_SHOT_MS
        : Math.round((frames.length / spec.fps) * 1000);
      settleTimer = setTimeout(() => window.buddy.animationEnded(), ackMs);
    }
  }

  /**
   * Which sheet spec to play for a state.
   *
   * Spec §7.7: a state the theme omits falls back to `idle`, so a themed
   * character stays itself rather than turning into the procedural blob
   * mid-session. Only a theme with no `idle` at all returns null, which is the
   * orchestrator's signal to hand off.
   */
  function specFor(state) {
    if (Object.hasOwn(theme.states, state)) return theme.states[state];
    if (Object.hasOwn(theme.states, 'idle')) return theme.states.idle;
    return null;
  }

  return {
    supports(state) {
      return specFor(state) !== null;
    },

    mount(rootEl) {
      if (el) this.destroy();
      root = rootEl;
      el = document.createElement('div');
      el.className = 'sprite';
      root.appendChild(el);
    },

    setState(change) {
      if (!el) return;
      if (change.resync && change.state === currentState) return;

      const spec = specFor(change.state);
      if (spec === null) return;

      stop();
      currentState = change.state;
      entryCount += 1;
      play(spec, change, !Object.hasOwn(theme.states, change.state));
    },

    setActive(isActive) {
      if (!el) return;
      el.style.display = isActive ? '' : 'none';
      // A hidden renderer must not keep burning a timer per frame.
      if (!isActive) stop();
    },

    destroy() {
      stop();
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
      root = null;
      currentState = null;
    },
  };
}

window.createSpriteRenderer = createSpriteRenderer;
