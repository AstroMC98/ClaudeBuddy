'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { sanitizeRulesResult } = require('./behavior.js');

const DEFAULT_TIMEOUT_MS = 50;
const WORKER_FILE = path.join(__dirname, 'rules-worker.js');

/**
 * Run the user's rules.js off the main thread, hang-proof.
 *
 * Calls are serialized: a single worker processes one event at a time, so a
 * reply can never be matched to the wrong call and a hang delays only the next
 * event by at most the timeout. On a hang the worker is terminated and the next
 * call respawns it.
 */
function createRulesRunner({ rulesPath, timeoutMs = DEFAULT_TIMEOUT_MS, onError = () => {} }) {
  const active = fs.existsSync(rulesPath);

  let worker = null;
  let nextId = 1;
  let tail = Promise.resolve(); // serialization chain
  let closed = false;

  function spawn() {
    const w = new Worker(WORKER_FILE, { workerData: { rulesPath } });
    worker = w;
    // A worker that dies on its own (crash, process.exit in rules.js) must not
    // throw at us; the in-flight call's timeout will fire and respawn. Null the
    // handle only if THIS instance is still the current one — a later respawn
    // may already have replaced it.
    w.on('error', () => {});
    w.on('exit', () => {
      if (worker === w) worker = null;
    });
  }

  /** One request/response round trip against the worker, with a timeout. */
  function callWorker(event, defaultBehavior) {
    return new Promise((resolve) => {
      if (worker === null) spawn();
      const id = nextId++;
      const w = worker;

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.off('message', onMessage);
        resolve(value);
      };

      const onMessage = (msg) => {
        if (msg.id !== id) return;
        if (msg.ok) {
          // This runs in an async EventEmitter callback, OUTSIDE the promise
          // executor's implicit catch, so a throw here would be an uncaught
          // exception on the MAIN process — the exact thing this module exists
          // to prevent. sanitizeRulesResult does not throw on structured-cloned
          // input today, but guard it anyway so the guarantee is unconditional.
          let sanitized;
          try {
            sanitized = sanitizeRulesResult(msg.result, defaultBehavior);
          } catch {
            sanitized = { ...defaultBehavior };
          }
          finish(sanitized);
        } else {
          onError(msg.reason); // load error or user throw — reported, not fatal
          finish({ ...defaultBehavior });
        }
      };

      const timer = setTimeout(() => {
        // Hang (or a lost worker): kill it so the next call starts fresh.
        onError(`rules.js timed out after ${timeoutMs}ms and was terminated`);
        w.terminate();
        if (worker === w) worker = null;
        finish({ ...defaultBehavior });
      }, timeoutMs);

      w.on('message', onMessage);
      w.postMessage({ id, event, defaultBehavior });
    });
  }

  return {
    active,

    run(event, defaultBehavior) {
      if (!active || closed) return Promise.resolve(defaultBehavior);

      // Chain onto the tail so calls run one at a time. Errors in the chain are
      // swallowed to the default so `run` never rejects.
      const result = tail.then(() =>
        callWorker(event, defaultBehavior).catch(() => ({ ...defaultBehavior })),
      );
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    async close() {
      closed = true;
      if (worker) {
        await worker.terminate();
        worker = null;
      }
    },
  };
}

module.exports = { createRulesRunner, DEFAULT_TIMEOUT_MS };
