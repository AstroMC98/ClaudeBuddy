'use strict';

const { isSafeRelativePath } = require('./config.js');

/** The attention pulse is a size multiplier; keep it sane whatever rules asks. */
const MIN_PULSE = 0.1;
const MAX_PULSE = 4;

/** A sound path is safe if it stays inside the project (or is explicit silence). */
function isSafeSoundPath(value) {
  return value === null || isSafeRelativePath(value);
}

/**
 * The behaviour config implies for an event, before any rules override.
 * A state with no per-state config gets no sound and no pulse.
 */
function defaultBehaviorFor(config, event) {
  const states = config && typeof config.states === 'object' ? config.states : {};
  const entry = states && Object.hasOwn(states, event.type) ? states[event.type] : null;

  const sound =
    entry && typeof entry.sound === 'string' && isSafeRelativePath(entry.sound) ? entry.sound : null;
  const scalePulse =
    entry && Number.isFinite(entry.scalePulse) && entry.scalePulse >= MIN_PULSE && entry.scalePulse <= MAX_PULSE
      ? entry.scalePulse
      : 1;

  return { sound, scalePulse };
}

function isValidPulse(v) {
  return Number.isFinite(v) && v >= MIN_PULSE && v <= MAX_PULSE;
}

/**
 * Validate the untrusted return value of the user's rules function.
 *
 * - `null` => suppress the event entirely.
 * - a non-object => fall back to the whole default.
 * - an object => take each field only if it is in contract, else that field's
 *   default. A wrong `scalePulse` does not discard a good `sound`.
 *
 * @returns {{scalePulse:number, sound:string|null}|null}
 */
function sanitizeRulesResult(raw, defaultBehavior) {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ...defaultBehavior };

  const scalePulse = isValidPulse(raw.scalePulse) ? raw.scalePulse : defaultBehavior.scalePulse;

  let sound = defaultBehavior.sound;
  if (Object.hasOwn(raw, 'sound')) {
    if (raw.sound === null) sound = null;
    else if (typeof raw.sound === 'string' && isSafeRelativePath(raw.sound)) sound = raw.sound;
    // any other type: keep the default
  }

  return { scalePulse, sound };
}

module.exports = {
  defaultBehaviorFor,
  sanitizeRulesResult,
  isSafeSoundPath,
  MIN_PULSE,
  MAX_PULSE,
};
