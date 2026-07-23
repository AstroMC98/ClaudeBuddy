# Claude Buddy — Phase 1 (Minimum Viable Buddy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a transparent, always-on-top desktop pet that visibly reacts when Claude Code starts thinking, finishes a task, needs input, or errors — driven end-to-end by real Claude Code hooks.

**Architecture:** A Claude Code hook runs a zero-dependency Node shim (`hooks/notify.js`) which POSTs a JSON event to a loopback-only HTTP server inside the Electron main process. The main process feeds that event to a pure, framework-free state machine, and pushes the resulting state change over a single narrow IPC channel to a sandboxed renderer, which animates a procedurally-drawn blob. All state logic lives in the main process; the renderer only ever learns "you are now in state X."

**Tech Stack:** Electron 43 (the only dependency), Node 24, `node:http`, `node:test`, plain HTML/CSS/JS.

**Scope:** This plan implements steps 1–5 of the spec's build order (§12), plus the hook installer. It delivers a genuinely reacting pet. Sounds, the full config layer with `rules.js`, the sprite/theme system, and `import-sprite` are **Phase 2** and are deliberately out of scope here.

**Spec:** [`docs/superpowers/specs/2026-07-23-claude-buddy-design.md`](../specs/2026-07-23-claude-buddy-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Electron is the ONLY entry in `package.json` dependencies or devDependencies.** No Express, no test framework, no animation library, no HTTP client. If a task seems to need a package, it does not — use the Node standard library.
- **Tests run via the built-in runner:** `npm test` → `node --test test/*.js`. Never introduce Jest, Mocha, Vitest, or Chai. (The glob is required: on Node 22+, a bare directory argument is resolved as a module path and fails with `MODULE_NOT_FOUND`. Node expands the glob itself, so this works regardless of shell.)
- **Node `>=20`** declared in `package.json` engines. Development machine is Node 24.16.0.
- **The HTTP server binds to `127.0.0.1` only — never `0.0.0.0`.** This is a tested invariant, not a convention.
- **Electron hardening is mandatory** on every `BrowserWindow`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The window loads local files only and declares a strict CSP.
- **Zero outbound network connections.** The app listens; it never calls out. No telemetry, no update checks, no remote assets, no remote fonts.
- **No autostart and no packaged binaries.** The app is run from source via `npm start`.
- **`hooks/notify.js` must ALWAYS exit 0**, including when nothing is listening, and must terminate within ~1.5s. A dead pet must never stall or fail a Claude Code session.
- **State keys are lowercase-camel and case-sensitive:** `idle`, `thinking`, `working`, `done`, `needsInput`, `subagent`, `error`, `sleeping`.
- **`themes/` is gitignored** (generated). `assets/sprites/` holds committed master art. Do not commit anything into `themes/`.
- **Use `'use strict';` and CommonJS (`require`/`module.exports`)** throughout. Electron's `sandbox: true` preload requires CommonJS, so the whole project stays consistent.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Scripts, engines, the single Electron dependency |
| `config.example.json` | Committed sample of user config |
| `src/config.js` | Load + merge `config.json` over defaults. Never throws |
| `src/state-machine.js` | **Pure.** `(state, event) → state`. Zero imports |
| `src/server.js` | Loopback HTTP listener; validates + normalizes events |
| `src/main.js` | Electron lifecycle, window, tray, wiring |
| `src/preload.js` | `contextBridge` — the entire IPC surface |
| `src/renderer/index.html` | Window markup + CSP |
| `src/renderer/styles.css` | Blob visuals and per-state keyframes |
| `src/renderer/procedural.js` | Default renderer: procedurally-drawn blob |
| `src/renderer/renderer.js` | Subscribes to IPC, drives the active renderer |
| `hooks/notify.js` | Zero-dep shim invoked by Claude Code hooks |
| `tools/install-hooks.js` | Merge hook entries into `~/.claude/settings.json` |
| `test/*.test.js` | Unit + integration tests |

**Dependency direction:** `state-machine.js` imports nothing. `server.js` imports only `state-machine.js` (for the event allowlist) and `node:http`. `main.js` imports everything. The renderer imports nothing from `src/` outside its own folder. This keeps the two most valuable modules testable without Electron.

---

### Task 1: Project scaffold and config loader

**Files:**
- Create: `package.json`
- Create: `config.example.json`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `loadConfig(filePath?: string) => Config` — never throws; returns defaults on any failure
  - `DEFAULTS: Config` — frozen object
  - `Config` shape: `{ port: number, token: string|null, idleTimeoutMinutes: number, scale: number, alwaysOnTop: boolean, width: number, height: number }`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-buddy",
  "version": "0.1.0",
  "private": true,
  "description": "A customizable desktop pet that reacts to Claude Code activity",
  "main": "src/main.js",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "electron .",
    "test": "node --test test/*.js",
    "install-hooks": "node tools/install-hooks.js"
  },
  "devDependencies": {
    "electron": "^43.2.0"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/config.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, DEFAULTS } = require('../src/config.js');

function tempConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('returns defaults when the file does not exist', () => {
  const cfg = loadConfig(path.join(os.tmpdir(), 'definitely-not-here-12345.json'));
  assert.deepEqual(cfg, DEFAULTS);
});

