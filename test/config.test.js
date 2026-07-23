'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, DEFAULTS } = require('../src/config.js');

function tempConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('returns defaults when the file does not exist', () => {
  const cfg = loadConfig(path.join(os.tmpdir(), 'definitely-not-here-12345.json'));
  assert.deepEqual(cfg, DEFAULTS);
});

test('merges a partial config over the defaults', () => {
  const file = tempConfig(JSON.stringify({ port: 5000, scale: 0.5 }));
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 5000);
  assert.equal(cfg.scale, 0.5);
  assert.equal(cfg.idleTimeoutMinutes, DEFAULTS.idleTimeoutMinutes);
  assert.equal(cfg.alwaysOnTop, DEFAULTS.alwaysOnTop);
});

test('returns defaults when the file is malformed JSON', () => {
  const file = tempConfig('{ this is not json');
  assert.deepEqual(loadConfig(file), DEFAULTS);
});

test('returns defaults when the file contains a JSON non-object', () => {
  const file = tempConfig('[1, 2, 3]');
  assert.deepEqual(loadConfig(file), DEFAULTS);
});

test('does not mutate DEFAULTS across calls', () => {
  const file = tempConfig(JSON.stringify({ port: 9999 }));
  loadConfig(file);
  assert.equal(DEFAULTS.port, 4747);
});
