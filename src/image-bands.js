'use strict';

/**
 * Pure geometry for the import-sprite tool.
 *
 * The CLI feeds these functions 1-D alpha profiles (how many opaque pixels sit
 * in each row or column) extracted from a real canvas. Keeping the band-finding
 * and placement maths here — free of any canvas — is what makes the tricky part
 * testable without an image.
 */

/**
 * Contiguous runs of non-zero values in a 1-D profile.
 * Small gaps (<= mergeGap) are bridged; runs shorter than minRun are dropped.
 * Indices are inclusive.
 */
function detectBands(profile, { minRun = 1, mergeGap = 0 } = {}) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < profile.length; i += 1) {
    if (profile[i] > 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, profile.length - 1]);

  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] - 1 <= mergeGap) last[1] = run[1];
    else merged.push([...run]);
  }

  return merged.filter((b) => b[1] - b[0] + 1 >= minRun);
}

/** Even frame size for a cols x rows grid; `exact` false if it does not divide. */
function gridGeometry(sheetW, sheetH, cols, rows) {
  const frameW = Math.floor(sheetW / cols);
  const frameH = Math.floor(sheetH / rows);
  return { frameW, frameH, exact: frameW * cols === sheetW && frameH * rows === sheetH };
}

/**
 * The y at which to draw a band so its content bottom lands on `baseline`
 * within a cell of `cellHeight`. Clamped to >= 0 so a too-tall band is not
 * drawn starting above the cell.
 */
function baselineTop(bandTop, bandBottom, cellHeight, baseline) {
  const h = bandBottom - bandTop + 1;
  return Math.max(0, baseline - h);
}

/** The x to draw a band so it is horizontally centred in a cell. */
function centeredLeft(bandLeft, bandRight, cellWidth) {
  const w = bandRight - bandLeft + 1;
  return Math.round((cellWidth - w) / 2);
}

module.exports = { detectBands, gridGeometry, baselineTop, centeredLeft };