test('merges a partial config over the defaults', () => {
  const file = tempConfig(JSON.stringify({ port: 5000, scale: 0.5 }));
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 5000);
  assert.equal(cfg.scale, 0.5);
  assert.equal(cfg.idleTimeoutMinutes, DEFAULTS.idleTimeoutMinutes);
  assert.equal(cfg.alwaysOnTop, DEFAULTS.alwaysOnTop);
});

test('returns defaults when the file is malformed JSON', () => {
  const file = tempConfig('{ this is not json');
  assert.deepEqual(loadConfig(file), DEFAULTS);
});

test('returns defaults when the file contains a JSON non-object', () => {
  const file = tempConfig('[1, 2, 3]');
  assert.deepEqual(loadConfig(file), DEFAULTS);
});

test('does not mutate DEFAULTS across calls', () => {
  const file = tempConfig(JSON.stringify({ port: 9999 }));
  loadConfig(file);
  assert.equal(DEFAULTS.port, 4747);
});

test('drops unknown keys so the shape is exactly Config', () => {
  const file = tempConfig(JSON.stringify({ port: 5000, nonsense: 'x' }));
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 5000);
  assert.deepEqual(Object.keys(cfg).sort(), Object.keys(DEFAULTS).sort());
});

test('falls back to the default for a wrong-typed value', () => {
  const file = tempConfig(
    JSON.stringify({
      port: '5000',
      idleTimeoutMinutes: 'soon',
      alwaysOnTop: 'yes',
      scale: null,
      token: 42,
    }),
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.port, DEFAULTS.port);
  assert.equal(cfg.idleTimeoutMinutes, DEFAULTS.idleTimeoutMinutes);
  assert.equal(cfg.alwaysOnTop, DEFAULTS.alwaysOnTop);
  assert.equal(cfg.scale, DEFAULTS.scale);
  assert.equal(cfg.token, DEFAULTS.token);
});

test('rejects out-of-range and nonsensical numbers', () => {
  const file = tempConfig(
    JSON.stringify({ port: 99999, scale: 0, width: -10, idleTimeoutMinutes: 0 }),
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.port, DEFAULTS.port);
  assert.equal(cfg.scale, DEFAULTS.scale);
  assert.equal(cfg.width, DEFAULTS.width);
  assert.equal(cfg.idleTimeoutMinutes, DEFAULTS.idleTimeoutMinutes);
});

