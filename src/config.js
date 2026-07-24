'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { STATES } = require('./state-machine.js');

/** Reserved theme name selecting the built-in procedural blob. */
const PROCEDURAL_THEME = 'procedural';

/** Default configuration. Frozen so callers cannot corrupt it. */
const DEFAULTS = Object.freeze({
  port: 4747,
  token: null,
  idleTimeoutMinutes: 10,
  scale: 1.0,
  alwaysOnTop: true,
  width: 320,
  height: 320,
  theme: PROCEDURAL_THEME,
  sound: Object.freeze({ enabled: true, volume: 0.5 }),
  states: Object.freeze({}),
  position: null,
  clickThrough: true,
});

/**
 * True for a relative path that cannot escape its base directory.
 *
 * These values come from a user-editable JSON file and are joined onto real
 * filesystem paths in the main process, so `../../../../etc/passwd` must never
 * survive. Backslashes are rejected outright rather than normalized: a theme
 * that works on Windows and breaks on Linux is worse than one that is refused
 * consistently.
 */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').includes('..');
}

/** A theme name is a single directory component, never a path. */
function isSafeThemeName(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value === PROCEDURAL_THEME) return true;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value === '.' || value === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

const SOUND_VALIDATORS = Object.freeze({
  enabled: (v) => typeof v === 'boolean',
  volume: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
});

const STATE_ENTRY_VALIDATORS = Object.freeze({
  sound: (v) => v === null || isSafeRelativePath(v),
  scalePulse: (v) => Number.isFinite(v) && v >= 0.1 && v <= 4,
});

/** Merge a nested object key by key, dropping unknown and wrong-typed values. */
function mergeNested(defaults, parsed, validators) {
  const out = { ...defaults };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const key of Object.keys(validators)) {
    if (!Object.hasOwn(parsed, key)) continue;
    if (validators[key](parsed[key])) out[key] = parsed[key];
  }
  return out;
}

/** Per-state settings, keyed by real state names only. */
function parseStates(parsed) {
  const out = {};
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

  for (const state of STATES) {
    if (!Object.hasOwn(parsed, state)) continue;
    const entry = parsed[state];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const clean = {};
    for (const key of Object.keys(STATE_ENTRY_VALIDATORS)) {
      if (!Object.hasOwn(entry, key)) continue;
      if (STATE_ENTRY_VALIDATORS[key](entry[key])) clean[key] = entry[key];
    }
    out[state] = clean;
  }
  return out;
}

const VALIDATORS = Object.freeze({
  port: (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
  token: (v) => v === null || (typeof v === 'string' && v.length > 0),
  idleTimeoutMinutes: (v) => Number.isFinite(v) && v > 0,
  scale: (v) => Number.isFinite(v) && v > 0 && v <= 8,
  alwaysOnTop: (v) => typeof v === 'boolean',
  width: (v) => Number.isInteger(v) && v > 0 && v <= 4096,
  height: (v) => Number.isInteger(v) && v > 0 && v <= 4096,
  theme: isSafeThemeName,
  position: (v) => v === null || (v !== null && typeof v === 'object' && !Array.isArray(v) && Number.isInteger(v.x) && Number.isInteger(v.y)),
  clickThrough: (v) => typeof v === 'boolean',
});

/** Path to the user's config file at the project root. */
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Load configuration, validating the user's file against the defaults.
 * Never throws: any missing, unreadable, or malformed file yields the defaults.
 * Unknown keys are dropped and wrong-typed values fall back to their default,
 * so the returned object always has exactly the Config shape.
 *
 * @param {string} [filePath]
 * @returns {typeof DEFAULTS}
 */
function loadConfig(filePath = CONFIG_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { ...DEFAULTS, sound: { ...DEFAULTS.sound }, states: {} };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULTS, sound: { ...DEFAULTS.sound }, states: {} };
  }

  const config = { ...DEFAULTS };
  for (const key of Object.keys(VALIDATORS)) {
    if (!Object.hasOwn(parsed, key)) continue;
    if (VALIDATORS[key](parsed[key])) config[key] = parsed[key];
  }

  config.sound = mergeNested(DEFAULTS.sound, parsed.sound, SOUND_VALIDATORS);
  config.states = parseStates(parsed.states);

  return config;
}

module.exports = {
  loadConfig,
  DEFAULTS,
  CONFIG_PATH,
  PROCEDURAL_THEME,
  isSafeRelativePath,
  isSafeThemeName,
};
