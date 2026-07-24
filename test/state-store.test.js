'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadState, saveState } = require('../src/state-store.js');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-state-')), 'state.json');
}

test('returns a null position when the file is missing', () => {
  assert.deepEqual(loadState(path.join(os.tmpdir(), 'no-such-state-4821.json')), { position: null });
});

test('round-trips a position', () => {
  const file = tmpFile();
  saveState(file, { position: { x: 100, y: 200 } });
  assert.deepEqual(loadState(file), { position: { x: 100, y: 200 } });
});

test('returns a null position for malformed json', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.deepEqual(loadState(file), { position: null });
});

test('returns a null position when position is not two integers', () => {
  const file = tmpFile();
  for (const bad of [{ position: { x: 1 } }, { position: [1, 2] }, { position: { x: 'a', y: 2 } }, {}]) {
    fs.writeFileSync(file, JSON.stringify(bad), 'utf8');
    assert.deepEqual(loadState(file), { position: null });
  }
});

test('saveState never throws on an unwritable path', () => {
  // A path whose parent does not exist and cannot be created silently.
  assert.doesNotThrow(() => saveState('/no/such/dir/deeper/state.json', { position: { x: 1, y: 2 } }));
});

test('saveState ignores a non-integer position rather than writing garbage', () => {
  const file = tmpFile();
  saveState(file, { position: { x: 1.5, y: 'nope' } });
  assert.deepEqual(loadState(file), { position: null });
});
