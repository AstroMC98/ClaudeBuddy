'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, DEFAULTS, isSafeRelativePath } = require('../src/config.js');

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

test('drops unknown keys so the shape is exactly Config', () => {
  const file = tempConfig(JSON.stringify({ port: 5000, nonsense: 'x' }));
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 5000);
  assert.deepEqual(Object.keys(cfg).sort(), Object.keys(DEFAULTS).sort());
});

test('falls back to the default for a wrong-typed value', () => {
  const file = tempConfig(
    JSON.stringify({
      port: '5000',
      idleTimeoutMinutes: 'soon',
      alwaysOnTop: 'yes',
      scale: null,
      token: 42,
    }),
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.port, DEFAULTS.port);
  assert.equal(cfg.idleTimeoutMinutes, DEFAULTS.idleTimeoutMinutes);
  assert.equal(cfg.alwaysOnTop, DEFAULTS.alwaysOnTop);
  assert.equal(cfg.scale, DEFAULTS.scale);
  assert.equal(cfg.token, DEFAULTS.token);
});

test('rejects out-of-range and nonsensical numbers', () => {
  const file = tempConfig(
    JSON.stringify({ port: 99999, scale: 0, width: -10, idleTimeoutMinutes: 0 }),
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.port, DEFAULTS.port);
  assert.equal(cfg.scale, DEFAULTS.scale);
  assert.equal(cfg.width, DEFAULTS.width);
  assert.equal(cfg.idleTimeoutMinutes, DEFAULTS.idleTimeoutMinutes);
});

test('accepts a valid token string and an explicit null', () => {
  assert.equal(loadConfig(tempConfig('{"token":"s3cret"}')).token, 's3cret');
  assert.equal(loadConfig(tempConfig('{"token":null}')).token, null);
});

test('rejects port 0, which would silently break event delivery', () => {
  const file = tempConfig(JSON.stringify({ port: 0 }));
  assert.equal(loadConfig(file).port, DEFAULTS.port);
});

test('rejects absurd window dimensions', () => {
  const file = tempConfig(JSON.stringify({ width: 50000000, height: 99999, scale: 500 }));
  const cfg = loadConfig(file);
  assert.equal(cfg.width, DEFAULTS.width);
  assert.equal(cfg.height, DEFAULTS.height);
  assert.equal(cfg.scale, DEFAULTS.scale);
});

test('defaults include the new theme, sound and states keys', () => {
  const cfg = loadConfig(path.join(os.tmpdir(), 'buddy-absent-77123.json'));
  assert.equal(cfg.theme, 'procedural');
  assert.deepEqual(cfg.sound, { enabled: true, volume: 0.5 });
  assert.deepEqual(cfg.states, {});
});

test('accepts a valid theme name', () => {
  const file = tempConfig(JSON.stringify({ theme: 'mochi' }));
  assert.equal(loadConfig(file).theme, 'mochi');
});

test('rejects a theme name that could escape the themes directory', () => {
  for (const evil of ['../secrets', 'a/b', 'a\\b', '..', '/etc/passwd', 'C:\\Windows', '']) {
    const file = tempConfig(JSON.stringify({ theme: evil }));
    assert.equal(loadConfig(file).theme, 'procedural', `should reject ${JSON.stringify(evil)}`);
  }
});

test('merges the sound block key by key', () => {
  const file = tempConfig(JSON.stringify({ sound: { volume: 0.25 } }));
  assert.deepEqual(loadConfig(file).sound, { enabled: true, volume: 0.25 });
});

test('rejects a wrong-typed or out-of-range sound value', () => {
  const file = tempConfig(JSON.stringify({ sound: { enabled: 'yes', volume: 9 } }));
  assert.deepEqual(loadConfig(file).sound, { enabled: true, volume: 0.5 });
});

test('rejects a non-object sound block', () => {
  const file = tempConfig(JSON.stringify({ sound: 'loud' }));
  assert.deepEqual(loadConfig(file).sound, { enabled: true, volume: 0.5 });
});

test('keeps per-state settings for real states only', () => {
  const file = tempConfig(
    JSON.stringify({
      states: {
        done: { sound: 'sounds/tada.mp3', scalePulse: 1.4 },
        notAState: { sound: 'sounds/x.mp3' },
      },
    }),
  );
  const cfg = loadConfig(file);
  assert.deepEqual(cfg.states.done, { sound: 'sounds/tada.mp3', scalePulse: 1.4 });
  assert.equal(Object.hasOwn(cfg.states, 'notAState'), false);
});

test('rejects a sound path that could escape the project', () => {
  const file = tempConfig(
    JSON.stringify({
      states: {
        done: { sound: '../../../../etc/passwd' },
        error: { sound: '/etc/shadow' },
        thinking: { sound: 'sounds/ok.mp3' },
      },
    }),
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.states.done?.sound, undefined);
  assert.equal(cfg.states.error?.sound, undefined);
  assert.equal(cfg.states.thinking.sound, 'sounds/ok.mp3');
});

test('rejects an out-of-range scalePulse', () => {
  const file = tempConfig(JSON.stringify({ states: { done: { scalePulse: 99 } } }));
  assert.equal(loadConfig(file).states.done?.scalePulse, undefined);
});

test('isSafeRelativePath rejects traversal and absolute paths', () => {
  assert.equal(isSafeRelativePath('sounds/tada.mp3'), true);
  assert.equal(isSafeRelativePath('a/b/c.wav'), true);
  assert.equal(isSafeRelativePath('../x'), false);
  assert.equal(isSafeRelativePath('a/../../b'), false);
  assert.equal(isSafeRelativePath('/abs'), false);
  assert.equal(isSafeRelativePath('C:\\abs'), false);
  assert.equal(isSafeRelativePath('a\\b'), false);
  assert.equal(isSafeRelativePath(''), false);
});

test('accepts an explicit position and rejects a malformed one', () => {
  assert.deepEqual(loadConfig(tempConfig('{"position":{"x":10,"y":20}}')).position, { x: 10, y: 20 });
  assert.equal(loadConfig(tempConfig('{"position":{"x":10}}')).position, null);
  assert.equal(loadConfig(tempConfig('{"position":[1,2]}')).position, null);
  assert.equal(loadConfig(tempConfig('{"position":"middle"}')).position, null);
});

test('clickThrough defaults on and rejects a non-boolean', () => {
  assert.equal(loadConfig(tempConfig('{}')).clickThrough, true);
  assert.equal(loadConfig(tempConfig('{"clickThrough":false}')).clickThrough, false);
  assert.equal(loadConfig(tempConfig('{"clickThrough":"yes"}')).clickThrough, true);
});
