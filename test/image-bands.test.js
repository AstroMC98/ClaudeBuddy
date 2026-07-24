'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectBands, gridGeometry, baselineTop, centeredLeft } = require('../src/image-bands.js');

test('detects a single contiguous band', () => {
  // profile: zeros, then content at 2..5, then zeros
  const profile = [0, 0, 3, 4, 5, 2, 0, 0];
  assert.deepEqual(detectBands(profile, {}), [[2, 5]]);
});

test('detects multiple bands separated by gaps', () => {
  const profile = [1, 1, 0, 0, 0, 2, 2, 0, 3];
  assert.deepEqual(detectBands(profile, {}), [[0, 1], [5, 6], [8, 8]]);
});

test('merges bands separated by a gap no larger than mergeGap', () => {
  const profile = [1, 1, 0, 1, 1]; // gap of 1 at index 2
  assert.deepEqual(detectBands(profile, { mergeGap: 1 }), [[0, 4]]);
  assert.deepEqual(detectBands(profile, { mergeGap: 0 }), [[0, 1], [3, 4]]);
});

test('drops runs shorter than minRun', () => {
  const profile = [1, 0, 1, 1, 1, 0, 1]; // runs of length 1, 3, 1
  assert.deepEqual(detectBands(profile, { minRun: 2 }), [[2, 4]]);
});

test('returns an empty list for an all-zero profile', () => {
  assert.deepEqual(detectBands([0, 0, 0], {}), []);
  assert.deepEqual(detectBands([], {}), []);
});

test('handles a band running to the end of the profile', () => {
  assert.deepEqual(detectBands([0, 0, 1, 1], {}), [[2, 3]]);
});

test('gridGeometry derives an even frame size', () => {
  assert.deepEqual(gridGeometry(1920, 1080, 8, 4), { frameW: 240, frameH: 270, exact: true });
});

test('gridGeometry reports a sheet that does not divide evenly', () => {
  const g = gridGeometry(1921, 1080, 8, 4);
  assert.equal(g.frameW, 240); // Math.floor
  assert.equal(g.exact, false);
});

test('baselineTop places a band so its bottom sits on the baseline', () => {
  // band is 100px tall (top..bottom = 0..99); cell 270; baseline 250
  // draw so content bottom = 250 -> top at 250 - 100 = 150
  assert.equal(baselineTop(0, 99, 270, 250), 150);
});

test('baselineTop clamps so content never starts above the cell', () => {
  // a band taller than the baseline would go negative; clamp to 0
  assert.equal(baselineTop(0, 299, 270, 250), 0);
});

test('centeredLeft centres a band horizontally in the cell', () => {
  // band 100 wide (0..99) in a 240 cell -> left = (240-100)/2 = 70
  assert.equal(centeredLeft(0, 99, 240), 70);
});

test('centeredLeft rounds to a whole pixel', () => {
  // band 99 wide (0..98) in 240 -> (240-99)/2 = 70.5 -> 70 or 71, must be integer
  const left = centeredLeft(0, 98, 240);
  assert.equal(Number.isInteger(left), true);
});
