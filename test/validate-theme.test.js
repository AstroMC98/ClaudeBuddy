'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectSheetInfo, validateThemeDir } = require('../src/theme-loader.js');
const { PNG_SIGNATURE } = require('../src/png.js');

/** Write a PNG with a real header but no meaningful pixel data. */
function writeFakePng(file, width, height, colorType = 6) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(0, 0);
  fs.writeFileSync(
    file,
    Buffer.concat([
      PNG_SIGNATURE,
      len,
      Buffer.from('IHDR'),
      ihdr,
      Buffer.alloc(4),
      idatLen,
      Buffer.from('IDAT'),
      Buffer.alloc(4),
    ]),
  );
}

function makeThemeDir(manifest, sheets = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-theme-'));
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(manifest, null, 2), 'utf8');
  for (const [name, dims] of Object.entries(sheets)) {
    writeFakePng(path.join(dir, name), dims.width, dims.height, dims.colorType ?? 6);
  }
  return dir;
}

const MOCHI_MANIFEST = {
  name: 'Mochi',
  states: {
    sleeping: {
      sheet: 'sleeping.png',
      grid: { cols: 8, rows: 4 },
      fps: 4,
      loop: true,
      variants: [[0, 7], [8, 15], [16, 23], [24, 31]],
    },
  },
};

test('validates a correct theme directory', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, { 'sleeping.png': { width: 1920, height: 1080 } });
  const { errors, theme } = validateThemeDir(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(theme.states.sleeping.frame, { width: 240, height: 270 });
});

test('reports a missing theme.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-theme-'));
  const { errors } = validateThemeDir(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /theme\.json/);
});

test('reports malformed JSON without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-theme-'));
  fs.writeFileSync(path.join(dir, 'theme.json'), '{ not json', 'utf8');
  const { errors } = validateThemeDir(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /JSON/i);
});

test('reports a sheet whose geometry contradicts the grid', () => {
  // 1900 does not divide evenly by 8 (unlike 1000, which would silently pass
  // at 125px/frame) — this must be a width the 8x4 grid genuinely disagrees with.
  const dir = makeThemeDir(MOCHI_MANIFEST, { 'sleeping.png': { width: 1900, height: 1080 } });
  const { errors } = validateThemeDir(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /grid/);
});

test('reports a sheet with no alpha channel', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, {
    'sleeping.png': { width: 1920, height: 1080, colorType: 2 },
  });
  const { errors } = validateThemeDir(dir);
  assert.match(errors[0], /alpha/i);
});

test('collectSheetInfo reports null for a missing file', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, {});
  const info = collectSheetInfo(dir, MOCHI_MANIFEST);
  assert.equal(info['sleeping.png'], null);
});

test('collectSheetInfo refuses a sheet path that escapes the theme directory', () => {
  const manifest = { name: 'Evil', states: { idle: { sheet: '../../etc/passwd', frames: 1 } } };
  const dir = makeThemeDir(manifest, {});
  const info = collectSheetInfo(dir, manifest);
  assert.equal(info['../../etc/passwd'], null);
});

test('reports a filename whose case differs from the manifest', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, {});
  // theme.json asks for "sleeping.png"; write it with a capital S instead.
  writeFakePng(path.join(dir, 'Sleeping.png'), 1920, 1080);

  const { errors } = validateThemeDir(dir);
  assert.ok(
    errors.some((e) => /case-sensitive/i.test(e)),
    `expected a case-mismatch error, got: ${JSON.stringify(errors)}`,
  );
});

test('does not flag a filename that matches the manifest exactly', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, {
    'sleeping.png': { width: 1920, height: 1080 },
  });
  const { errors } = validateThemeDir(dir);
  assert.deepEqual(errors, [], 'an exactly-matching filename must not be flagged');
});

test('the committed _template theme validates against its own documentation', () => {
  // The template ships no art, so every sheet is reported missing. What must
  // hold is that the manifest itself parses and names only real states.
  const templateDir = path.join(__dirname, '..', 'themes', '_template');
  const manifestFile = path.join(templateDir, 'theme.json');
  assert.ok(fs.existsSync(manifestFile), 'the _template theme must be committed');

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const { STATES } = require('../src/state-machine.js');
  for (const key of Object.keys(manifest.states)) {
    assert.ok(STATES.includes(key), `_template names an unknown state: ${key}`);
  }
});
