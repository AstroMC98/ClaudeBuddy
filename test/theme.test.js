'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateTheme, resolveStateGeometry } = require('../src/theme.js');

const SHEET = { width: 1920, height: 1080, hasAlpha: true };

const gridManifest = (overrides = {}) => ({
  name: 'Mochi',
  states: {
    sleeping: {
      sheet: 'sleeping.png',
      grid: { cols: 8, rows: 4 },
      fps: 4,
      loop: true,
      ...overrides,
    },
  },
});

test('accepts a valid grid theme and derives the frame size', () => {
  const { errors, theme } = validateTheme(gridManifest(), { 'sleeping.png': SHEET });
  assert.deepEqual(errors, []);
  assert.deepEqual(theme.states.sleeping.frame, { width: 240, height: 270 });
  assert.equal(theme.states.sleeping.totalFrames, 32);
});

test('accepts a valid strip theme', () => {
  const manifest = {
    name: 'Strip',
    frame: { width: 64, height: 64 },
    states: { idle: { sheet: 'idle.png', frames: 4, fps: 6, loop: true } },
  };
  const { errors, theme } = validateTheme(manifest, {
    'idle.png': { width: 256, height: 64, hasAlpha: true },
  });
  assert.deepEqual(errors, []);
  assert.equal(theme.states.idle.totalFrames, 4);
  assert.equal(theme.states.idle.cols, 4);
  assert.equal(theme.states.idle.rows, 1);
});

test('rejects a strip whose width does not match frames x frame width', () => {
  const manifest = {
    name: 'Bad',
    frame: { width: 64, height: 64 },
    states: { idle: { sheet: 'idle.png', frames: 5, fps: 6 } },
  };
  const { errors } = validateTheme(manifest, {
    'idle.png': { width: 256, height: 64, hasAlpha: true },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /idle/);
  assert.match(errors[0], /320/, 'the message should name the width it expected');
});

test('rejects a grid whose dimensions do not divide evenly', () => {
  const { errors } = validateTheme(gridManifest({ grid: { cols: 7, rows: 4 } }), {
    'sleeping.png': SHEET,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sleeping/);
});

test('reports a missing sheet file by name', () => {
  const { errors } = validateTheme(gridManifest(), { 'sleeping.png': null });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sleeping\.png/);
});

test('rejects a sheet with no alpha channel', () => {
  const { errors } = validateTheme(gridManifest(), {
    'sleeping.png': { ...SHEET, hasAlpha: false },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /alpha/i);
});

test('rejects an unknown state key rather than ignoring it', () => {
  const manifest = {
    name: 'Typo',
    states: { needsinput: { sheet: 'a.png', grid: { cols: 1, rows: 1 }, fps: 1 } },
  };
  const { errors } = validateTheme(manifest, {
    'a.png': { width: 10, height: 10, hasAlpha: true },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /needsinput/);
  assert.match(errors[0], /needsInput/, 'should suggest the correct casing');
});

test('rejects a sheet path that could escape the theme directory', () => {
  const manifest = {
    name: 'Evil',
    states: { idle: { sheet: '../../../../etc/passwd', frames: 1, fps: 1 } },
  };
  const { errors } = validateTheme(manifest, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /path/i);
});

test('rejects a range outside the frame count', () => {
  const { errors } = validateTheme(gridManifest({ range: [0, 99] }), { 'sleeping.png': SHEET });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /range/i);
});

test('rejects an inverted range', () => {
  const { errors } = validateTheme(gridManifest({ range: [10, 2] }), { 'sleeping.png': SHEET });
  assert.equal(errors.length, 1);
});

test('accepts variants and normalizes variantPick', () => {
  const { errors, theme } = validateTheme(
    gridManifest({ variants: [[0, 7], [8, 15], [16, 23], [24, 31]] }),
    { 'sleeping.png': SHEET },
  );
  assert.deepEqual(errors, []);
  assert.equal(theme.states.sleeping.variants.length, 4);
  assert.equal(theme.states.sleeping.variantPick, 'random');
});

test('rejects a variant outside the frame count', () => {
  const { errors } = validateTheme(gridManifest({ variants: [[0, 7], [8, 99]] }), {
    'sleeping.png': SHEET,
  });
  assert.equal(errors.length, 1);
});

test('warns but does not error when idle is absent', () => {
  const { errors, warnings } = validateTheme(gridManifest(), { 'sleeping.png': SHEET });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /idle/);
});

test('rejects a manifest with no states at all', () => {
  const { errors } = validateTheme({ name: 'Empty', states: {} }, {});
  assert.equal(errors.length, 1);
});

test('rejects a malformed manifest without throwing', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const { errors, theme } = validateTheme(bad, {});
    assert.ok(errors.length > 0);
    assert.equal(theme, null);
  }
});

