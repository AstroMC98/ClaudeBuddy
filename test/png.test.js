'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readPngHeader, PNG_SIGNATURE } = require('../src/png.js');

/** Build a minimal PNG header for a given geometry and colour type. */
function fakePng(width, height, colorType, { withTrns = false } = {}) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = colorType;

  const chunks = [PNG_SIGNATURE];

  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  chunks.push(ihdrLen, Buffer.from('IHDR'), ihdrData, Buffer.alloc(4));

  if (withTrns) {
    const trnsLen = Buffer.alloc(4);
    trnsLen.writeUInt32BE(2, 0);
    chunks.push(trnsLen, Buffer.from('tRNS'), Buffer.alloc(2), Buffer.alloc(4));
  }

  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(0, 0);
  chunks.push(idatLen, Buffer.from('IDAT'), Buffer.alloc(4));

  return Buffer.concat(chunks);
}

test('reads dimensions from a PNG header', () => {
  const header = readPngHeader(fakePng(1920, 1080, 6));
  assert.equal(header.width, 1920);
  assert.equal(header.height, 1080);
  assert.equal(header.bitDepth, 8);
});

test('reports alpha for RGBA and grey+alpha', () => {
  assert.equal(readPngHeader(fakePng(10, 10, 6)).hasAlpha, true);
  assert.equal(readPngHeader(fakePng(10, 10, 4)).hasAlpha, true);
});

test('reports no alpha for RGB and greyscale', () => {
  assert.equal(readPngHeader(fakePng(10, 10, 2)).hasAlpha, false);
  assert.equal(readPngHeader(fakePng(10, 10, 0)).hasAlpha, false);
});

test('reports alpha for a palette PNG only when tRNS is present', () => {
  assert.equal(readPngHeader(fakePng(10, 10, 3)).hasAlpha, false);
  assert.equal(readPngHeader(fakePng(10, 10, 3, { withTrns: true })).hasAlpha, true);
});

test('returns null for a non-PNG buffer', () => {
  assert.equal(readPngHeader(Buffer.from('this is not a png at all')), null);
  assert.equal(readPngHeader(Buffer.alloc(4)), null);
  assert.equal(readPngHeader(Buffer.alloc(0)), null);
});

test('returns null for a truncated PNG', () => {
  assert.equal(readPngHeader(fakePng(10, 10, 6).subarray(0, 20)), null);
});

test('reads the real Mochi sheet', (t) => {
  const sheet = path.join(__dirname, '..', 'assets', 'sprites', 'mochi', 'sleeping.png');
  if (!fs.existsSync(sheet)) return t.skip('Mochi master sheet not present');

  const header = readPngHeader(fs.readFileSync(sheet));
  assert.equal(header.width, 1920);
  assert.equal(header.height, 1080);
  assert.equal(header.hasAlpha, true, 'the master sheet must have a real alpha channel');
});

test('returns null for spec-illegal zero dimensions', () => {
  assert.equal(readPngHeader(fakePng(0, 0, 6)), null);
  assert.equal(readPngHeader(fakePng(1920, 0, 6)), null);
  assert.equal(readPngHeader(fakePng(0, 1080, 6)), null);
  assert.equal(readPngHeader(fakePng(1, 1, 6)).width, 1, '1x1 is legal and must still parse');
});

test('returns null when the first chunk is not IHDR', () => {
  // Long enough to clear the length guard, correct signature, wrong tag —
  // so this reaches the IHDR check rather than being rejected earlier.
  const buf = fakePng(64, 64, 6);
  buf.write('IHDX', 12, 'ascii');
  assert.equal(readPngHeader(buf), null);
});