test('accepts a valid token string and an explicit null', () => {
  assert.equal(loadConfig(tempConfig('{"token":"s3cret"}')).token, 's3cret');
  assert.equal(loadConfig(tempConfig('{"token":null}')).token, null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 4: Write the implementation**

Create `src/config.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Default configuration. Frozen so callers cannot corrupt it. */
const DEFAULTS = Object.freeze({
  port: 4747,
  token: null,
  idleTimeoutMinutes: 10,
  scale: 1.0,
  alwaysOnTop: true,
  width: 320,
  height: 320,
});

/**
 * A type guard per key. A user value is accepted only if it satisfies its
 * guard; anything else falls back to the default.
 *
 * This matters because consumers do arithmetic on these values. A string
 * `idleTimeoutMinutes` would become NaN downstream and the buddy would simply
 * never fall asleep — a silent failure with no error to trace. Validating once
 * here means every later module can trust the Config contract.
 */
const VALIDATORS = Object.freeze({
  port: (v) => Number.isInteger(v) && v >= 0 && v <= 65535,
  token: (v) => v === null || (typeof v === 'string' && v.length > 0),
  idleTimeoutMinutes: (v) => Number.isFinite(v) && v > 0,
  scale: (v) => Number.isFinite(v) && v > 0,
  alwaysOnTop: (v) => typeof v === 'boolean',
  width: (v) => Number.isInteger(v) && v > 0,
  height: (v) => Number.isInteger(v) && v > 0,
});

/** Path to the user's config file at the project root. */
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Load configuration, validating the user's file against the defaults.
 * Never throws: any missing, unreadable, or malformed file yields the defaults.
 * Unknown keys are dropped and wrong-typed values fall back to their default,
 * so the returned object always has exactly the Config shape.
 *
 * @param {string} [filePath]
 * @returns {typeof DEFAULTS}
 */
function loadConfig(filePath = CONFIG_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { ...DEFAULTS };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULTS };
  }

  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.hasOwn(parsed, key)) continue;
    if (VALIDATORS[key](parsed[key])) config[key] = parsed[key];
  }
  return config;
}

module.exports = { loadConfig, DEFAULTS, CONFIG_PATH };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 9 tests passing

- [ ] **Step 6: Create `config.example.json`**

```json
{
  "port": 4747,
  "token": null,
  "idleTimeoutMinutes": 10,
  "scale": 1.0,
  "alwaysOnTop": true,
  "width": 320,
  "height": 320
}
```

- [ ] **Step 7: Install Electron**

Run: `npm install`
Expected: `node_modules/` created; `package-lock.json` written. Verify with `node -e "console.log(require('./package.json').devDependencies)"` → `{ electron: '^43.2.0' }`

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json config.example.json src/config.js test/config.test.js
git commit -m "feat: scaffold project and add config loader"
```

---

### Task 2: Pure state machine

**Files:**
- Create: `src/state-machine.js`
- Test: `test/state-machine.test.js`

**Interfaces:**
- Consumes: nothing (this module has zero imports by design)
- Produces:
  - `createStateMachine({ idleTimeoutMs?: number, now?: number }) => Machine`
  - `Machine.getState() => string`
  - `Machine.handleEvent(event: {type: string}, nowMs: number) => StateChange | null`
  - `Machine.completeOneShot() => StateChange | null`
  - `Machine.tick(nowMs: number) => StateChange | null`
  - `StateChange` shape: `{ state: string, previous: string, loop: boolean, next: string|null }`
  - Exported constants: `STATES: string[]`, `EVENT_TYPES: string[]`, `ONE_SHOT: Record<string,string>`, `DEFAULT_IDLE_TIMEOUT_MS: number`

- [ ] **Step 1: Write the failing test**

Create `test/state-machine.test.js`:

```js
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

test('tick never sleeps a buddy that is not idle', () => {
  const m = createStateMachine({ idleTimeoutMs: 1000, now: 0 });
  m.handleEvent({ type: 'thinking' }, 10);
  assert.equal(m.tick(100000), null);
  assert.equal(m.getState(), 'thinking');
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/state-machine.test.js`
Expected: FAIL — `Cannot find module '../src/state-machine.js'`

- [ ] **Step 3: Write the implementation**

Create `src/state-machine.js`:

```js
'use strict';

/**
 * The buddy's state machine.
 *
 * Deliberately pure: this module imports nothing, touches no clock, and has no
 * knowledge of Electron, HTTP or the DOM. The caller supplies the current time.
 * That is what makes idle-timeout behaviour testable without waiting ten minutes.
 */

/** Every state the buddy can occupy. */
const STATES = Object.freeze([
  'idle',
  'thinking',
  'working',
  'done',
  'needsInput',
  'subagent',
  'error',
  'sleeping',
]);

/**
 * Event types accepted from hooks. Each maps 1:1 onto the state of the same name.
 * `idle` and `sleeping` are absent: they are reached by transition, never by event.
 */
const EVENT_TYPES = Object.freeze([
  'thinking',
  'working',
  'done',
  'needsInput',
  'subagent',
  'error',
]);

/** One-shot states play once, then fall through to their successor. */
const ONE_SHOT = Object.freeze({
  done: 'idle',
  subagent: 'thinking',
  error: 'idle',
});

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** `Object.hasOwn` avoids inherited keys such as `constructor` matching. */
function successorOf(state) {
  return Object.hasOwn(ONE_SHOT, state) ? ONE_SHOT[state] : null;
}

function isEventType(type) {
  return typeof type === 'string' && EVENT_TYPES.includes(type);
}

function buildChange(state, previous) {
  const next = successorOf(state);
  return { state, previous, loop: next === null, next };
}

/**
 * @param {{ idleTimeoutMs?: number, now?: number }} [options]
 */
function createStateMachine(options = {}) {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let state = 'idle';
  let lastEventAt = options.now ?? 0;

  return {
    getState() {
      return state;
    },

    /**
     * Apply an incoming hook event. Any event interrupts the current animation:
     * responsiveness matters more than animation integrity.
     * @returns {object|null} the state change, or null if the event was ignored
     */
    handleEvent(event, nowMs) {
      if (event === null || typeof event !== 'object') return null;
      if (!isEventType(event.type)) return null;

      lastEventAt = nowMs;
      const previous = state;
      state = event.type;
      return buildChange(state, previous);
    },

    /**
     * Called when a non-looping animation finishes playing.
     * @returns {object|null} the follow-on change, or null if nothing to advance
     */
    completeOneShot() {
      const successor = successorOf(state);
      if (successor === null) return null;

      const previous = state;
      state = successor;
      return buildChange(state, previous);
    },

    /**
     * Drive the idle timeout. Only an idle buddy falls asleep, and only once:
     * the state guard stops this re-firing every tick.
     * @returns {object|null}
     */
    tick(nowMs) {
      if (state !== 'idle') return null;
      if (nowMs - lastEventAt < idleTimeoutMs) return null;

      const previous = state;
      state = 'sleeping';
      return buildChange(state, previous);
    },
  };
}

module.exports = {
  createStateMachine,
  STATES,
  EVENT_TYPES,
  ONE_SHOT,
  DEFAULT_IDLE_TIMEOUT_MS,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/state-machine.test.js`
Expected: PASS — 18 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/state-machine.js test/state-machine.test.js
git commit -m "feat: add pure state machine with idle-timeout sleep"
```

---

### Task 3: Loopback HTTP event server

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `EVENT_TYPES` from `src/state-machine.js`
- Produces:
  - `createEventServer({ host?, port?, token?, onEvent, now? }) => EventServer`
  - `EventServer.listen() => Promise<{address: string, port: number}>`
  - `EventServer.close() => Promise<void>`
  - `EventServer.address() => {address: string, port: number}|null`
  - `onEvent` receives `{ type: string, at: number, message?: string, cwd?: string }`
  - Exported constants: `MAX_BODY_BYTES: number`, `MAX_TEXT_LENGTH: number`

**HTTP contract:**

| Request | Response |
|---|---|
| `POST /event` valid | `202` `{"ok":true}` |
| `POST /event` unknown type / not an object | `400` |
| `POST /event` malformed JSON | `400` |
| `POST /event` body over 8 KiB | `413` |
| `POST /event` wrong or missing token (when configured) | `401` |
| `GET /event` | `405` |
| any other path | `404` |

- [ ] **Step 1: Write the failing test**

Create `test/server.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 3: Write the implementation**

Create `src/server.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS — 15 tests passing

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — 42 tests passing (9 config + 18 state machine + 15 server)

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: add loopback-only HTTP event server with strict validation"
```

---

### Task 4: The `notify.js` hook shim

**Files:**
- Create: `hooks/notify.js`
- Test: `test/notify.test.js`

**Interfaces:**
- Consumes: `loadConfig` from `src/config.js`; `createEventServer` from `src/server.js` (test only)
- Produces: a CLI invoked as `node hooks/notify.js <eventType>`, reading the Claude Code hook payload from stdin. **Always exits 0.**

**Why this exists:** Claude Code hooks are shell commands. Embedding escaped JSON inside a JSON settings file inside a shell command is unreadable and breaks differently per shell. This shim takes the event name as `argv[2]` and handles stdin, timeouts and failure silently.

- [ ] **Step 1: Write the failing test**

Create `test/notify.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/notify.test.js`
Expected: FAIL — the spawned process cannot find `hooks/notify.js`, so `code` is 1

- [ ] **Step 3: Write the implementation**

Create `hooks/notify.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/notify.test.js`
Expected: PASS — 7 tests passing

- [ ] **Step 5: Verify the exit code by hand**

Run: `node hooks/notify.js done; echo "exit=$?"`
Expected: `exit=0` — printed within about a second, with nothing listening

- [ ] **Step 6: Commit**

```bash
git add hooks/notify.js test/notify.test.js
git commit -m "feat: add zero-dependency hook shim that always exits 0"
```

---

### Task 5: Electron window and procedural blob renderer

**Files:**
- Create: `src/main.js`
- Create: `src/preload.js`
- Create: `src/renderer/index.html`
- Create: `src/renderer/styles.css`
- Create: `src/renderer/procedural.js`
- Create: `src/renderer/renderer.js`

**Interfaces:**
- Consumes: `loadConfig` from `src/config.js`
- Produces:
  - `window.buddy.onStateChange(cb)` — renderer subscribes to state changes
  - `window.buddy.animationEnded()` — renderer reports a one-shot animation finished
  - `createProceduralRenderer() => Renderer`
  - `Renderer.mount(rootEl: HTMLElement) => void`
  - `Renderer.setState(change: StateChange) => void`
  - `Renderer.destroy() => void`

**Note on testing:** Electron window creation and CSS animation are verified manually — a unit test harness for them would cost more than it catches at this stage. The logic worth testing (state machine, server, shim) is already covered and deliberately lives outside this task. Verification steps below are explicit and must actually be performed.

- [ ] **Step 1: Create the preload bridge**

Create `src/preload.js`:

```js
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The ENTIRE IPC surface. The renderer is sandboxed and can reach nothing else.
 * Keep this minimal: every addition here is attack surface.
 */
contextBridge.exposeInMainWorld('buddy', {
  /** @param {(change: object) => void} callback */
  onStateChange(callback) {
    ipcRenderer.on('state-change', (_event, change) => callback(change));
  },

  /** Report that a non-looping animation has finished playing. */
  animationEnded() {
    ipcRenderer.send('animation-ended');
  },
});
```

- [ ] **Step 2: Create the window markup**

Create `src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:;"
    />
    <title>Claude Buddy</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <div id="stage"></div>
    <div id="badge" aria-live="polite"></div>
    <script src="procedural.js"></script>
    <script src="renderer.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the stylesheet**

Create `src/renderer/styles.css`:

```css
/* The window itself is transparent; only the buddy is painted. */
html,
body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  overflow: hidden;
  user-select: none;
  cursor: default;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

#stage {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
}

/* Dragging the body moves the window. */
.buddy {
  position: relative;
  width: 160px;
  height: 160px;
  -webkit-app-region: drag;
  transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.buddy__body {
  position: absolute;
  inset: 20px 10px 10px;
  border-radius: 48% 48% 44% 44% / 56% 56% 40% 40%;
  background: radial-gradient(circle at 34% 28%, #ffb27a 0%, #f0803c 55%, #d2621f 100%);
  box-shadow:
    inset -8px -10px 18px rgba(0, 0, 0, 0.18),
    inset 6px 8px 16px rgba(255, 255, 255, 0.32),
    0 10px 18px rgba(0, 0, 0, 0.28);
  animation: breathe 3.4s ease-in-out infinite;
  transform-origin: 50% 100%;
}

.buddy__eye {
  position: absolute;
  top: 46%;
  width: 16px;
  height: 18px;
  background: #2a1508;
  border-radius: 50%;
  animation: blink 4.6s ease-in-out infinite;
}
.buddy__eye--left {
  left: 32%;
}
.buddy__eye--right {
  right: 32%;
}

.buddy__mouth {
  position: absolute;
  top: 62%;
  left: 50%;
  width: 22px;
  height: 10px;
  margin-left: -11px;
  border-bottom: 3px solid #2a1508;
  border-radius: 0 0 22px 22px;
  opacity: 0.85;
}

.buddy__zzz {
  position: absolute;
  top: -6px;
  right: 4px;
  font-size: 22px;
  font-weight: 700;
  color: #cfd6e6;
  opacity: 0;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
}

/* A short, sharp attention pulse applied on entering a state. */
.buddy--pulse {
  animation: pulse 420ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* ---- per-state overrides ---------------------------------------------- */

.buddy--thinking .buddy__body {
  animation: breathe 1.1s ease-in-out infinite;
}
.buddy--working .buddy__body {
  animation: wobble 0.6s ease-in-out infinite;
}
.buddy--done .buddy__body {
  animation: celebrate 900ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.buddy--needsInput .buddy__body {
  animation: knock 620ms ease-in-out infinite;
}
.buddy--subagent .buddy__body {
  animation: blip 380ms ease-out;
}
.buddy--error .buddy__body {
  animation: shake 520ms ease-in-out;
  filter: saturate(0.5) brightness(0.85);
}
.buddy--sleeping .buddy__body {
  animation: breathe 5.2s ease-in-out infinite;
  filter: brightness(0.72) saturate(0.7);
}
.buddy--sleeping .buddy__eye {
  height: 3px;
  border-radius: 3px;
  animation: none;
}
.buddy--sleeping .buddy__zzz {
  animation: floatZzz 3.2s ease-in-out infinite;
}

/* ---- keyframes --------------------------------------------------------- */

@keyframes breathe {
  0%,
  100% {
    transform: scale(1, 1);
  }
  50% {
    transform: scale(1.04, 0.96);
  }
}

@keyframes blink {
  0%,
  92%,
  100% {
    transform: scaleY(1);
  }
  95% {
    transform: scaleY(0.08);
  }
}

@keyframes wobble {
  0%,
  100% {
    transform: rotate(-4deg) scale(1, 1);
  }
  50% {
    transform: rotate(4deg) scale(0.98, 1.02);
  }
}

@keyframes celebrate {
  0% {
    transform: translateY(0) scale(1, 1);
  }
  25% {
    transform: translateY(-34px) scale(0.9, 1.12);
  }
  55% {
    transform: translateY(0) scale(1.16, 0.86);
  }
  75% {
    transform: translateY(-12px) scale(0.97, 1.04);
  }
  100% {
    transform: translateY(0) scale(1, 1);
  }
}

@keyframes knock {
  0%,
  100% {
    transform: translateX(0) rotate(0deg);
  }
  20% {
    transform: translateX(-9px) rotate(-7deg);
  }
  40% {
    transform: translateX(9px) rotate(7deg);
  }
  60% {
    transform: translateX(-6px) rotate(-4deg);
  }
  80% {
    transform: translateX(6px) rotate(4deg);
  }
}

@keyframes blip {
  0% {
    transform: scale(1, 1);
  }
  50% {
    transform: scale(1.12, 0.9);
  }
  100% {
    transform: scale(1, 1);
  }
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20% {
    transform: translateX(-10px);
  }
  40% {
    transform: translateX(10px);
  }
  60% {
    transform: translateX(-6px);
  }
  80% {
    transform: translateX(6px);
  }
}

@keyframes pulse {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.32);
  }
  100% {
    transform: scale(1);
  }
}

@keyframes floatZzz {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.8);
  }
  30% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: translate(14px, -30px) scale(1.15);
  }
}

/* Small state label, useful while developing. Hidden unless enabled. */
#badge {
  position: absolute;
  bottom: 4px;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  pointer-events: none;
  opacity: 0;
  transition: opacity 150ms ease;
}
#badge.visible {
  opacity: 1;
}
```

- [ ] **Step 4: Create the procedural renderer**

Create `src/renderer/procedural.js`:

```js
'use strict';

