'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStateMachine,
  EVENT_TYPES,
  DEFAULT_IDLE_TIMEOUT_MS,
} = require('../src/state-machine.js');

test('starts in idle', () => {
  const m = createStateMachine();
  assert.equal(m.getState(), 'idle');
});

test('every valid event type transitions to the state of the same name', () => {
  for (const type of EVENT_TYPES) {
    const m = createStateMachine();
    const change = m.handleEvent({ type }, 1000);
    assert.equal(m.getState(), type, `expected state ${type}`);
    assert.equal(change.state, type);
    assert.equal(change.previous, 'idle');
  }
});

test('unknown event types are ignored and leave the state untouched', () => {
  const m = createStateMachine();
  m.handleEvent({ type: 'thinking' }, 1000);
  assert.equal(m.handleEvent({ type: 'explode' }, 2000), null);
  assert.equal(m.getState(), 'thinking');
});

test('malformed events are ignored', () => {
  const m = createStateMachine();
  assert.equal(m.handleEvent(null, 1000), null);
  assert.equal(m.handleEvent(undefined, 1000), null);
  assert.equal(m.handleEvent({}, 1000), null);
  assert.equal(m.handleEvent({ type: 42 }, 1000), null);
  assert.equal(m.getState(), 'idle');
});

test('prototype keys are not treated as event types', () => {
  const m = createStateMachine();
  assert.equal(m.handleEvent({ type: 'constructor' }, 1000), null);
  assert.equal(m.handleEvent({ type: 'toString' }, 1000), null);
  assert.equal(m.getState(), 'idle');
});

test('looping states report loop true and no successor', () => {
  for (const type of ['thinking', 'working', 'needsInput']) {
    const m = createStateMachine();
    const change = m.handleEvent({ type }, 1000);
    assert.equal(change.loop, true, `${type} should loop`);
    assert.equal(change.next, null, `${type} should have no successor`);
  }
});

test('one-shot states report loop false and the correct successor', () => {
  const cases = [
    ['done', 'idle'],
    ['subagent', 'thinking'],
    ['error', 'idle'],
  ];
  for (const [type, successor] of cases) {
    const m = createStateMachine();
    const change = m.handleEvent({ type }, 1000);
    assert.equal(change.loop, false, `${type} should not loop`);
    assert.equal(change.next, successor);
  }
});

test('completeOneShot advances done to idle', () => {
  const m = createStateMachine();
  m.handleEvent({ type: 'done' }, 1000);
  const change = m.completeOneShot();
  assert.equal(change.state, 'idle');
  assert.equal(change.previous, 'done');
  assert.equal(m.getState(), 'idle');
});

test('completeOneShot advances subagent back to thinking', () => {
  const m = createStateMachine();
  m.handleEvent({ type: 'subagent' }, 1000);
  assert.equal(m.completeOneShot().state, 'thinking');
});

test('completeOneShot advances error to idle', () => {
  const m = createStateMachine();
  m.handleEvent({ type: 'error' }, 1000);
  assert.equal(m.completeOneShot().state, 'idle');
});

test('completeOneShot is a no-op in a looping state', () => {
  const m = createStateMachine();
  m.handleEvent({ type: 'thinking' }, 1000);
  assert.equal(m.completeOneShot(), null);
  assert.equal(m.getState(), 'thinking');
});

test('tick does nothing before the idle timeout elapses', () => {
  const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
  assert.equal(m.tick(999), null);
  assert.equal(m.getState(), 'idle');
});

test('tick puts an idle buddy to sleep once the timeout elapses', () => {
  const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
  const change = m.tick(1000);
  assert.equal(change.state, 'sleeping');
  assert.equal(change.previous, 'idle');
  assert.equal(change.loop, true);
});

test('falls asleep from a looping state that has no successor', () => {
  for (const type of ['thinking', 'working', 'needsInput']) {
    const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
    m.handleEvent({ type }, 10);
    const change = m.tick(1100);
    assert.equal(change && change.state, 'sleeping', `${type} should eventually sleep`);
    assert.equal(change.previous, type);
  }
});

test('falls asleep from a one-shot whose ack never arrived', () => {
  const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
  m.handleEvent({ type: 'done' }, 10);
  // completeOneShot() is never called -- the renderer's ack was lost.
  assert.equal(m.tick(1100).state, 'sleeping');
});

test('an event still refreshes the sleep timer from a non-idle state', () => {
  const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
  m.handleEvent({ type: 'thinking' }, 500);
  assert.equal(m.tick(1200), null, 'only 700ms since the event');
  assert.equal(m.tick(1600).state, 'sleeping');
});

test('tick does not re-fire once already sleeping', () => {
  const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
  assert.equal(m.tick(1000).state, 'sleeping');
  assert.equal(m.tick(2000), null);
  assert.equal(m.tick(3000), null);
});

test('an event wakes a sleeping buddy', () => {
  const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
  m.tick(1000);
  const change = m.handleEvent({ type: 'done' }, 1500);
  assert.equal(change.state, 'done');
  assert.equal(change.previous, 'sleeping');
});

test('handling an event resets the idle timer', () => {
  const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
  m.handleEvent({ type: 'done' }, 900);
  m.completeOneShot();
  assert.equal(m.tick(1500), null, 'timer should have restarted at t=900');
  assert.equal(m.tick(1900).state, 'sleeping');
});

test('the default idle timeout is ten minutes', () => {
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 600000);
});

test('snapshot reports the current state with a null previous', () => {
  const m = createStateMachine();
  assert.deepEqual(m.snapshot(), { state: 'idle', previous: null, loop: true, next: null });
  m.handleEvent({ type: 'done' }, 1000);
  assert.deepEqual(m.snapshot(), { state: 'done', previous: null, loop: false, next: 'idle' });
});

test('snapshot matches the shape handleEvent produces', () => {
  const m = createStateMachine();
  const fromEvent = m.handleEvent({ type: 'needsInput' }, 1000);
  const snap = m.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), Object.keys(fromEvent).sort());
  assert.equal(snap.state, fromEvent.state);
  assert.equal(snap.loop, fromEvent.loop);
  assert.equal(snap.next, fromEvent.next);
});
