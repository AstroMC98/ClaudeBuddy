'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadAssets, toDataUri } = require('../src/assets.js');
const { DEFAULTS } = require('../src/config.js');
const { PNG_SIGNATURE } = require('../src/png.js');

function writeFakePng(file, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(0, 0);
  fs.writeFileSync(
    file,
    Buffer.concat([
      PNG_SIGNATURE, len, Buffer.from('IHDR'), ihdr, Buffer.alloc(4),
      idatLen, Buffer.from('IDAT'), Buffer.alloc(4),
    ]),
  );
}

/** Build a throwaway project root with a theme and a sounds folder. */
function makeProject({ theme = null, sounds = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-assets-'));
  if (theme) {
    const dir = path.join(root, 'themes', theme.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme.manifest), 'utf8');
    for (const [file, dims] of Object.entries(theme.sheets ?? {})) {
      writeFakePng(path.join(dir, file), dims.width, dims.height);
    }
  }
  if (Object.keys(sounds).length > 0) {
    fs.mkdirSync(path.join(root, 'sounds'), { recursive: true });
    for (const [file, bytes] of Object.entries(sounds)) {
      fs.writeFileSync(path.join(root, 'sounds', file), Buffer.from(bytes), 'utf8');
    }
  }
  return root;
}

const MOCHI = {
  name: 'mochi',
  manifest: {
    name: 'Mochi',
    scale: 0.6,
    states: {
      sleeping: { sheet: 'sleeping.png', grid: { cols: 8, rows: 4 }, fps: 4, loop: true },
    },
  },
  sheets: { 'sleeping.png': { width: 1920, height: 1080 } },
};

test('toDataUri picks a mime type from the extension', () => {
  assert.match(toDataUri(Buffer.from('x'), 'a.png'), /^data:image\/png;base64,/);
  assert.match(toDataUri(Buffer.from('x'), 'a.mp3'), /^data:audio\/mpeg;base64,/);
  assert.match(toDataUri(Buffer.from('x'), 'a.wav'), /^data:audio\/wav;base64,/);
  assert.match(toDataUri(Buffer.from('x'), 'a.ogg'), /^data:audio\/ogg;base64,/);
});

test('toDataUri refuses an unknown extension', () => {
  assert.equal(toDataUri(Buffer.from('x'), 'a.exe'), null);
  assert.equal(toDataUri(Buffer.from('x'), 'noext'), null);
});

test('the procedural theme loads no theme and no sheets', () => {
  const root = makeProject();
  const assets = loadAssets({ ...DEFAULTS, theme: 'procedural', states: {} }, root);
  assert.equal(assets.theme, null);
  assert.deepEqual(assets.sheets, {});
  assert.deepEqual(assets.problems, []);
});

test('loads a theme and inlines its sheet as a data URI', () => {
  const root = makeProject({ theme: MOCHI });
  const assets = loadAssets({ ...DEFAULTS, theme: 'mochi', states: {} }, root);
  assert.deepEqual(assets.problems, []);
  assert.equal(assets.theme.name, 'Mochi');
  assert.equal(assets.theme.scale, 0.6);
  assert.match(assets.sheets['sleeping.png'], /^data:image\/png;base64,/);
});

test('a missing theme directory degrades to procedural with a problem reported', () => {
  const root = makeProject();
  const assets = loadAssets({ ...DEFAULTS, theme: 'nope', states: {} }, root);
  assert.equal(assets.theme, null);
  assert.ok(assets.problems.length > 0);
  assert.match(assets.problems[0], /nope/);
});

test('an invalid theme degrades to procedural rather than throwing', () => {
  const broken = {
    name: 'broken',
    manifest: { name: 'Broken', states: { sleeping: { sheet: 'missing.png', frames: 4 } } },
    sheets: {},
  };
  const root = makeProject({ theme: broken });
  const assets = loadAssets({ ...DEFAULTS, theme: 'broken', states: {} }, root);
  assert.equal(assets.theme, null);
  assert.ok(assets.problems.length > 0);
});

test('loads per-state sounds', () => {
  const root = makeProject({ sounds: { 'tada.mp3': 'fake-audio' } });
  const assets = loadAssets(
    { ...DEFAULTS, theme: 'procedural', states: { done: { sound: 'sounds/tada.mp3' } } },
    root,
  );
  assert.match(assets.sounds.done, /^data:audio\/mpeg;base64,/);
  assert.deepEqual(assets.problems, []);
});

test('a missing sound file is reported and skipped, not fatal', () => {
  const root = makeProject();
  const assets = loadAssets(
    { ...DEFAULTS, theme: 'procedural', states: { done: { sound: 'sounds/absent.mp3' } } },
    root,
  );
  assert.equal(assets.sounds.done, undefined);
  assert.equal(assets.problems.length, 1);
  assert.match(assets.problems[0], /absent\.mp3/);
});

test('refuses a sound path that escapes the project root', () => {
  const root = makeProject();
  const assets = loadAssets(
    { ...DEFAULTS, theme: 'procedural', states: { done: { sound: '../../../etc/passwd' } } },
    root,
  );
  assert.equal(assets.sounds.done, undefined);
  assert.ok(assets.problems.length > 0);
});

test('passes sound settings and per-state scalePulse through', () => {
  const root = makeProject();
  const assets = loadAssets(
    {
      ...DEFAULTS,
      theme: 'procedural',
      sound: { enabled: false, volume: 0.2 },
      states: { done: { scalePulse: 1.4 } },
    },
    root,
  );
  assert.deepEqual(assets.sound, { enabled: false, volume: 0.2 });
  assert.equal(assets.states.done.scalePulse, 1.4);
});
