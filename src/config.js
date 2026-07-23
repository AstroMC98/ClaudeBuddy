'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Default configuration. Frozen so callers cannot corrupt it. */
const DEFAULTS = Object.freeze({
  port: 4747,
  token: null,
  idleTimeoutMinutes: 10,
  scale: 1.0,
  alwaysOnTop: true,
  width: 320,
  height: 320,
});

/**
 * A type guard per key. A user value is accepted only if it satisfies its
 * guard; anything else falls back to the default.
 *
 * This matters because consumers do arithmetic on these values. A string
 * `idleTimeoutMinutes` would become NaN downstream and the buddy would simply
 * never fall asleep — a silent failure with no error to trace. Validating once
 * here means every later module can trust the Config contract.
 */
const VALIDATORS = Object.freeze({
  port: (v) => Number.isInteger(v) && v >= 0 && v <= 65535,
  token: (v) => v === null || (typeof v === 'string' && v.length > 0),
  idleTimeoutMinutes: (v) => Number.isFinite(v) && v > 0,
  scale: (v) => Number.isFinite(v) && v > 0,
  alwaysOnTop: (v) => typeof v === 'boolean',
  width: (v) => Number.isInteger(v) && v > 0,
  height: (v) => Number.isInteger(v) && v > 0,
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
    return { ...DEFAULTS };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULTS };
  }

  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.hasOwn(parsed, key)) continue;
    if (VALIDATORS[key](parsed[key])) config[key] = parsed[key];
  }
  return config;
}

module.exports = { loadConfig, DEFAULTS, CONFIG_PATH };
