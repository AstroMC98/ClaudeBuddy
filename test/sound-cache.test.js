'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSoundCache } = require('../src/sound-cache.js');

function projectWithSound(rel, bytes = 'fake-audio') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-snd-'));
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(bytes));
  return root;
}

test('resolves a real sound to a data URI', () => {
  const root = projectWithSound('sounds/tada.mp3');
  const cache = createSoundCache(root);
  assert.match(cache.resolve('sounds/tada.mp3'), /^data:audio\/mpeg;base64,/);
});

test('returns null for a null path', () => {
  const cache = createSoundCache(projectWithSound('sounds/a.mp3'));
  assert.equal(cache.resolve(null), null);
});

test('returns null for an unsafe path without reading it', () => {
  const cache = createSoundCache(projectWithSound('sounds/a.mp3'));
  for (const evil of ['../x', '/etc/passwd', 'a\\b', 'a/../../b']) {
    assert.equal(cache.resolve(evil), null);
  }
});

test('returns null for a missing file', () => {
  const cache = createSoundCache(projectWithSound('sounds/a.mp3'));
  assert.equal(cache.resolve('sounds/absent.mp3'), null);
});

test('returns null for an unsupported extension', () => {
  const root = projectWithSound('sounds/x.exe');
  const cache = createSoundCache(root);
  assert.equal(cache.resolve('sounds/x.exe'), null);
});

test('caches by path — the file is read once', () => {
  const root = projectWithSound('sounds/a.mp3', 'v1');
  const cache = createSoundCache(root);
  const first = cache.resolve('sounds/a.mp3');
  // Overwrite the file; a cached resolver must still return the first bytes.
  fs.writeFileSync(path.join(root, 'sounds/a.mp3'), Buffer.from('v2-different'));
  assert.equal(cache.resolve('sounds/a.mp3'), first);
});

test('caches null results too, so a missing file is not retried every event', () => {
  const root = projectWithSound('sounds/a.mp3');
  const cache = createSoundCache(root);
  assert.equal(cache.resolve('sounds/missing.mp3'), null);
  // Create it after the miss; the cache should still report null.
  fs.writeFileSync(path.join(root, 'sounds/missing.mp3'), Buffer.from('now here'));
  assert.equal(cache.resolve('sounds/missing.mp3'), null);
});
