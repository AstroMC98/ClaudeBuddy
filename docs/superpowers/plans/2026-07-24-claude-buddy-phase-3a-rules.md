# Claude Buddy — Phase 3A (rules.js) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user's optional `rules.js` override how each Claude Code event is handled — change its sound, its attention pulse, or suppress it entirely — running that user code in a worker thread so a crash *or a hang* can never freeze the pet.

**Architecture:** When `rules.js` exists, the main process computes a *default behavior* for each incoming event from config, hands `(event, defaultBehavior)` to a persistent worker thread running the user's code, and applies the returned override. A per-call timeout terminates and respawns the worker on a hang; any throw or timeout falls back to the default. The resolved behavior (a per-event sound and pulse) rides on the existing `state-change` IPC payload, so the renderer needs no new channel.

**Tech Stack:** Electron 43, Node 24, `node:worker_threads`, `node:test`. No new dependencies.

**Scope:** Spec §6.2 (`rules.js`). This is Phase 3, sub-plan A of three (A: rules.js, B: import-sprite, C: interactions).

**Spec:** [`docs/superpowers/specs/2026-07-23-claude-buddy-design.md`](../specs/2026-07-23-claude-buddy-design.md) §6.2

## Global Constraints

Every task's requirements implicitly include this section.

- **Electron is the ONLY entry in `package.json` dependencies or devDependencies.** No packages. `worker_threads`, `fs`, `path` are all Node stdlib.
- **Tests run via `npm test` → `node --test test/*.js`.** Never Jest, Mocha, Vitest, or Chai.
- `'use strict';` and CommonJS (`require`/`module.exports`) throughout.
- **`rules.js` is the user's own code, but its return value is untrusted.** Every field it produces must be re-validated before use: `scalePulse` must be a finite number in `[0.1, 4]`; `sound` must be `null` or pass `isSafeRelativePath`. An out-of-contract value is dropped in favour of the default, not applied.
- **A broken `rules.js` must never take the pet down.** A throw, a timeout/hang, a worker that dies, or a `rules.js` that fails to load all degrade to *default behaviour* (the config-derived one) — or, when `rules.js` is absent entirely, to today's exact behaviour.
- **The worker must be genuinely hang-proof.** A synchronous infinite loop in `rules.js` must be terminated within the time budget and the pet must stay responsive. (Verified: `Worker.terminate()` interrupts a `while(true){}` and returns in ~2ms without freezing the main thread.)
- **Do NOT weaken Electron hardening or widen the IPC surface.** No new preload function; the behavior rides on the existing `state-change` payload.
- **Backward compatible:** with no `rules.js` present, the `state-change` payload carries no `behavior` field and the renderer behaves exactly as it does today.
- **The rules runner never blocks the HTTP response.** `server.js` does not await `onEvent`; rules processing is async and pushes the state change when it resolves.
- `state.json`, `config.json`, `rules.js` are gitignored (user-local). Ship `rules.example.js`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/behavior.js` | **New, pure.** Compute the default behavior for an event; sanitize a rules result. Zero imports beyond `config.js` |
| `src/sound-cache.js` | **New.** Resolve a validated relative sound path to a `data:` URI, cached. The only new module that touches `fs` |
| `src/rules-worker.js` | **New.** Worker-thread entry: load the user's `rules.js`, run it per message |
| `src/rules.js` | **New.** Main-side runner: persistent worker, per-call timeout, terminate + respawn, serialized calls, never throws |
| `src/main.js` | **Modify.** Wire the runner into `onEvent`; attach resolved behavior to `state-change` |
| `src/renderer/renderer.js` | **Modify.** Consume `change.behavior` when present; fall back to today's path when absent |
| `src/renderer/sound.js` | **Modify.** Add `playUri(dataUri)` for an ad-hoc sound |
| `rules.example.js` | **New.** Committed sample the user copies to `rules.js` |
| `test/*.test.js` | Unit + integration tests |

**Dependency direction:** `behavior.js` imports only `config.js` (for the validators) and is pure. `sound-cache.js` imports `assets.js` (`toDataUri`) and `config.js` (`isSafeRelativePath`). `rules.js` (main side) imports `worker_threads` and `behavior.js`. `rules-worker.js` runs in its own thread and imports only the user's file. The renderer imports nothing new.

### The behavior object

The single value that flows event → rules → renderer:

```ts
Behavior = {
  scalePulse: number,        // 1 = no pulse; the attention "grow"
  sound: string | null,      // a relative sound path, or null for silence
}
```

`rules(event, defaultBehavior)` returns a `Behavior`, or `null` to **suppress** the event entirely. Main resolves `behavior.sound` (a path) into a `data:` URI before it crosses IPC, so the sandboxed renderer only ever receives bytes, never a path.

---

### Task 1: Pure behavior computation and result sanitization

**Files:**
- Create: `src/behavior.js`
- Test: `test/behavior.test.js`

**Interfaces:**
- Consumes: nothing (validation thresholds are defined locally to keep this pure and self-contained)
- Produces:
  - `defaultBehaviorFor(config, event) => { scalePulse, sound }` — the behavior implied by config for an event's state
  - `sanitizeRulesResult(raw, defaultBehavior) => { scalePulse, sound } | null` — validate untrusted user output; `null` means suppress
  - `isSafeSoundPath(value) => boolean` — re-exported guard used by both this and the sound cache
  - Exported constants: `MIN_PULSE`, `MAX_PULSE`

- [ ] **Step 1: Write the failing test**

Create `test/behavior.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/behavior.test.js`
Expected: FAIL — `Cannot find module '../src/behavior.js'`

- [ ] **Step 3: Write the implementation**

Create `src/behavior.js`:

```js
'use strict';

const { isSafeRelativePath } = require('./config.js');

/** The attention pulse is a size multiplier; keep it sane whatever rules asks. */
const MIN_PULSE = 0.1;
const MAX_PULSE = 4;