/**
 * Default renderer: a procedurally-drawn blob, no art assets required.
 *
 * Implements the Renderer interface that a future sprite-sheet renderer will
 * also implement — mount / setState / destroy. Keeping this contract narrow is
 * what makes the renderer pluggable rather than merely "replaceable one day".
 */
function createProceduralRenderer() {
  let root = null;
  let el = null;
  let currentState = null;
  let pulseTimer = null;

  /** One-shot animations report completion so the machine can advance. */
  const ONE_SHOT_DURATION_MS = {
    done: 900,
    subagent: 380,
    error: 520,
  };

  let settleTimer = null;

  function build() {
    const buddy = document.createElement('div');
    buddy.className = 'buddy';
    buddy.innerHTML = [
      '<div class="buddy__zzz">z</div>',
      '<div class="buddy__body">',
      '  <div class="buddy__eye buddy__eye--left"></div>',
      '  <div class="buddy__eye buddy__eye--right"></div>',
      '  <div class="buddy__mouth"></div>',
      '</div>',
    ].join('');
    return buddy;
  }

  return {
    mount(rootEl) {
      root = rootEl;
      el = build();
      root.appendChild(el);
      this.setState({ state: 'idle', previous: null, loop: true, next: null });
    },

    /**
     * @param {{state: string, previous: string|null, loop: boolean, next: string|null}} change
     */
    setState(change) {
      if (!el) return;

      if (currentState) el.classList.remove(`buddy--${currentState}`);
      currentState = change.state;
      el.classList.add(`buddy--${currentState}`);

      // Restart the attention pulse from scratch on every state entry.
      el.classList.remove('buddy--pulse');
      void el.offsetWidth; // force reflow so the animation replays
      el.classList.add('buddy--pulse');
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => el && el.classList.remove('buddy--pulse'), 460);

      // Tell the main process when a one-shot animation has finished.
      clearTimeout(settleTimer);
      if (!change.loop && change.next) {
        const duration = ONE_SHOT_DURATION_MS[change.state] ?? 600;
        settleTimer = setTimeout(() => window.buddy.animationEnded(), duration);
      }
    },

    destroy() {
      clearTimeout(pulseTimer);
      clearTimeout(settleTimer);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
      root = null;
      currentState = null;
    },
  };
}

