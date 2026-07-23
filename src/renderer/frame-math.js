'use strict';

/**
 * Pure sprite-sheet frame arithmetic.
 *
 * Loaded two ways from this single file: `require()`d by the Node test runner,
 * and pulled in with a <script> tag by the renderer, which is sandboxed and
 * therefore cannot require(). Keeping one file avoids two copies drifting.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api;
  } else {
    root.frameMath = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * Background offset for a frame index, in reading order: left to right, then
   * top to bottom. Values are negative because they shift the sheet behind a
   * fixed viewport, rather than moving the viewport.
   */
  function frameOffset(index, cols, frame) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    // `|| 0` normalizes -0 (produced when col or row is 0) to +0. Without it,
    // frameOffset(0, cols, frame) returns {x: -0, y: -0}, which fails
    // assert.deepEqual under node:assert/strict (an alias for
    // deepStrictEqual, which distinguishes -0 from +0 via SameValue) even
    // though -0 and 0px are visually identical background-position values.
    return { x: (-col * frame.width) || 0, y: (-row * frame.height) || 0 };
  }

  /** Expand an inclusive [from, to] range into a list of frame indices. */
  function framesOf(range) {
    const out = [];
    for (let i = range[0]; i <= range[1]; i += 1) out.push(i);
    return out;
  }

  /**
   * Choose which variant to play on entering a state.
   * `entryCount` makes sequential mode deterministic, and therefore testable.
   */
  function pickVariant(variants, mode, entryCount) {
    if (variants.length === 1) return variants[0];
    if (mode === 'sequential') return variants[entryCount % variants.length];
    return variants[Math.floor(Math.random() * variants.length)];
  }

  return { frameOffset, framesOf, pickVariant };
});