/** A sound path is safe if it stays inside the project (or is explicit silence). */
function isSafeSoundPath(value) {
  return value === null || isSafeRelativePath(value);
}

/**
 * The behaviour config implies for an event, before any rules override.
 * A state with no per-state config gets no sound and no pulse.
 */
function defaultBehaviorFor(config, event) {
  const states = config && typeof config.states === 'object' ? config.states : {};
  const entry = states && Object.hasOwn(states, event.type) ? states[event.type] : null;

  const sound =
    entry && typeof entry.sound === 'string' && isSafeRelativePath(entry.sound) ? entry.sound : null;
  const scalePulse =
    entry && Number.isFinite(entry.scalePulse) && entry.scalePulse >= MIN_PULSE && entry.scalePulse <= MAX_PULSE
      ? entry.scalePulse
      : 1;

  return { sound, scalePulse };
}

function isValidPulse(v) {
  return Number.isFinite(v) && v >= MIN_PULSE && v <= MAX_PULSE;
}

/**
 * Validate the untrusted return value of the user's rules function.
 *
 * - `null` => suppress the event entirely.
 * - a non-object => fall back to the whole default.
 * - an object => take each field only if it is in contract, else that field's
 *   default. A wrong `scalePulse` does not discard a good `sound`.
 *
 * @returns {{scalePulse:number, sound:string|null}|null}
 */
function sanitizeRulesResult(raw, defaultBehavior) {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ...defaultBehavior };

  const scalePulse = isValidPulse(raw.scalePulse) ? raw.scalePulse : defaultBehavior.scalePulse;

  let sound = defaultBehavior.sound;
  if (Object.hasOwn(raw, 'sound')) {
    if (raw.sound === null) sound = null;
    else if (typeof raw.sound === 'string' && isSafeRelativePath(raw.sound)) sound = raw.sound;
    // any other type: keep the default
  }

  return { scalePulse, sound };
}