window.createProceduralRenderer = createProceduralRenderer;
```

- [ ] **Step 5: Create the renderer entry point**

Create `src/renderer/renderer.js`:

```js
'use strict';

(function main() {
  const stage = document.getElementById('stage');
  const badge = document.getElementById('badge');

  const renderer = window.createProceduralRenderer();
  renderer.mount(stage);

  window.buddy.onStateChange((change) => {
    renderer.setState(change);
    badge.textContent = change.state;
    badge.classList.add('visible');
    clearTimeout(main.badgeTimer);
    main.badgeTimer = setTimeout(() => badge.classList.remove('visible'), 1600);
  });
})();
```

- [ ] **Step 6: Create the Electron main process**

Create `src/main.js`:

```js
'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage } = require('electron');

const { loadConfig } = require('./config.js');

const config = loadConfig();

let win = null;
let tray = null;

function createWindow() {
  win = new BrowserWindow({
    width: config.width,
    height: config.height,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: config.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 'screen-saver' keeps the buddy above full-screen windows too.
  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

function createTray() {
  // A 1x1 transparent image keeps us dependency- and asset-free for now.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR4' +
      'AWMYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUAAAHkgABs1sVjwAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('Claude Buddy');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Listening on 127.0.0.1:${config.port}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

// A desktop pet has no business quitting when its window closes.
app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 7: Verify the window appears**

Run: `npm start`

Expected, all of which you must actually confirm:
1. A **transparent, frameless** window appears with an orange blob — no title bar, no white rectangle around it
2. The blob **breathes** (gentle squash and stretch) and **blinks** periodically
3. The window stays **above** other windows
4. **Dragging the blob** moves the window
5. A **tray icon** appears with a `Quit` item that works

- [ ] **Step 8: Commit**

```bash
git add src/main.js src/preload.js src/renderer/
git commit -m "feat: add transparent always-on-top window with procedural blob"
```

---

### Task 6: Wire the pipeline end to end

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `createStateMachine` from `src/state-machine.js`; `createEventServer` from `src/server.js`; the `state-change` and `animation-ended` IPC channels from `src/preload.js`
- Produces: a running end-to-end pipeline — HTTP event → state machine → IPC → animation

- [ ] **Step 1: Rewrite `src/main.js` with the full wiring**

Replace the entire contents of `src/main.js`:

```js
'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog } = require('electron');

const { loadConfig } = require('./config.js');
const { createStateMachine } = require('./state-machine.js');
const { createEventServer } = require('./server.js');

const config = loadConfig();

/** How often to check whether the buddy should fall asleep. */
const TICK_INTERVAL_MS = 15 * 1000;

let win = null;
let tray = null;
let server = null;
let tickTimer = null;

const machine = createStateMachine({
  idleTimeoutMs: config.idleTimeoutMinutes * 60 * 1000,
  now: Date.now(),
});

/** Push a state change to the renderer, if there is one and it is alive. */
function pushStateChange(change) {
  if (!change) return;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state-change', change);
}

function createWindow() {
  win = new BrowserWindow({
    width: config.width,
    height: config.height,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: config.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');

  // Apply config.scale by injecting a rule rather than widening the IPC
  // surface. #stage carries no animation, so this cannot fight the keyframes
  // that drive .buddy.
  win.webContents.on('did-finish-load', () => {
    const scale = Number(config.scale) > 0 ? Number(config.scale) : 1;
    win.webContents.insertCSS(`#stage { transform: scale(${scale}); }`);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

function createTray(status) {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR4' +
      'AWMYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUAAAHkgABs1sVjwAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('Claude Buddy');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      {
        label: 'Test: done',
        click: () => pushStateChange(machine.handleEvent({ type: 'done' }, Date.now())),
      },
      {
        label: 'Test: needs input',
        click: () => pushStateChange(machine.handleEvent({ type: 'needsInput' }, Date.now())),
      },
      {
        label: 'Test: error',
        click: () => pushStateChange(machine.handleEvent({ type: 'error' }, Date.now())),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

async function startServer() {
  server = createEventServer({
    host: '127.0.0.1',
    port: config.port,
    token: config.token,
    onEvent: (event) => pushStateChange(machine.handleEvent(event, Date.now())),
  });

  try {
    const address = await server.listen();
    return `Listening on 127.0.0.1:${address.port}`;
  } catch (err) {
    // Deliberately do NOT fall back to another port: the hooks point at this
    // one, and silently moving would leave the buddy permanently deaf.
    const message =
      err && err.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use. Close whatever is using it, or change "port" in config.json.`
        : `Could not start the event server: ${err && err.message}`;
    dialog.showErrorBox('Claude Buddy', message);
    return 'Server failed to start';
  }
}

app.whenReady().then(async () => {
  createWindow();
  const status = await startServer();
  createTray(status);

  // The renderer reports when a one-shot animation has played out.
  ipcMain.on('animation-ended', () => pushStateChange(machine.completeOneShot()));

  tickTimer = setInterval(() => pushStateChange(machine.tick(Date.now())), TICK_INTERVAL_MS);
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', async () => {
  clearInterval(tickTimer);
  if (server) await server.close();
});
```

- [ ] **Step 2: Verify end to end with the app running**

Terminal 1 — run: `npm start`

Terminal 2 — run each of these and watch the blob:

```bash
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"thinking\"}"
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"done\"}"
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"needsInput\"}"
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"error\"}"
```

Expected, each of which you must actually confirm:
1. Each request returns `{"ok":true}`
2. `thinking` → the blob breathes noticeably faster
3. `done` → the blob **jumps and squashes**, then settles back to the calm idle breathe within about a second
4. `needsInput` → the blob **rocks side to side continuously** until another event arrives
5. `error` → the blob **shakes** and desaturates, then returns to idle
6. Every state entry produces a brief **size pulse**
7. A small state label appears at the bottom of the window on each change

- [ ] **Step 3: Verify `config.scale` is honoured**

Run: `node -e "require('fs').writeFileSync('config.json',JSON.stringify({scale:0.5},null,2))"`

Then run `npm start`.

Expected: the blob renders at half size. Then run `node -e "require('fs').unlinkSync('config.json')"` to restore defaults.

- [ ] **Step 4: Verify the sleep timeout**

Run: `node -e "const fs=require('fs');fs.writeFileSync('config.json',JSON.stringify({idleTimeoutMinutes:0.05},null,2))"`

Then run `npm start`, leave the buddy alone, and wait about 20 seconds.

Expected: the blob dims, its eyes become closed slits, and a floating `z` drifts up and fades, repeatedly.

Then run: `node -e "require('fs').unlinkSync('config.json')"` to restore defaults.

- [ ] **Step 5: Verify the port-conflict error**

Run in terminal 1: `node -e "require('http').createServer().listen(4747,'127.0.0.1',()=>console.log('squatting on 4747'))"`
Run in terminal 2: `npm start`

Expected: an error dialog reading `Port 4747 is already in use...`. The buddy still appears and animates via the tray's Test items — it degrades rather than failing to start. Stop the squatter with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat: wire HTTP events through the state machine to the renderer"
```

---

### Task 7: Hook installer

**Files:**
- Create: `tools/install-hooks.js`
- Test: `test/install-hooks.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `buildHookEntries(notifyPath: string) => Record<string, object[]>`
  - `mergeHooks(settings: object, entries: Record<string, object[]>) => object` — pure, non-destructive, idempotent, never mutates its input
  - `HOOK_EVENTS: Record<string, string>` mapping Claude Code hook event → buddy event type
  - CLI: `npm run install-hooks` prints the proposed change; `npm run install-hooks -- --write` applies it

- [ ] **Step 1: Write the failing test**

Create `test/install-hooks.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHookEntries,
  mergeHooks,
  HOOK_EVENTS,
} = require('../tools/install-hooks.js');

const NOTIFY = '/home/me/Claude Buddy/hooks/notify.js';

test('builds an entry for every mapped Claude Code hook event', () => {
  const entries = buildHookEntries(NOTIFY);
  assert.deepEqual(Object.keys(entries).sort(), Object.keys(HOOK_EVENTS).sort());
});

test('each command invokes the shim with its buddy event type', () => {
  const entries = buildHookEntries(NOTIFY);
  const command = entries.Stop[0].hooks[0].command;
  assert.ok(command.includes(NOTIFY), 'command should reference the shim path');
  assert.ok(command.endsWith(' done'), `expected the done event, got: ${command}`);
  assert.equal(entries.Stop[0].hooks[0].type, 'command');
});

test('quotes the shim path so spaces survive', () => {
  const command = buildHookEntries(NOTIFY).Stop[0].hooks[0].command;
  assert.ok(command.includes(`"${NOTIFY}"`), `path must be quoted: ${command}`);
});

test('adds hooks to empty settings', () => {
  const merged = mergeHooks({}, buildHookEntries(NOTIFY));
  assert.equal(merged.hooks.Stop.length, 1);
  assert.equal(merged.hooks.UserPromptSubmit.length, 1);
});

test('preserves unrelated top-level settings', () => {
  const settings = { model: 'opus', permissions: { allow: ['Bash'] } };
  const merged = mergeHooks(settings, buildHookEntries(NOTIFY));
  assert.equal(merged.model, 'opus');
  assert.deepEqual(merged.permissions, { allow: ['Bash'] });
});

test('preserves an existing unrelated hook on the same event', () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo something-else' }] }],
    },
  };
  const merged = mergeHooks(settings, buildHookEntries(NOTIFY));
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'echo something-else');
});

test('is idempotent', () => {
  const entries = buildHookEntries(NOTIFY);
  const once = mergeHooks({}, entries);
  const twice = mergeHooks(once, entries);
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.Stop.length, 1);
});

test('replaces a stale buddy hook rather than duplicating it', () => {
  const settings = mergeHooks({}, buildHookEntries('/old/path/notify.js'));
  const merged = mergeHooks(settings, buildHookEntries(NOTIFY));
  assert.equal(merged.hooks.Stop.length, 1, 'old buddy entry should be replaced');
  assert.ok(merged.hooks.Stop[0].hooks[0].command.includes(NOTIFY));
});

test('does not mutate the input settings object', () => {
  const settings = { hooks: { Stop: [] } };
  const snapshot = JSON.stringify(settings);
  mergeHooks(settings, buildHookEntries(NOTIFY));
  assert.equal(JSON.stringify(settings), snapshot);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/install-hooks.test.js`
Expected: FAIL — `Cannot find module '../tools/install-hooks.js'`

- [ ] **Step 3: Write the implementation**

Create `tools/install-hooks.js`:

```js
#!/usr/bin/env node
'use strict';

/**
 * Merge Claude Buddy's hook entries into ~/.claude/settings.json.
 *
 *   npm run install-hooks            print the proposed settings, change nothing
 *   npm run install-hooks -- --write apply the change (backs up the original)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Claude Code hook event -> buddy event type. */
const HOOK_EVENTS = Object.freeze({
  UserPromptSubmit: 'thinking',
  Stop: 'done',
  SubagentStop: 'subagent',
  Notification: 'needsInput',
});

/** Marker used to recognise our own entries when re-running. */
const SHIM_MARKER = 'hooks/notify.js';

function buildHookEntries(notifyPath) {
  const entries = {};
  for (const [hookEvent, buddyEvent] of Object.entries(HOOK_EVENTS)) {
    entries[hookEvent] = [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${notifyPath}" ${buddyEvent}`,
          },
        ],
      },
    ];
  }
  return entries;
}

/** True if this matcher group is one of ours (from any install path). */
function isBuddyEntry(group) {
  return (
    group &&
    Array.isArray(group.hooks) &&
    group.hooks.some(
      (h) => typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(SHIM_MARKER),
    )
  );
}

/**
 * Merge entries into settings without mutating the input.
 * Existing buddy entries are replaced; unrelated hooks are preserved.
 */
function mergeHooks(settings, entries) {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  if (next.hooks === null || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
    next.hooks = {};
  }

  for (const [hookEvent, groups] of Object.entries(entries)) {
    const existing = Array.isArray(next.hooks[hookEvent]) ? next.hooks[hookEvent] : [];
    next.hooks[hookEvent] = [...existing.filter((g) => !isBuddyEntry(g)), ...groups];
  }

  return next;
}

function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function main() {
  const write = process.argv.includes('--write');
  const notifyPath = path.join(__dirname, '..', 'hooks', 'notify.js');
  const file = settingsPath();

  const current = readSettings(file);
  const merged = mergeHooks(current, buildHookEntries(notifyPath));
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  if (!write) {
    console.log(`Would update: ${file}\n`);
    console.log(serialized);
    console.log('Re-run with --write to apply:\n  npm run install-hooks -- --write');
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backup = `${file}.buddy-backup`;
    fs.copyFileSync(file, backup);
    console.log(`Backed up existing settings to ${backup}`);
  }
  fs.writeFileSync(file, serialized, 'utf8');
  console.log(`Installed Claude Buddy hooks into ${file}`);
  console.log('Restart Claude Code for the hooks to take effect.');
}

if (require.main === module) main();

module.exports = { buildHookEntries, mergeHooks, isBuddyEntry, HOOK_EVENTS, SHIM_MARKER };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/install-hooks.test.js`
Expected: PASS — 9 tests passing

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — 58 tests passing (9 config + 18 state machine + 15 server + 7 notify + 9 install-hooks)

- [ ] **Step 6: Preview the hook installation**

Run: `npm run install-hooks`
Expected: prints the proposed `~/.claude/settings.json` containing four hook events, each with a `node "…/hooks/notify.js" <type>` command. **Nothing is written.**

- [ ] **Step 7: Apply the hooks and verify the real pipeline**

Run: `npm run install-hooks -- --write`
Expected: `Installed Claude Buddy hooks into …`, plus a `.buddy-backup` line if you already had settings.

Then:
1. Run `npm start` in one terminal
2. Restart Claude Code
3. Send Claude Code any prompt

Expected: the blob speeds up its breathing while Claude works (`thinking`), and jumps and squashes when it finishes (`done`).

- [ ] **Step 8: Commit**

```bash
git add tools/install-hooks.js test/install-hooks.test.js
git commit -m "feat: add idempotent hook installer for ~/.claude/settings.json"
```

---

## Phase 1 Definition of Done

- [ ] `npm test` passes — 58 tests
- [ ] `npm start` shows a transparent, always-on-top, draggable blob
- [ ] Posting each of the six event types visibly changes the animation
- [ ] One-shot states (`done`, `subagent`, `error`) settle back automatically
- [ ] The buddy falls asleep after the configured idle timeout and wakes on any event
- [ ] A port conflict shows a clear error instead of silently binding elsewhere
- [ ] `hooks/notify.js` exits 0 with nothing listening, in under a second
- [ ] Real Claude Code hooks drive the buddy end to end
- [ ] `package.json` lists **electron and nothing else**

---

## Deferred to Phase 2

Explicitly out of scope here, in the spec's build order:

- **Step 6** — procedural animations for all remaining states, refined
- **Step 7** — the full config layer, including the optional `rules.js` escape hatch
- **Step 8** — per-state sound playback, volume and mute
- **Step 9** — the theme system: `theme.json` loader, sprite renderer (strip + grid), ranges, variants, fallback chain
- **Step 10** — `theme.schema.json`, `validate-theme`, `import-sprite`, the `_template` theme, `docs/THEMES.md`
- The `working` state's trigger (spec §13 open question)
- Click interactions and speech bubbles (spec §13)
