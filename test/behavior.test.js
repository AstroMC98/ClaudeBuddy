'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { defaultBehaviorFor, sanitizeRulesResult } = require('../src/behavior.js');

const config = {
  states: {
    done: { sound: 'sounds/tada.mp3', scalePulse: 1.4 },
    error: { scalePulse: 1.2 },
    thinking: {},
  },
};

test('default behavior reads the sound and pulse for the event state', () => {
  assert.deepEqual(defaultBehaviorFor(config, { type: 'done' }), {
    sound: 'sounds/tada.mp3',
    scalePulse: 1.4,
  });
});

test('default behavior falls back to no sound and no pulse', () => {
  assert.deepEqual(defaultBehaviorFor(config, { type: 'thinking' }), {
    sound: null,
    scalePulse: 1,
  });
  assert.deepEqual(defaultBehaviorFor(config, { type: 'needsInput' }), {
    sound: null,
    scalePulse: 1,
  });
});

test('default behavior tolerates a config with no states', () => {
  assert.deepEqual(defaultBehaviorFor({}, { type: 'done' }), { sound: null, scalePulse: 1 });
});

test('a null result suppresses the event', () => {
  const def = { sound: null, scalePulse: 1 };
  assert.equal(sanitizeRulesResult(null, def), null);
});

test('an undefined or non-object result falls back to the default', () => {
  const def = { sound: 'sounds/a.mp3', scalePulse: 1.4 };
  assert.deepEqual(sanitizeRulesResult(undefined, def), def);
  assert.deepEqual(sanitizeRulesResult(42, def), def);
  assert.deepEqual(sanitizeRulesResult('nope', def), def);
  assert.deepEqual(sanitizeRulesResult([], def), def);
});

test('a valid override is accepted', () => {
  const def = { sound: 'sounds/a.mp3', scalePulse: 1.4 };
  assert.deepEqual(sanitizeRulesResult({ sound: 'sounds/b.mp3', scalePulse: 2 }, def), {
    sound: 'sounds/b.mp3',
    scalePulse: 2,
  });
});

test('sound: null in a result means silence, not "use default"', () => {
  const def = { sound: 'sounds/a.mp3', scalePulse: 1.4 };
  assert.deepEqual(sanitizeRulesResult({ sound: null, scalePulse: 1.4 }, def), {
    sound: null,
    scalePulse: 1.4,
  });
});

test('a wrong-typed field falls back to that field of the default, not the whole default', () => {
  const def = { sound: 'sounds/a.mp3', scalePulse: 1.4 };
  assert.deepEqual(sanitizeRulesResult({ sound: 'sounds/b.mp3', scalePulse: 'huge' }, def), {
    sound: 'sounds/b.mp3',
    scalePulse: 1.4,
  });
  assert.deepEqual(sanitizeRulesResult({ sound: 42, scalePulse: 2 }, def), {
    sound: 'sounds/a.mp3',
    scalePulse: 2,
  });
});

test('an out-of-range pulse falls back to the default pulse', () => {
  const def = { sound: null, scalePulse: 1 };
  assert.equal(sanitizeRulesResult({ scalePulse: 99 }, def).scalePulse, 1);
  assert.equal(sanitizeRulesResult({ scalePulse: 0 }, def).scalePulse, 1);
  assert.equal(sanitizeRulesResult({ scalePulse: -1 }, def).scalePulse, 1);
  assert.equal(sanitizeRulesResult({ scalePulse: 4 }, def).scalePulse, 4);
  assert.equal(sanitizeRulesResult({ scalePulse: 0.1 }, def).scalePulse, 0.1);
});

test('a traversal sound path in a result is rejected and falls back', () => {
  const def = { sound: 'sounds/a.mp3', scalePulse: 1 };
  for (const evil of ['../secret', '/etc/passwd', 'a\\b', 'a/../../b']) {
    assert.equal(sanitizeRulesResult({ sound: evil, scalePulse: 1 }, def).sound, 'sounds/a.mp3');
  }
});

test('missing fields in an object result inherit the default field', () => {
  const def = { sound: 'sounds/a.mp3', scalePulse: 1.4 };
  assert.deepEqual(sanitizeRulesResult({}, def), def);
  assert.deepEqual(sanitizeRulesResult({ scalePulse: 2 }, def), { sound: 'sounds/a.mp3', scalePulse: 2 });
});