module.exports = {
  defaultBehaviorFor,
  sanitizeRulesResult,
  isSafeSoundPath,
  MIN_PULSE,
  MAX_PULSE,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/behavior.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add src/behavior.js test/behavior.test.js
git commit -m "feat: add pure behavior computation and untrusted-result sanitization"
```

---

### Task 2: Sound cache — resolve a validated path to a data URI

**Files:**
- Create: `src/sound-cache.js`
- Test: `test/sound-cache.test.js`

**Interfaces:**
- Consumes: `toDataUri` from `src/assets.js`; `isSafeRelativePath` from `src/config.js`
- Produces:
  - `createSoundCache(projectRoot) => { resolve(relPath) => string|null }`
  - `resolve(null)` returns `null`; an unsafe path returns `null`; a missing/unreadable file returns `null`; a valid file returns a `data:` URI, cached by path so repeated events do not re-read the disk

**Why a cache:** with `rules.js` active, sound is resolved per event in the main process. A celebration sound fired on every `done` should be read from disk once, not every time.

- [ ] **Step 1: Write the failing test**

Create `test/sound-cache.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSoundCache } = require('../src/sound-cache.js');

function projectWithSound(rel, bytes = 'fake-audio') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-snd-'));
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(bytes));
  return root;
}

test('resolves a real sound to a data URI', () => {
  const root = projectWithSound('sounds/tada.mp3');
  const cache = createSoundCache(root);
  assert.match(cache.resolve('sounds/tada.mp3'), /^data:audio\/mpeg;base64,/);
});

test('returns null for a null path', () => {
  const cache = createSoundCache(projectWithSound('sounds/a.mp3'));
  assert.equal(cache.resolve(null), null);
});

test('returns null for an unsafe path without reading it', () => {
  const cache = createSoundCache(projectWithSound('sounds/a.mp3'));
  for (const evil of ['../x', '/etc/passwd', 'a\\b', 'a/../../b']) {
    assert.equal(cache.resolve(evil), null);
  }
});

test('returns null for a missing file', () => {
  const cache = createSoundCache(projectWithSound('sounds/a.mp3'));
  assert.equal(cache.resolve('sounds/absent.mp3'), null);
});

test('returns null for an unsupported extension', () => {
  const root = projectWithSound('sounds/x.exe');
  const cache = createSoundCache(root);
  assert.equal(cache.resolve('sounds/x.exe'), null);
});

test('caches by path — the file is read once', () => {
  const root = projectWithSound('sounds/a.mp3', 'v1');
  const cache = createSoundCache(root);
  const first = cache.resolve('sounds/a.mp3');
  // Overwrite the file; a cached resolver must still return the first bytes.
  fs.writeFileSync(path.join(root, 'sounds/a.mp3'), Buffer.from('v2-different'));
  assert.equal(cache.resolve('sounds/a.mp3'), first);
});

