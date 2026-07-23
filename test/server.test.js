'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventServer, MAX_BODY_BYTES } = require('../src/server.js');

/**
 * Start a server on an ephemeral port and hand it to `fn`, always closing after.
 */
async function withServer(options, fn) {
  const received = [];
  const server = createEventServer({
    port: 0,
    onEvent: (event) => received.push(event),
    ...options,
  });
  const addr = await server.listen();
  const url = `http://127.0.0.1:${addr.port}/event`;
  try {
    await fn({ url, base: `http://127.0.0.1:${addr.port}`, received, addr });
  } finally {
    await server.close();
  }
}

const postJson = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('binds to loopback only', async () => {
  await withServer({}, async ({ addr }) => {
    assert.equal(addr.address, '127.0.0.1');
  });
});

test('accepts a valid event and normalizes it', async () => {
  await withServer({ now: () => 1234 }, async ({ url, received }) => {
    const res = await postJson(url, { type: 'done', message: 'all good', cwd: '/tmp/x' });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      type: 'done',
      at: 1234,
      message: 'all good',
      cwd: '/tmp/x',
    });
  });
});

test('accepts an event with only a type', async () => {
  await withServer({ now: () => 7 }, async ({ url, received }) => {
    const res = await postJson(url, { type: 'thinking' });
    assert.equal(res.status, 202);
    assert.deepEqual(received[0], { type: 'thinking', at: 7 });
  });
});

test('strips unknown fields and resists prototype pollution', async () => {
  await withServer({ now: () => 1 }, async ({ url, received }) => {
    // Sent as a raw string: an object literal would set the prototype rather
    // than a "__proto__" key, and JSON.stringify would then drop it entirely.
    await postJson(url, '{"type":"done","evil":"payload","__proto__":{"polluted":true}}');
    assert.deepEqual(Object.keys(received[0]).sort(), ['at', 'type']);
    assert.equal({}.polluted, undefined, 'Object.prototype must be untouched');
  });
});

test('truncates an over-long message', async () => {
  await withServer({ now: () => 1 }, async ({ url, received }) => {
    await postJson(url, { type: 'done', message: 'x'.repeat(5000) });
    assert.equal(received[0].message.length, 500);
  });
});

test('rejects an unknown event type', async () => {
  await withServer({}, async ({ url, received }) => {
    const res = await postJson(url, { type: 'explode' });
    assert.equal(res.status, 400);
    assert.equal(received.length, 0);
  });
});

test('rejects malformed JSON', async () => {
  await withServer({}, async ({ url, received }) => {
    const res = await postJson(url, '{ not json');
    assert.equal(res.status, 400);
    assert.equal(received.length, 0);
  });
});

test('rejects a JSON non-object', async () => {
  await withServer({}, async ({ url, received }) => {
    assert.equal((await postJson(url, '[1,2,3]')).status, 400);
    assert.equal((await postJson(url, '"hello"')).status, 400);
    assert.equal(received.length, 0);
  });
});

test('rejects an oversized body', async () => {
  await withServer({}, async ({ url, received }) => {
    const huge = JSON.stringify({ type: 'done', message: 'x'.repeat(MAX_BODY_BYTES + 1000) });
    const res = await postJson(url, huge);
    assert.equal(res.status, 413);
    assert.equal(received.length, 0);
  });
});

test('returns 404 for unknown paths', async () => {
  await withServer({}, async ({ base }) => {
    const res = await postJson(`${base}/nope`, { type: 'done' });
    assert.equal(res.status, 404);
  });
});

test('returns 405 for a non-POST method', async () => {
  await withServer({}, async ({ url }) => {
    const res = await fetch(url, { method: 'GET' });
    assert.equal(res.status, 405);
  });
});

test('requires the token when one is configured', async () => {
  await withServer({ token: 's3cret' }, async ({ url, received }) => {
    assert.equal((await postJson(url, { type: 'done' })).status, 401);
    assert.equal(
      (await postJson(url, { type: 'done' }, { 'x-buddy-token': 'wrong' })).status,
      401,
    );
    assert.equal(received.length, 0);
  });
});

test('accepts the request when the token matches', async () => {
  await withServer({ token: 's3cret', now: () => 5 }, async ({ url, received }) => {
    const res = await postJson(url, { type: 'done' }, { 'x-buddy-token': 's3cret' });
    assert.equal(res.status, 202);
    assert.equal(received.length, 1);
  });
});

test('a throwing listener does not take down the server', async () => {
  const server = createEventServer({
    port: 0,
    onEvent: () => {
      throw new Error('listener exploded');
    },
  });
  const addr = await server.listen();
  try {
    const url = `http://127.0.0.1:${addr.port}/event`;
    assert.equal((await postJson(url, { type: 'done' })).status, 202);
    assert.equal((await postJson(url, { type: 'done' })).status, 202);
  } finally {
    await server.close();
  }
});

test('ignores a query string on the event path', async () => {
  await withServer({ now: () => 1 }, async ({ base, received }) => {
    const res = await postJson(`${base}/event?from=hook`, { type: 'done' });
    assert.equal(res.status, 202);
    assert.equal(received.length, 1);
  });
});