test('defaults fps and loop when omitted', () => {
  const manifest = {
    name: 'Defaults',
    states: { idle: { sheet: 'idle.png', grid: { cols: 2, rows: 1 } } },
  };
  const { errors, theme } = validateTheme(manifest, {
    'idle.png': { width: 128, height: 64, hasAlpha: true },
  });
  assert.deepEqual(errors, []);
  assert.equal(theme.states.idle.fps, 8);
  assert.equal(theme.states.idle.loop, true);
});

test('a one-shot state resolves loop:false and carries no "next" field', () => {
  // Which state follows a one-shot is decided by the state machine
  // (src/state-machine.js's ONE_SHOT map), never by the theme manifest, so a
  // manifest-supplied "next" must not survive resolution even when present.
  const manifest = {
    name: 'OneShot',
    states: {
      done: { sheet: 'done.png', grid: { cols: 2, rows: 1 }, loop: false, next: 'idle' },
    },
  };
  const { theme } = validateTheme(manifest, {
    'done.png': { width: 128, height: 64, hasAlpha: true },
  });
  assert.equal(theme.states.done.loop, false);
  assert.equal(theme.states.done.next, undefined);
});

test('defaults offset to zero and accepts an explicit one', () => {
  const plain = validateTheme(gridManifest(), { 'sleeping.png': SHEET });
  assert.deepEqual(plain.theme.states.sleeping.offset, { x: 0, y: 0 });

  const nudged = validateTheme(gridManifest({ offset: { y: -12 } }), { 'sleeping.png': SHEET });
  assert.deepEqual(nudged.errors, []);
  assert.deepEqual(nudged.theme.states.sleeping.offset, { x: 0, y: -12 });
});

test('rejects a non-integer or malformed offset', () => {
  for (const bad of [{ y: 1.5 }, { x: 'left' }, 'down', [0, 1], null]) {
    const { errors } = validateTheme(gridManifest({ offset: bad }), { 'sleeping.png': SHEET });
    assert.equal(errors.length, 1, `should reject ${JSON.stringify(bad)}`);
  }
});

test('resolveStateGeometry maps a frame index to a grid position', () => {
  const geom = resolveStateGeometry({ grid: { cols: 8, rows: 4 } }, SHEET);
  assert.deepEqual(geom.frame, { width: 240, height: 270 });
  assert.equal(geom.cols, 8);
  assert.equal(geom.totalFrames, 32);
});

test('derives a strip frame height from the sheet when only width is declared', () => {
  const manifest = { name: 'S', frame: { width: 64 }, states: { idle: { sheet: 'idle.png', frames: 4 } } };
  const { errors, theme } = validateTheme(manifest, {
    'idle.png': { width: 256, height: 64, hasAlpha: true },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(theme.states.idle.frame, { width: 64, height: 64 });
});

test('rejects a strip whose declared frame height disagrees with the sheet', () => {
  const manifest = {
    name: 'S',
    states: { idle: { sheet: 'idle.png', frames: 4, frame: { width: 64, height: 999 } } },
  };
  const { errors } = validateTheme(manifest, {
    'idle.png': { width: 256, height: 64, hasAlpha: true },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /height/);
});

test('rejects a grid whose own declared frame disagrees with the grid', () => {
  const manifest = {
    name: 'G',
    states: { idle: { sheet: 's.png', grid: { cols: 8, rows: 4 }, frame: { width: 999, height: 999 } } },
  };
  const { errors } = validateTheme(manifest, {
    's.png': { width: 1920, height: 1080, hasAlpha: true },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /disagree/i);
});

test('a top-level frame does not conflict with a grid state', () => {
  // The top-level frame serves this theme's strip state; the grid state
  // derives its own size and must not be failed for inheriting it.
  const manifest = {
    name: 'Mixed',
    frame: { width: 64, height: 64 },
    states: {
      idle: { sheet: 'idle.png', frames: 4 },
      sleeping: { sheet: 's.png', grid: { cols: 8, rows: 4 } },
    },
  };
  const { errors, theme } = validateTheme(manifest, {
    'idle.png': { width: 256, height: 64, hasAlpha: true },
    's.png': { width: 1920, height: 1080, hasAlpha: true },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(theme.states.idle.frame, { width: 64, height: 64 });
  assert.deepEqual(theme.states.sleeping.frame, { width: 240, height: 270 });
});

test('handles a null or array states block without throwing', () => {
  for (const bad of [{ states: null }, { states: [] }]) {
    const { errors, theme } = validateTheme(bad, {});
    assert.equal(theme, null, `${JSON.stringify(bad)} must not resolve a theme`);
    assert.equal(errors.length, 1);
  }
});