test('caches null results too, so a missing file is not retried every event', () => {
  const root = projectWithSound('sounds/a.mp3');
  const cache = createSoundCache(root);
  assert.equal(cache.resolve('sounds/missing.mp3'), null);
  // Create it after the miss; the cache should still report null.
  fs.writeFileSync(path.join(root, 'sounds/missing.mp3'), Buffer.from('now here'));
  assert.equal(cache.resolve('sounds/missing.mp3'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/sound-cache.test.js`
Expected: FAIL — `Cannot find module '../src/sound-cache.js'`

- [ ] **Step 3: Write the implementation**

Create `src/sound-cache.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { toDataUri } = require('./assets.js');
const { isSafeRelativePath } = require('./config.js');

/**
 * Resolve a relative sound path to a `data:` URI, once.
 *
 * With rules.js active, main resolves a sound per event, and the same sound
 * may fire on every `done`. Caching by path — including negative results —
 * keeps that to one disk read and one failure log, not one per event.
 */
function createSoundCache(projectRoot) {
  const cache = new Map();

  return {
    resolve(relPath) {
      if (relPath === null) return null;
      if (cache.has(relPath)) return cache.get(relPath);

      let uri = null;
      if (isSafeRelativePath(relPath)) {
        try {
          uri = toDataUri(fs.readFileSync(path.join(projectRoot, relPath)), relPath);
        } catch {
          uri = null;
        }
      }

      cache.set(relPath, uri);
      return uri;
    },
  };
}

module.exports = { createSoundCache };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/sound-cache.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add src/sound-cache.js test/sound-cache.test.js
git commit -m "feat: add cached path-to-data-URI sound resolver"
```

---

### Task 3: The rules runner and its worker

**Files:**
- Create: `src/rules-worker.js`
- Create: `src/rules.js`
- Create: `rules.example.js`
- Test: `test/rules.test.js`

**Interfaces:**
- Consumes: `sanitizeRulesResult` from `src/behavior.js`
- Produces:
  - `createRulesRunner({ rulesPath, timeoutMs? }) => { active: boolean, run(event, defaultBehavior) => Promise<result>, close() => Promise<void> }`
    - `active` is `false` when `rulesPath` does not exist — `run` then resolves to the default behavior unchanged and no worker is ever spawned
    - `run` returns the sanitized override, or `null` to suppress; it **never rejects**
    - a throw, timeout/hang, or dead worker resolves to the **default behavior**
  - Exported constant: `DEFAULT_TIMEOUT_MS`

**Design:**
- One **persistent** worker is spawned lazily on the first `run`. It `require`s the user's `rules.js` once.
- Calls are **serialized** through a promise chain, so responses can never be mismatched and a hang blocks only the (rare) next event by at most the timeout.
- Each call posts `{event, defaultBehavior}` and races the worker's reply against a timeout. On timeout: `terminate()` the worker, null the handle (the next call respawns), resolve to the default.
- The worker validates its own `require` of `rules.js`; if that throws or the export is not a function, it reports load failure and the runner degrades to returning defaults (still `active`, so a fixed `rules.js` works on the next spawn — but for simplicity this plan respawns per failure, which is fine because failures are rare).

- [ ] **Step 1: Write the failing test**

Create `test/rules.test.js`. These are integration tests against a **real worker** and **real fixture files** written to a temp dir.

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRulesRunner } = require('../src/rules.js');

const DEF = { sound: 'sounds/default.mp3', scalePulse: 1 };

/** Write a rules.js with the given body and return its path. */
function writeRules(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-rules-'));
  const file = path.join(dir, 'rules.js');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('is inactive when rules.js does not exist', async () => {
  const runner = createRulesRunner({ rulesPath: path.join(os.tmpdir(), 'no-such-rules-9931.js') });
  assert.equal(runner.active, false);
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('applies a valid override from rules.js', async () => {
  const file = writeRules(`
    module.exports = (event, def) => {
      if (event.type === 'done') return { ...def, scalePulse: 2 };
      return def;
    };
  `);
  const runner = createRulesRunner({ rulesPath: file });
  assert.equal(runner.active, true);
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), { sound: 'sounds/default.mp3', scalePulse: 2 });
  await runner.close();
});

test('suppresses an event when rules returns null', async () => {
  const file = writeRules(`module.exports = () => null;`);
  const runner = createRulesRunner({ rulesPath: file });
  assert.equal(await runner.run({ type: 'done' }, DEF), null);
  await runner.close();
});

test('sanitizes an out-of-contract override', async () => {
  const file = writeRules(`module.exports = () => ({ scalePulse: 999, sound: '../../etc/passwd' });`);
  const runner = createRulesRunner({ rulesPath: file });
  // Both fields are out of contract, so both fall back to the default.
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('falls back to the default when rules throws', async () => {
  const file = writeRules(`module.exports = () => { throw new Error('boom'); };`);
  const runner = createRulesRunner({ rulesPath: file });
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('falls back to the default when rules.js fails to load', async () => {
  const file = writeRules(`this is not valid javascript {{{`);
  const runner = createRulesRunner({ rulesPath: file });
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('falls back to the default when the export is not a function', async () => {
  const file = writeRules(`module.exports = { not: 'a function' };`);
  const runner = createRulesRunner({ rulesPath: file });
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('a hang is terminated within the budget and falls back', async () => {
  const file = writeRules(`module.exports = () => { while (true) {} };`);
  const runner = createRulesRunner({ rulesPath: file, timeoutMs: 60 });
  const started = Date.now();
  const result = await runner.run({ type: 'done' }, DEF);
  const elapsed = Date.now() - started;
  assert.deepEqual(result, DEF);
  assert.ok(elapsed < 2000, `hang should resolve near the budget, took ${elapsed}ms`);
  await runner.close();
});

test('recovers after a hang — the next call works', async () => {
  // Hang on one event type, behave on another, so recovery is demonstrable
  // (a counter would reset when the respawned worker re-requires the file).
  const file = writeRules(`
    module.exports = (event, def) => {
      if (event.type === 'hang') { while (true) {} }
      return { ...def, scalePulse: 3 };
    };
  `);
  const runner = createRulesRunner({ rulesPath: file, timeoutMs: 60 });
  assert.deepEqual(await runner.run({ type: 'hang' }, DEF), DEF); // hang -> default
  // The next call hits a freshly respawned worker and succeeds.
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), { sound: DEF.sound, scalePulse: 3 });
  await runner.close();
});

test('serializes calls so results are never mismatched', async () => {
  const file = writeRules(`
    module.exports = (event, def) => ({ ...def, scalePulse: event.n });
  `);
  const runner = createRulesRunner({ rulesPath: file });
  const results = await Promise.all([
    runner.run({ type: 'done', n: 1.1 }, DEF),
    runner.run({ type: 'done', n: 1.2 }, DEF),
    runner.run({ type: 'done', n: 1.3 }, DEF),
  ]);
  assert.deepEqual(results.map((r) => r.scalePulse), [1.1, 1.2, 1.3]);
  await runner.close();
});

test('run never rejects, even under abuse', async () => {
  const file = writeRules(`module.exports = () => { throw 'a string, not an Error'; };`);
  const runner = createRulesRunner({ rulesPath: file });
  await assert.doesNotReject(() => runner.run({ type: 'done' }, DEF));
  await runner.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/rules.test.js`
Expected: FAIL — `Cannot find module '../src/rules.js'`

- [ ] **Step 3: Write the worker**

Create `src/rules-worker.js`:

```js
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
```

- [ ] **Step 4: Write the runner**

Create `src/rules.js`:

```js
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
```

- [ ] **Step 5: Write the example file**

Create `rules.example.js`:

```js
'use strict';

/**
 * Claude Buddy rules — OPTIONAL.
 *
 * Copy this file to `rules.js` (same directory) to enable it. It runs in a
 * worker thread on every Claude Code event and may override how that event is
 * handled. It is YOUR code and is never auto-updated.
 *
 * Signature: (event, defaultBehavior) => Behavior | null
 *   event           = { type, message?, cwd?, at }
 *   defaultBehavior = { sound: string|null, scalePulse: number }
 *   return the behavior to use, or null to ignore the event entirely.
 *
 * A thrown error, a return outside the contract, or a hang all fall back to
 * defaultBehavior — a broken rules.js cannot break the pet.
 */
module.exports = function rules(event, defaultBehavior) {
  // Quiet hours: no sound between 11pm and 7am.
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) return { ...defaultBehavior, sound: null };

  // A louder, bigger celebration when your tests pass.
  if (event.type === 'done' && /tests?\s+pass/i.test(event.message ?? '')) {
    return { ...defaultBehavior, sound: 'sounds/fanfare.mp3', scalePulse: 2 };
  }

  // Ignore a noisy scratch project entirely.
  if (event.cwd && event.cwd.includes('scratch')) return null;

  return defaultBehavior;
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/rules.test.js`
Expected: PASS — including the hang test resolving near the 60ms budget

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`

```bash
git add src/rules-worker.js src/rules.js rules.example.js test/rules.test.js
git commit -m "feat: run rules.js in a hang-proof worker thread with a timeout"
```

---

### Task 4: Wire rules into the event pipeline

**Files:**
- Modify: `src/main.js`
- Modify: `src/renderer/renderer.js`
- Modify: `src/renderer/sound.js`
- Modify: `.gitignore` (ensure `rules.js` and `state.json` are ignored)

**Interfaces:**
- Consumes: `createRulesRunner` from `src/rules.js`; `defaultBehaviorFor` from `src/behavior.js`; `createSoundCache` from `src/sound-cache.js`
- Produces: an event pipeline that, when `rules.js` exists, resolves a per-event behavior and attaches it to the `state-change` payload as `change.behavior = { scalePulse, soundUri }`

**Note on testing:** the wiring is verified by the controller driving the real app. The logic worth unit-testing (behavior, sanitization, the runner, the cache) is already covered in Tasks 1–3.

- [ ] **Step 1: Add `playUri` to the sound player**

In `src/renderer/sound.js`, add this method to the object returned by `createSoundPlayer`, right after `play(state)`:

```js
    /**
     * Play an ad-hoc sound delivered as a data URI (used when rules.js selects
     * a sound per event). Cached by URI so a repeated sound is decoded once.
     */
    playUri(dataUri) {
      if (!isEnabled || !dataUri) return;
      let audio = uriCache.get(dataUri);
      if (!audio) {
        try {
          audio = new Audio(dataUri);
          audio.volume = Math.min(1, Math.max(0, volume));
          uriCache.set(dataUri, audio);
        } catch {
          return;
        }
      }
      try {
        audio.currentTime = 0;
        const r = audio.play();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {
        /* never let audio break the animation */
      }
    },
```

And add the cache near the top of `createSoundPlayer`, beside the existing `cache`:

```js
  const uriCache = new Map();
```

- [ ] **Step 2: Consume behavior in the renderer**

In `src/renderer/renderer.js`, replace the body of `applyState` from the `// A per-state scalePulse` comment through the `if (sounds) sounds.play(change.state);` line with:

```js
    // When rules.js is active, main resolves the per-event behavior and attaches
    // it here; otherwise fall back to the theme/config defaults the renderer
    // already holds.
    const behavior = change.behavior;

    const pulse = behavior
      ? behavior.scalePulse
      : stateConfig[change.state] && stateConfig[change.state].scalePulse;
    if (Number.isFinite(pulse) && pulse !== 1) {
      stage.style.setProperty('--pulse', String(pulse));
      stage.classList.remove('pulsing');
      void stage.offsetWidth;
      stage.classList.add('pulsing');
    }

    if (behavior) {
      // soundUri: a data URI to play, or null for deliberate silence.
      if (sounds && behavior.soundUri) sounds.playUri(behavior.soundUri);
    } else if (sounds) {
      sounds.play(change.state);
    }
```

- [ ] **Step 3: Wire the runner into `src/main.js`**

Add to the requires near the top:

```js
const { createRulesRunner } = require('./rules.js');
const { defaultBehaviorFor } = require('./behavior.js');
const { createSoundCache } = require('./sound-cache.js');
```

Add module-level state after `const assets = loadAssets(...)`:

```js
const soundCache = createSoundCache(PROJECT_ROOT);
const rules = createRulesRunner({
  rulesPath: path.join(PROJECT_ROOT, 'rules.js'),
  onError: (reason) => console.warn(`[buddy] rules.js: ${reason}`),
});
if (rules.active) console.log('[buddy] rules.js is active');
```

Replace the `onEvent` handler in `startServer` with:

```js
    onEvent: async (event) => {
      // Fast path: no rules.js, behave exactly as before.
      if (!rules.active) {
        pushStateChange(machine.handleEvent(event, Date.now()));
        return;
      }

      const def = defaultBehaviorFor(config, event);
      const behavior = await rules.run(event, def);
      if (behavior === null) return; // rules suppressed this event

      const change = machine.handleEvent(event, Date.now());
      if (!change) return;

      pushStateChange({
        ...change,
        behavior: {
          scalePulse: behavior.scalePulse,
          soundUri: soundCache.resolve(behavior.sound),
        },
      });
    },
```

Add worker cleanup to the `before-quit` handler, right after `clearInterval(tickTimer);`:

```js
  rules.close().catch(() => {});
```

- [ ] **Step 4: Ensure the ignores exist**

Confirm `.gitignore` contains `rules.js` and `state.json`. Add whichever is missing under the "Local user configuration" section:

```
rules.js
state.json
```

- [ ] **Step 5: Verify the app still boots with no rules.js**

**Environment note:** this shell has `ELECTRON_RUN_AS_NODE` set, which breaks `require('electron')`. Prefix launches with `env -u ELECTRON_RUN_AS_NODE`.

Run: `npm start`
Expected: the pet behaves exactly as before. No `[buddy] rules.js is active` line (there is no `rules.js`). POST a `done` event and confirm the pet reacts:

```bash
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"done\"}"
```

- [ ] **Step 6: Verify with a real rules.js**

Create a temporary `rules.js` at the project root:

```js
module.exports = (event, def) => {
  if (event.cwd && event.cwd.includes('scratch')) return null; // suppress
  if (event.type === 'done') return { ...def, scalePulse: 2 };  // bigger pulse
  return def;
};
```

Run `npm start`. Confirm the console prints `[buddy] rules.js is active`. Then:

```bash
# bigger pulse on done
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"done\"}"
# suppressed — the pet should NOT react
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"done\",\"cwd\":\"/tmp/scratch/x\"}"
```

Expected: the first makes the pet jump with a visibly larger pulse; the second does nothing.

Then **delete `rules.js`** so it is not left in the working tree.

- [ ] **Step 7: Verify a hanging rules.js does not freeze the pet**

Create a temporary `rules.js`:

```js
module.exports = () => { while (true) {} };
```

Run `npm start`, then POST an event. Expected: the pet still reacts (falling back to default behavior after the ~50ms timeout), the window stays draggable, and the tray Quit still works — the hang is contained in the worker. Then **delete `rules.js`**.

- [ ] **Step 8: Run the suite and commit**

Run: `npm test`

```bash
git add src/main.js src/renderer/renderer.js src/renderer/sound.js .gitignore
git commit -m "feat: resolve per-event behavior through rules.js and attach it to state-change"
```

---

## Phase 3A Definition of Done

- [ ] `npm test` passes, with no earlier test broken
- [ ] With no `rules.js`, the pet behaves exactly as before and the `state-change` payload carries no `behavior`
- [ ] A valid `rules.js` can change a state's pulse and sound and can suppress an event
- [ ] An out-of-contract return (bad pulse, traversal sound path) is sanitized to the default
- [ ] A throwing `rules.js` falls back to default behavior
- [ ] A `rules.js` that fails to load or does not export a function falls back to default behavior
- [ ] A hanging `rules.js` is terminated within the budget; the pet stays responsive
- [ ] The worker is cleaned up on quit
- [ ] The IPC surface is unchanged (still `onStateChange`, `onAssets`, `animationEnded`)
- [ ] `package.json` still lists **electron and nothing else**

---

## Deferred to 3B / 3C

- **3B — `import-sprite`:** normalize messy source art (render SVG/JPG, chroma-key, trim, re-composite to a shared baseline) into a conforming sheet + `theme.json` stub, built on Electron's canvas.
- **3C — interaction cluster:** click reactions, `clickThrough` (spec §6.3), position persistence to `state.json`, speech bubbles rendering `event.message`.

---

## Post-implementation amendment: readiness gate (Task 3)

Final verification caught a flaky full-suite failure: the single 50ms timeout
bounded worker COLD START (thread spawn + `require(rules.js)`) as well as
execution. Under full-suite parallelism, spawn occasionally exceeded 50ms, so
the FIRST call spuriously timed out and returned the default instead of the
override — a real correctness bug (the first real event after startup could
silently fall back under load), not merely a test flake.

Fix: split the budget in two. `src/rules-worker.js` posts `{ready:true}` after
registering its message handler; `src/rules.js` gates every call on that
readiness (bounded by a generous `spawnTimeoutMs`, default 5000ms) and starts
the tight `timeoutMs` (50ms) execution clock only once the worker is ready.
Cold-start cost is therefore never mistaken for a slow rules function, while a
genuine hang on a ready worker is still caught at ~50ms.

Verified: full suite 10/10 clean after the change; a rules.js that takes 150ms
to load still applies its override under a 20ms execution budget; a module that
never finishes loading falls back near the spawn budget. Two regression tests
added. The committed source is authoritative.
