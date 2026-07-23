'use strict';

/**
 * The filesystem half of theme loading.
 *
 * `src/theme.js` holds the pure validation rules; this module supplies it with
 * real sheet dimensions and catches the problems only a real directory can
 * have — a missing manifest, unreadable JSON, or a filename whose case differs
 * from what the manifest claims.
 */

const fs = require('node:fs');
const path = require('node:path');

const { readPngHeader } = require('./png.js');
const { validateTheme } = require('./theme.js');
const { isSafeRelativePath } = require('./config.js');

/**
 * Read the header of every sheet the manifest references.
 * A sheet that is missing, unreadable, unsafe, or not a PNG maps to `null`,
 * which `validateTheme` turns into a per-state error naming the file.
 */
function collectSheetInfo(themeDir, manifest) {
  const info = {};
  const states = manifest && typeof manifest.states === 'object' ? manifest.states : {};

  for (const entry of Object.values(states ?? {})) {
    const sheet = entry && entry.sheet;
    if (typeof sheet !== 'string' || Object.hasOwn(info, sheet)) continue;

    if (!isSafeRelativePath(sheet)) {
      info[sheet] = null;
      continue;
    }

    try {
      const header = readPngHeader(fs.readFileSync(path.join(themeDir, sheet)));
      info[sheet] = header;
    } catch {
      info[sheet] = null;
    }
  }
  return info;
}

/** Case-insensitive filename check, so a Mac/Linux-only break is caught here. */
function checkFilenameCase(themeDir, manifest) {
  const problems = [];
  let entries;
  try {
    entries = fs.readdirSync(themeDir);
  } catch {
    return problems;
  }
  const byLower = new Map(entries.map((e) => [e.toLowerCase(), e]));

  const states = manifest && typeof manifest.states === 'object' ? manifest.states : {};
  for (const entry of Object.values(states ?? {})) {
    const sheet = entry && entry.sheet;
    if (typeof sheet !== 'string' || !isSafeRelativePath(sheet)) continue;
    if (entries.includes(sheet)) continue;

    const actual = byLower.get(sheet.toLowerCase());
    if (actual) {
      problems.push(
        `theme.json says "${sheet}" but the file on disk is "${actual}". ` +
          `Filenames are case-sensitive on Linux and on case-sensitive macOS volumes.`,
      );
    }
  }
  return problems;
}

function validateThemeDir(themeDir) {
  const manifestFile = path.join(themeDir, 'theme.json');

  let raw;
  try {
    raw = fs.readFileSync(manifestFile, 'utf8');
  } catch {
    return { errors: [`no theme.json found in ${themeDir}`], warnings: [], theme: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return { errors: [`theme.json is not valid JSON: ${err.message}`], warnings: [], theme: null };
  }

  const caseProblems = checkFilenameCase(themeDir, manifest);
  const result = validateTheme(manifest, collectSheetInfo(themeDir, manifest));

  return { ...result, errors: [...caseProblems, ...result.errors] };
}

module.exports = { collectSheetInfo, validateThemeDir, checkFilenameCase };
