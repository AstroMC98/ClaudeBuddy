'use strict';

const http = require('node:http');
const { EVENT_TYPES } = require('./state-machine.js');

/** Hook payloads are tiny; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 8 * 1024;

/** Free-text fields are clamped so a runaway message cannot bloat memory. */
const MAX_TEXT_LENGTH = 500;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4747;

function clampText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : undefined;
}

/**
 * Convert an untrusted parsed body into a normalized event, or null if invalid.
 * Builds a fresh object rather than mutating the input, so unknown and
 * prototype-polluting fields are dropped by construction.
 */
function normalizeEvent(raw, at) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.type !== 'string' || !EVENT_TYPES.includes(raw.type)) return null;

  const event = { type: raw.type, at };

  const message = clampText(raw.message);
  if (message !== undefined) event.message = message;

  const cwd = clampText(raw.cwd);
  if (cwd !== undefined) event.cwd = cwd;

  return event;
}

/**
 * @param {{
 *   host?: string,
 *   port?: number,
 *   token?: string|null,
 *   onEvent: (event: object) => void,
 *   now?: () => number,
 * }} options
 */
function createEventServer(options) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const token = options.token ?? null;
  const onEvent = options.onEvent;
  const now = options.now ?? Date.now;

  function send(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];

    if (path !== '/event') return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (token !== null && req.headers['x-buddy-token'] !== token) {
      return send(res, 401, { error: 'unauthorized' });
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        send(res, 413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      settled = true;
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;

      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }

      const event = normalizeEvent(parsed, now());
      if (event === null) return send(res, 400, { error: 'invalid event' });

      // A misbehaving listener must never kill the server or fail the hook.
      try {
        onEvent(event);
      } catch {
        /* swallowed deliberately */
      }

      send(res, 202, { ok: true });
    });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    address() {
      return server.address();
    },
  };
}

module.exports = {
  createEventServer,
  normalizeEvent,
  MAX_BODY_BYTES,
  MAX_TEXT_LENGTH,
  DEFAULT_HOST,
  DEFAULT_PORT,
};
