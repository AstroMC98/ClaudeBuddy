'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { frameOffset, framesOf, pickVariant } = require('../src/renderer/frame-math.js');

const FRAME = { width: 240, height: 270 };

test('frame 0 sits at the origin', () => {
  assert.deepEqual(frameOffset(0, 8, FRAME), { x: 0, y: 0 });
});

test('frames advance left to right across a row', () => {
  assert.deepEqual(frameOffset(1, 8, FRAME), { x: -240, y: 0 });
  assert.deepEqual(frameOffset(7, 8, FRAME), { x: -1680, y: 0 });
});

test('frames wrap to the next row in reading order', () => {
  assert.deepEqual(frameOffset(8, 8, FRAME), { x: 0, y: -270 });
  assert.deepEqual(frameOffset(9, 8, FRAME), { x: -240, y: -270 });
  assert.deepEqual(frameOffset(31, 8, FRAME), { x: -1680, y: -810 });
});

test('a single-row strip never advances vertically', () => {
  for (let i = 0; i < 4; i += 1) {
    assert.equal(frameOffset(i, 4, FRAME).y, 0);
  }
});

test('framesOf expands an inclusive range', () => {
  assert.deepEqual(framesOf([0, 3]), [0, 1, 2, 3]);
  assert.deepEqual(framesOf([8, 8]), [8]);
  assert.deepEqual(framesOf([2, 5]), [2, 3, 4, 5]);
});

test('pickVariant returns the only variant when there is one', () => {
  assert.deepEqual(pickVariant([[0, 7]], 'random', 0), [0, 7]);
  assert.deepEqual(pickVariant([[0, 7]], 'sequential', 5), [0, 7]);
});

test('pickVariant cycles in sequential mode', () => {
  const variants = [[0, 7], [8, 15], [16, 23]];
  assert.deepEqual(pickVariant(variants, 'sequential', 0), [0, 7]);
  assert.deepEqual(pickVariant(variants, 'sequential', 1), [8, 15]);
  assert.deepEqual(pickVariant(variants, 'sequential', 3), [0, 7], 'wraps around');
});

test('pickVariant stays in range in random mode', () => {
  const variants = [[0, 7], [8, 15], [16, 23], [24, 31]];
  for (let i = 0; i < 200; i += 1) {
    assert.ok(variants.includes(pickVariant(variants, 'random', i)));
  }
});
