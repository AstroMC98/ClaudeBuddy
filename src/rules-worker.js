'use strict';

/**
 * Worker-thread host for the user's rules.js.
 *
 * Loads the user file once, then runs it per message. It never trusts the user
 * function beyond catching its throws — the MAIN side sanitizes the value. A
 * synchronous infinite loop here cannot be caught; the main side terminates the
 * whole worker on a timeout, which is the entire reason this runs off-thread.
 */

const { parentPort, workerData } = require('node:worker_threads');

let rulesFn = null;
let loadError = null;

try {
  // eslint-disable-next-line import/no-dynamic-require
  const mod = require(workerData.rulesPath);
  if (typeof mod === 'function') rulesFn = mod;
  else loadError = 'rules.js did not export a function';
} catch (err) {
  loadError = `rules.js failed to load: ${err && err.message}`;
}

parentPort.on('message', (msg) => {
  const { id, event, defaultBehavior } = msg;

  if (rulesFn === null) {
    parentPort.postMessage({ id, ok: false, reason: loadError });
    return;
  }

  try {
    const result = rulesFn(event, defaultBehavior);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, reason: String(err && err.message ? err.message : err) });
  }
});
