'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { sanitizeRulesResult } = require('./behavior.js');

/** Bounds rules.js EXECUTION on an already-ready worker. */
const DEFAULT_TIMEOUT_MS = 50;
/**
 * Bounds worker COLD START (thread spawn + `require(rules.js)`). Kept separate
 * from and much larger than the execution budget: spawning a worker and loading
 * a file legitimately takes tens of ms warm, and can spike far higher under load
 * (an antivirus scanning the worker on first access, many workers spawning at
 * once). Counting that against the 50ms execution budget would spuriously time
 * out the FIRST real event and fall back to default even for a fast rules.js.
 */
const DEFAULT_SPAWN_TIMEOUT_MS = 5000;
const WORKER_FILE = path.join(__dirname, 'rules-worker.js');

/**
 * Run the user's rules.js off the main thread, hang-proof.
 *
 * Two independent budgets: a generous one for the worker to start and load
 * rules.js (readiness), and a tight one for each rules.js execution. A call
 * waits for readiness first, THEN starts the execution clock — so worker
 * cold-start is never mistaken for a slow rules function.
 *
 * Calls are serialized: a single worker processes one event at a time, so a
 * reply can never be matched to the wrong call and a hang delays only the next
 * event. On a hang the worker is terminated and the next call respawns it.
 */
function createRulesRunner({
  rulesPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnTimeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
  onError = () => {},
}) {
  const active = fs.existsSync(rulesPath);

  let worker = null;
  let ready = null; // Promise<boolean> — true once the worker signals it loaded rules.js
  let nextId = 1;
  let tail = Promise.resolve(); // serialization chain
  let closed = false;

  function spawn() {
    const w = new Worker(WORKER_FILE, { workerData: { rulesPath } });
    worker = w;

    ready = new Promise((resolve) => {
      let settled = false;
      const finishReady = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.off('message', onReady);
        resolve(ok);
      };
      const onReady = (msg) => {
        if (msg && msg.ready) finishReady(true);
      };
      const timer = setTimeout(() => {
        onError(`rules.js worker did not become ready within ${spawnTimeoutMs}ms`);
        finishReady(false);
      }, spawnTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      w.on('message', onReady);
    });

    // A worker that dies on its own (crash, process.exit in rules.js) must not
    // throw at us. Null the handle only if THIS instance is still current — a
    // later respawn may already have replaced it.
    w.on('error', () => {});
    w.on('exit', () => {
      if (worker === w) {
        worker = null;
        ready = null;
      }
    });
  }

  /** One request/response round trip: wait for readiness, then time execution. */
  function callWorker(event, defaultBehavior) {
    return new Promise((resolve) => {
      if (worker === null) spawn();
      const w = worker;
      const readyForW = ready;

      let settled = false;
      let timer = null;
      let onMessage = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (onMessage) w.off('message', onMessage);
        resolve(value);
      };

      readyForW.then((ok) => {
        if (settled) return;
        // Worker never started, or was replaced while we waited: fall back.
        if (!ok || worker !== w) {
          finish({ ...defaultBehavior });
          return;
        }

        const id = nextId++;
        onMessage = (msg) => {
          if (msg.id !== id) return;
          if (msg.ok) {
            // Runs in an async EventEmitter callback, OUTSIDE the promise
            // executor's implicit catch, so a throw here would be an uncaught
            // exception on the MAIN process. sanitizeRulesResult does not throw
            // on structured-cloned input today; guard it so that is unconditional.
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

        timer = setTimeout(() => {
          // Hang: kill the worker so the next call starts fresh.
          onError(`rules.js timed out after ${timeoutMs}ms and was terminated`);
          w.terminate();
          if (worker === w) {
            worker = null;
            ready = null;
          }
          finish({ ...defaultBehavior });
        }, timeoutMs);

        w.on('message', onMessage);
        w.postMessage({ id, event, defaultBehavior });
      });
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
        ready = null;
      }
    },
  };
}

module.exports = { createRulesRunner, DEFAULT_TIMEOUT_MS, DEFAULT_SPAWN_TIMEOUT_MS };
