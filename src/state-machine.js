'use strict';

/**
 * The buddy's state machine.
 *
 * Deliberately pure: this module imports nothing, touches no clock, and has no
 * knowledge of Electron, HTTP or the DOM. The caller supplies the current time.
 * That is what makes idle-timeout behaviour testable without waiting ten minutes.
 */

/** Every state the buddy can occupy. */
const STATES = Object.freeze([
  'idle',
  'thinking',
  'working',
  'done',
  'needsInput',
  'subagent',
  'error',
  'sleeping',
]);

/**
 * Event types accepted from hooks. Each maps 1:1 onto the state of the same name.
 * `idle` and `sleeping` are absent: they are reached by transition, never by event.
 */
const EVENT_TYPES = Object.freeze([
  'thinking',
  'working',
  'done',
  'needsInput',
  'subagent',
  'error',
]);

/** One-shot states play once, then fall through to their successor. */
const ONE_SHOT = Object.freeze({
  done: 'idle',
  subagent: 'thinking',
  error: 'idle',
});

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** `Object.hasOwn` avoids inherited keys such as `constructor` matching. */
function successorOf(state) {
  return Object.hasOwn(ONE_SHOT, state) ? ONE_SHOT[state] : null;
}

function isEventType(type) {
  return typeof type === 'string' && EVENT_TYPES.includes(type);
}

function buildChange(state, previous) {
  const next = successorOf(state);
  return { state, previous, loop: next === null, next };
}

/**
 * @param {{ idleTimeoutMs?: number, now?: number }} [options]
 */
function createStateMachine(options = {}) {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let state = 'idle';
  let lastEventAt = options.now ?? 0;

  return {
    getState() {
      return state;
    },

    /**
     * The current state shaped as a StateChange, for resyncing a renderer that
     * has just loaded. `previous` is null because no transition occurred.
     */
    snapshot() {
      return buildChange(state, null);
    },

    /**
     * Apply an incoming hook event. Any event interrupts the current animation:
     * responsiveness matters more than animation integrity.
     * @returns {object|null} the state change, or null if the event was ignored
     */
    handleEvent(event, nowMs) {
      if (event === null || typeof event !== 'object') return null;
      if (!isEventType(event.type)) return null;

      lastEventAt = nowMs;
      const previous = state;
      state = event.type;
      return buildChange(state, previous);
    },

    /**
     * Called when a non-looping animation finishes playing.
     * @returns {object|null} the follow-on change, or null if nothing to advance
     */
    completeOneShot() {
      const successor = successorOf(state);
      if (successor === null) return null;

      const previous = state;
      state = successor;
      return buildChange(state, previous);
    },

    /**
     * Drive the idle timeout. Only an idle buddy falls asleep, and only once:
     * the state guard stops this re-firing every tick.
     * @returns {object|null}
     */
    tick(nowMs) {
      if (state !== 'idle') return null;
      if (nowMs - lastEventAt < idleTimeoutMs) return null;

      const previous = state;
      state = 'sleeping';
      return buildChange(state, previous);
    },
  };
}

module.exports = {
  createStateMachine,
  STATES,
  EVENT_TYPES,
  ONE_SHOT,
  DEFAULT_IDLE_TIMEOUT_MS,
};
