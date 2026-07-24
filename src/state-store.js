'use strict';

const fs = require('node:fs');

/** True for a plain {x, y} of two integers. */
function isPosition(p) {
  return (
    p !== null &&
    typeof p === 'object' &&
    !Array.isArray(p) &&
    Number.isInteger(p.x) &&
    Number.isInteger(p.y)
  );
}

/**
 * Load runtime state. Never throws: a missing, unreadable, or malformed file —
 * or one whose position is not two integers — yields `{ position: null }`.
 */
function loadState(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { position: null };
  }
  if (parsed === null || typeof parsed !== 'object') return { position: null };
  return { position: isPosition(parsed.position) ? { x: parsed.position.x, y: parsed.position.y } : null };
}

/**
 * Persist runtime state, best-effort. Never throws — a failed write just means
 * the pet forgets where it was, which must not crash it. A non-integer position
 * is dropped rather than written.
 */
function saveState(filePath, state) {
  const position = state && isPosition(state.position) ? { x: state.position.x, y: state.position.y } : null;
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({ position }, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

module.exports = { loadState, saveState, isPosition };
