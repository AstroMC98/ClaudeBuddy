'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createEventServer } = require('../src/server.js');

const NOTIFY = path.join(__dirname, '..', 'hooks', 'notify.js');

/**
 * Run the shim and resolve with its exit code and elapsed milliseconds.
 * `stdin` is written then the stream is closed, mimicking a Claude Code hook.
 */
function runNotify(args, stdin = '', env = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [NOTIFY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end(stdin);
    child.on('close', (code) => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ code, elapsedMs });
    });
  });
}

test('exits 0 quickly when nothing is listening', async () => {
  const { code, elapsedMs } = await runNotify(['done'], '{}', {
    CLAUDE_BUDDY_PORT: '1',
  });
  assert.equal(code, 0, 'a dead pet must never fail a Claude Code session');
  assert.ok(elapsedMs < 3000, `took ${elapsedMs}ms, expected under 3000ms`);
});

test('exits 0 when given no event type', async () => {
  const { code } = await runNotify([], '');
  assert.equal(code, 0);
});

test('exits 0 when given an unknown event type', async () => {
  const { code } = await runNotify(['nonsense'], '{}', { CLAUDE_BUDDY_PORT: '1' });
  assert.equal(code, 0);
});

test('delivers the event to a listening server', async () => {
  const received = [];
  const server = createEventServer({ port: 0, onEvent: (e) => received.push(e) });
  const addr = await server.listen();
  try {
    const { code } = await runNotify(['done'], '{}', {
      CLAUDE_BUDDY_PORT: String(addr.port),
    });
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'done');
  } finally {
    await server.close();
  }
});

test('forwards the message from the stdin hook payload', async () => {
  const received = [];
  const server = createEventServer({ port: 0, onEvent: (e) => received.push(e) });
  const addr = await server.listen();
  try {
    const payload = JSON.stringify({ message: 'tests passed', cwd: '/work/proj' });
    await runNotify(['done'], payload, { CLAUDE_BUDDY_PORT: String(addr.port) });
    assert.equal(received[0].message, 'tests passed');
    assert.equal(received[0].cwd, '/work/proj');
  } finally {
    await server.close();
  }
});

test('survives a malformed stdin payload', async () => {
  const received = [];
  const server = createEventServer({ port: 0, onEvent: (e) => received.push(e) });
  const addr = await server.listen();
  try {
    const { code } = await runNotify(['done'], '{ not json at all', {
      CLAUDE_BUDDY_PORT: String(addr.port),
    });
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'done');
  } finally {
    await server.close();
  }
});

test('sends the token header when one is configured', async () => {
  const received = [];
  const server = createEventServer({
    port: 0,
    token: 'abc123',
    onEvent: (e) => received.push(e),
  });
  const addr = await server.listen();
  try {
    await runNotify(['done'], '{}', {
      CLAUDE_BUDDY_PORT: String(addr.port),
      CLAUDE_BUDDY_TOKEN: 'abc123',
    });
    assert.equal(received.length, 1);
  } finally {
    await server.close();
  }
});
