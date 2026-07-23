'use strict';

/**
 * Resolve a theme and its sounds from disk into an IPC-safe payload.
 *
 * The renderer runs sandboxed and cannot read files, so every asset crosses the
 * boundary as a `data:` URI produced here. Nothing in this module throws: a
 * broken theme or a missing sound degrades to the procedural blob or to silence,
 * and the reason is reported in `problems` for the tray and the console.
 */

const fs = require('node:fs');
const path = require('node:path');

const { isSafeRelativePath, PROCEDURAL_THEME } = require('./config.js');
const { validateThemeDir } = require('./theme-loader.js');

/** Only these types may be inlined. An unknown extension is refused outright. */
const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.apng': 'image/apng',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
});

function toDataUri(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const mime = Object.hasOwn(MIME_BY_EXTENSION, ext) ? MIME_BY_EXTENSION[ext] : null;
  if (mime === null) return null;
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function loadTheme(config, projectRoot, problems) {
  if (config.theme === PROCEDURAL_THEME) return { theme: null, sheets: {} };

  const themeDir = path.join(projectRoot, 'themes', config.theme);
  if (!fs.existsSync(themeDir)) {
    problems.push(`theme "${config.theme}" not found at themes/${config.theme}`);
    return { theme: null, sheets: {} };
  }

  // Note: theme *warnings* (e.g. "no idle state") are advisory, not load
  // failures — validate-theme.js itself treats a theme with only warnings as
  // valid — so they are deliberately NOT folded into `problems`, which is
  // reserved for things that could not be loaded.
  const { errors, theme } = validateThemeDir(themeDir);

  if (errors.length > 0 || theme === null) {
    problems.push(`theme "${config.theme}" is invalid: ${errors.join('; ')}`);
    return { theme: null, sheets: {} };
  }

  // Dedupe: several states may share one sheet, and these are large.
  const sheets = {};
  for (const state of Object.values(theme.states)) {
    if (Object.hasOwn(sheets, state.sheet)) continue;
    try {
      const uri = toDataUri(fs.readFileSync(path.join(themeDir, state.sheet)), state.sheet);
      if (uri === null) {
        problems.push(`theme "${config.theme}": unsupported image type ${state.sheet}`);
        return { theme: null, sheets: {} };
      }
      sheets[state.sheet] = uri;
    } catch (err) {
      problems.push(`theme "${config.theme}": could not read ${state.sheet} (${err.message})`);
      return { theme: null, sheets: {} };
    }
  }

  return { theme, sheets };
}

function loadSounds(config, projectRoot, problems) {
  const sounds = {};

  for (const [state, settings] of Object.entries(config.states ?? {})) {
    const rel = settings && settings.sound;
    if (typeof rel !== 'string') continue;

    if (!isSafeRelativePath(rel)) {
      problems.push(`sound for "${state}" has an unsafe path and was ignored`);
      continue;
    }

    try {
      const uri = toDataUri(fs.readFileSync(path.join(projectRoot, rel)), rel);
      if (uri === null) {
        problems.push(`sound for "${state}": unsupported audio type ${rel}`);
        continue;
      }
      sounds[state] = uri;
    } catch {
      problems.push(`sound for "${state}": ${rel} is missing or unreadable`);
    }
  }

  return sounds;
}

/**
 * @param {object} config a validated Config
 * @param {string} projectRoot
 */
function loadAssets(config, projectRoot) {
  const problems = [];
  const { theme, sheets } = loadTheme(config, projectRoot, problems);
  const sounds = loadSounds(config, projectRoot, problems);

  return {
    theme,
    sheets,
    sounds,
    sound: { ...config.sound },
    states: { ...config.states },
    problems,
  };
}

module.exports = { loadAssets, toDataUri, MIME_BY_EXTENSION };
