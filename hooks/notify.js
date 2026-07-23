#!/usr/bin/env node
'use strict';

/**
 * Claude Code hook shim.
 *
 *   node hooks/notify.js <eventType>
 *
 * Reads the hook payload from stdin, POSTs a normalized event to the running
 * buddy, and ALWAYS exits 0. If the buddy is not running, this is a silent
 * no-op: a desktop pet must never stall or fail a Claude Code session.
 *
 * Zero dependencies by design — this runs on every single hook fire.
 */

const http = require('node:http');
const { loadConfig } = require('../src/config.js');

/** Give up on the HTTP request after this long. */
const REQUEST_TIMEOUT_MS = 1000;

/** Give up waiting for stdin after this long (a TTY never sends EOF). */
const STDIN_TIMEOUT_MS = 150;

/** Absolute backstop: exit even if something above wedges unexpectedly. */
const WATCHDOG_MS = 2000;

const VALID_TYPES = ['thinking', 'working', 'done', 'needsInput', 'subagent', 'error'];

function readStdin(maxMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');

    let data = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(data);
    };

    const timer = setTimeout(finish, maxMs);
    timer.unref();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (data.length < 64 * 1024) data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function post({ port, token }, body) {
  return new Promise((resolve) => {
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };
    if (token) headers['x-buddy-token'] = token;

    const req = http.request(
      { host: '127.0.0.1', port, path: '/event', method: 'POST', headers },
      (res) => {
        res.resume();
        res.on('end', resolve);
        res.on('error', resolve);
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve();
    });
    req.on('error', resolve);
    req.end(body);
  });
}

async function main() {
  const type = process.argv[2];
  if (!VALID_TYPES.includes(type)) return;

  const config = loadConfig();
  const port = Number(process.env.CLAUDE_BUDDY_PORT) || config.port;
  const token = process.env.CLAUDE_BUDDY_TOKEN || config.token;

  let payload = {};
  try {
    const parsed = JSON.parse((await readStdin(STDIN_TIMEOUT_MS)) || '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed;
    }
  } catch {
    /* a malformed payload just means no extra context */
  }

  const body = JSON.stringify({
    type,
    message: typeof payload.message === 'string' ? payload.message : undefined,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
  });

  await post({ port, token }, body);
}

const watchdog = setTimeout(() => process.exit(0), WATCHDOG_MS);
watchdog.unref();

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
