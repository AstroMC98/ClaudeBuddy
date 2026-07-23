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

/** Path to the user's config file at the project root. */
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Load configuration, merging the user's file over the defaults.
 * Never throws: any missing, unreadable, or malformed file yields the defaults.
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
  return { ...DEFAULTS, ...parsed };
}

module.exports = { loadConfig, DEFAULTS, CONFIG_PATH };
