# Claude Buddy — Phase 2 (Themes & Sound) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the buddy wear user-supplied sprite-sheet themes and play per-state sounds, driven entirely by declarative config — with Mochi the beagle as the first real theme.

**Architecture:** The renderer stays sandboxed and never touches the filesystem. The main process reads `theme.json` and its sheets, converts each sheet to a `data:` URI, and pushes the whole resolved theme plus per-state sound data over **one** new IPC channel. A sprite renderer implements the same `mount/setState/destroy` contract the procedural blob already implements, and an orchestrator picks between them **per state**, so a theme covering only some states still works.

**Tech Stack:** Electron 43, Node 24, `node:http`, `node:test`, plain HTML/CSS/JS. No new dependencies.

**Scope:** Spec build-order steps 7 (declarative half), 8, 9 and the `validate-theme` half of 10.

**Explicitly deferred to Phase 3:**
- `rules.js` — the imperative escape hatch. It executes user code in the **main process**, so it deserves its own focused security pass rather than riding along with rendering work.
- `import-sprite` — normalizing messy source art requires writing a PNG **encoder** from scratch (no packages allowed). The one real asset we have needs no normalization. Revisit when a theme actually arrives with a baked-in checkerboard.

**Spec:** [`docs/superpowers/specs/2026-07-23-claude-buddy-design.md`](../specs/2026-07-23-claude-buddy-design.md) §6, §7
**Phase 1 plan:** [`2026-07-23-claude-buddy-phase-1.md`](2026-07-23-claude-buddy-phase-1.md)

## Global Constraints

Every task's requirements implicitly include this section. These carry over from Phase 1 unchanged unless noted.

- **Electron is the ONLY entry in `package.json` dependencies or devDependencies.** No image library, no audio library, no packages. Use the Node standard library.
- **Tests run via `npm test` → `node --test test/*.js`.** Never Jest, Mocha, Vitest, or Chai.
- **Node `>=20`.** Development machine is Node 24.16.0.
- **The renderer never reads the filesystem.** It is `sandbox: true` and stays that way. All asset bytes arrive over IPC as `data:` URIs produced by the main process.
- **Electron hardening is mandatory and must not be weakened:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **Zero outbound network connections.** `data:` URIs are not network fetches; no remote images, fonts, or audio, ever.
- **The server still binds `127.0.0.1` only**, still refuses requests carrying an `Origin` header, and still requires a JSON content type.
- **Path traversal is a real threat here.** Theme names and sound paths come from a user-editable config file and are used to build filesystem paths in the main process. Every such value must be validated to contain no `..` and no absolute-path or separator escape before it reaches `fs`.
- **State keys are lowercase-camel and case-sensitive:** `idle`, `thinking`, `working`, `done`, `needsInput`, `subagent`, `error`, `sleeping`.
- **Theme asset filenames are case-sensitive** and must match `theme.json` exactly. Windows forgives this; Linux and case-sensitive macOS volumes do not.
- `'use strict';` and CommonJS (`require`/`module.exports`) throughout.
- **`themes/` is gitignored** except `themes/_template/`. Never commit art the project does not own.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.js` | **Modify.** Add `theme`, `sound`, `states` with nested validation |
| `src/png.js` | **New.** Read a PNG header: dimensions and whether it has alpha |
| `src/theme.js` | **New.** Parse + validate a `theme.json` against sheet dimensions. Pure |
| `src/theme-loader.js` | **New.** The filesystem half: read sheets, check filename case |
| `src/assets.js` | **New.** Resolve a theme and its sounds from disk into an IPC-safe payload |
| `src/renderer/frame-math.js` | **New.** Pure frame arithmetic, loadable in both Node and the renderer |
| `src/main.js` | **Modify.** Load assets, push them over the new channel |
| `src/preload.js` | **Modify.** Add `onAssets` — one new channel, nothing more |
| `src/renderer/index.html` | **Modify.** CSP gains `media-src data:` |
| `src/renderer/sprite.js` | **New.** Sprite-sheet renderer implementing the Renderer contract |
| `src/renderer/procedural.js` | **Modify.** Add `setActive` to satisfy the extended contract |
| `src/renderer/sound.js` | **New.** Per-state audio playback with volume and mute |
| `src/renderer/renderer.js` | **Modify.** Orchestrate: pick a renderer per state, play sounds |
| `tools/validate-theme.js` | **New.** CLI validator with actionable errors |
| `themes/_template/theme.json` | **New.** Commented reference manifest |
| `themes/_template/README.md` | **New.** How to author a theme |
| `docs/THEMES.md` | **New.** Authoring walkthrough |

**Dependency direction:** `png.js` and `theme.js` are pure — no filesystem, no Electron — and that is where the test coverage lives. `theme-loader.js` and `assets.js` own all filesystem work. **`tools/` may require from `src/`, never the reverse**, so the CLI is a thin shell over `src/theme-loader.js`. The renderer folder imports nothing from `src/` except `renderer/frame-math.js`, which is written to load in both Node and a sandboxed page.

### The extended Renderer contract

Phase 1 defined `mount(rootEl)`, `setState(change)`, `destroy()`. Phase 2 adds one method, because two renderers now coexist and one must be hidden:

```js
setActive(isActive: boolean): void   // show/hide; an inactive renderer must stop its timers
supports(state: string): boolean     // sprite only — does this theme cover that state?
```

`supports` is optional; the orchestrator treats a renderer without it as supporting everything.

---

### Task 1: Extend the config with theme, sound and per-state settings

**Files:**
- Modify: `src/config.js`
- Modify: `config.example.json`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: `STATES` from `src/state-machine.js`
- Produces: `loadConfig()` gains three keys —
  - `theme: string` (default `'procedural'`) — a reserved name or a folder under `themes/`
  - `sound: { enabled: boolean, volume: number }` (default `{ enabled: true, volume: 0.5 }`)
  - `states: Record<string, { sound?: string|null, scalePulse?: number }>` (default `{}`)
- Also exports `isSafeRelativePath(value: string): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.js`:

```js
test('defaults include the new theme, sound and states keys', () => {
  const cfg = loadConfig(path.join(os.tmpdir(), 'buddy-absent-77123.json'));
  assert.equal(cfg.theme, 'procedural');
  assert.deepEqual(cfg.sound, { enabled: true, volume: 0.5 });
  assert.deepEqual(cfg.states, {});
});

test('accepts a valid theme name', () => {
  const file = tempConfig(JSON.stringify({ theme: 'mochi' }));
  assert.equal(loadConfig(file).theme, 'mochi');
});

test('rejects a theme name that could escape the themes directory', () => {
  for (const evil of ['../secrets', 'a/b', 'a\\b', '..', '/etc/passwd', 'C:\\Windows', '']) {
    const file = tempConfig(JSON.stringify({ theme: evil }));
    assert.equal(loadConfig(file).theme, 'procedural', `should reject ${JSON.stringify(evil)}`);
  }
});

test('merges the sound block key by key', () => {
  const file = tempConfig(JSON.stringify({ sound: { volume: 0.25 } }));
  assert.deepEqual(loadConfig(file).sound, { enabled: true, volume: 0.25 });
});

test('rejects a wrong-typed or out-of-range sound value', () => {
  const file = tempConfig(JSON.stringify({ sound: { enabled: 'yes', volume: 9 } }));
  assert.deepEqual(loadConfig(file).sound, { enabled: true, volume: 0.5 });
});

test('rejects a non-object sound block', () => {
  const file = tempConfig(JSON.stringify({ sound: 'loud' }));
  assert.deepEqual(loadConfig(file).sound, { enabled: true, volume: 0.5 });
});

test('keeps per-state settings for real states only', () => {
  const file = tempConfig(
    JSON.stringify({
      states: {
        done: { sound: 'sounds/tada.mp3', scalePulse: 1.4 },
        notAState: { sound: 'sounds/x.mp3' },
      },
    }),
  );
  const cfg = loadConfig(file);
  assert.deepEqual(cfg.states.done, { sound: 'sounds/tada.mp3', scalePulse: 1.4 });
  assert.equal(Object.hasOwn(cfg.states, 'notAState'), false);
});

test('rejects a sound path that could escape the project', () => {
  const file = tempConfig(
    JSON.stringify({
      states: {
        done: { sound: '../../../../etc/passwd' },
        error: { sound: '/etc/shadow' },
        thinking: { sound: 'sounds/ok.mp3' },
      },
    }),
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.states.done?.sound, undefined);
  assert.equal(cfg.states.error?.sound, undefined);
  assert.equal(cfg.states.thinking.sound, 'sounds/ok.mp3');
});

test('rejects an out-of-range scalePulse', () => {
  const file = tempConfig(JSON.stringify({ states: { done: { scalePulse: 99 } } }));
  assert.equal(loadConfig(file).states.done?.scalePulse, undefined);
});

test('isSafeRelativePath rejects traversal and absolute paths', () => {
  assert.equal(isSafeRelativePath('sounds/tada.mp3'), true);
  assert.equal(isSafeRelativePath('a/b/c.wav'), true);
  assert.equal(isSafeRelativePath('../x'), false);
  assert.equal(isSafeRelativePath('a/../../b'), false);
  assert.equal(isSafeRelativePath('/abs'), false);
  assert.equal(isSafeRelativePath('C:\\abs'), false);
  assert.equal(isSafeRelativePath('a\\b'), false);
  assert.equal(isSafeRelativePath(''), false);
});
```

Update that file's require line to pull in the new export:

```js
const { loadConfig, DEFAULTS, isSafeRelativePath } = require('../src/config.js');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/config.test.js`
Expected: FAIL — `isSafeRelativePath is not a function`, plus failures on the new keys

- [ ] **Step 3: Write the implementation**

Replace the contents of `src/config.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { STATES } = require('./state-machine.js');

/** Reserved theme name selecting the built-in procedural blob. */
const PROCEDURAL_THEME = 'procedural';

/** Default configuration. Frozen so callers cannot corrupt it. */
const DEFAULTS = Object.freeze({
  port: 4747,
  token: null,
  idleTimeoutMinutes: 10,
  scale: 1.0,
  alwaysOnTop: true,
  width: 320,
  height: 320,
  theme: PROCEDURAL_THEME,
  sound: Object.freeze({ enabled: true, volume: 0.5 }),
  states: Object.freeze({}),
});

/**
 * True for a relative path that cannot escape its base directory.
 *
 * These values come from a user-editable JSON file and are joined onto real
 * filesystem paths in the main process, so `../../../../etc/passwd` must never
 * survive. Backslashes are rejected outright rather than normalized: a theme
 * that works on Windows and breaks on Linux is worse than one that is refused
 * consistently.
 */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').includes('..');
}

/** A theme name is a single directory component, never a path. */
function isSafeThemeName(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value === PROCEDURAL_THEME) return true;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value === '.' || value === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

const SOUND_VALIDATORS = Object.freeze({
  enabled: (v) => typeof v === 'boolean',
  volume: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
});

const STATE_ENTRY_VALIDATORS = Object.freeze({
  sound: (v) => v === null || isSafeRelativePath(v),
  scalePulse: (v) => Number.isFinite(v) && v >= 0.1 && v <= 4,
});

/** Merge a nested object key by key, dropping unknown and wrong-typed values. */
function mergeNested(defaults, parsed, validators) {
  const out = { ...defaults };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const key of Object.keys(validators)) {
    if (!Object.hasOwn(parsed, key)) continue;
    if (validators[key](parsed[key])) out[key] = parsed[key];
  }
  return out;
}

/** Per-state settings, keyed by real state names only. */
function parseStates(parsed) {
  const out = {};
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

  for (const state of STATES) {
    if (!Object.hasOwn(parsed, state)) continue;
    const entry = parsed[state];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const clean = {};
    for (const key of Object.keys(STATE_ENTRY_VALIDATORS)) {
      if (!Object.hasOwn(entry, key)) continue;
      if (STATE_ENTRY_VALIDATORS[key](entry[key])) clean[key] = entry[key];
    }
    out[state] = clean;
  }
  return out;
}

const VALIDATORS = Object.freeze({
  port: (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
  token: (v) => v === null || (typeof v === 'string' && v.length > 0),
  idleTimeoutMinutes: (v) => Number.isFinite(v) && v > 0,
  scale: (v) => Number.isFinite(v) && v > 0 && v <= 8,
  alwaysOnTop: (v) => typeof v === 'boolean',
  width: (v) => Number.isInteger(v) && v > 0 && v <= 4096,
  height: (v) => Number.isInteger(v) && v > 0 && v <= 4096,
  theme: isSafeThemeName,
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
    return { ...DEFAULTS, sound: { ...DEFAULTS.sound }, states: {} };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULTS, sound: { ...DEFAULTS.sound }, states: {} };
  }

  const config = { ...DEFAULTS };
  for (const key of Object.keys(VALIDATORS)) {
    if (!Object.hasOwn(parsed, key)) continue;
    if (VALIDATORS[key](parsed[key])) config[key] = parsed[key];
  }

  config.sound = mergeNested(DEFAULTS.sound, parsed.sound, SOUND_VALIDATORS);
  config.states = parseStates(parsed.states);

  return config;
}

module.exports = {
  loadConfig,
  DEFAULTS,
  CONFIG_PATH,
  PROCEDURAL_THEME,
  isSafeRelativePath,
  isSafeThemeName,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/config.test.js`
Expected: PASS

- [ ] **Step 5: Update `config.example.json`**

```json
{
  "port": 4747,
  "token": null,
  "idleTimeoutMinutes": 10,
  "scale": 1.0,
  "alwaysOnTop": true,
  "width": 320,
  "height": 320,
  "theme": "procedural",
  "sound": {
    "enabled": true,
    "volume": 0.5
  },
  "states": {
    "done": { "scalePulse": 1.4 },
    "needsInput": { "scalePulse": 1.2 }
  }
}
```

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`
Expected: PASS, no pre-existing test broken

```bash
git add src/config.js config.example.json test/config.test.js
git commit -m "feat: add theme, sound and per-state config with path-traversal guards"
```

---

### Task 2: PNG header reader

**Files:**
- Create: `src/png.js`
- Test: `test/png.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `readPngHeader(buffer: Buffer) => { width, height, bitDepth, colorType, hasAlpha } | null` — returns `null` for anything that is not a PNG
  - `PNG_SIGNATURE: Buffer`

**Why this exists:** `validate-theme` must confirm a sheet's real dimensions match its declared grid and that it carries an alpha channel. Decoding pixels would need a full inflate + unfilter pipeline; reading the header needs 26 bytes.

**PNG layout:** an 8-byte signature, then the IHDR chunk — 4-byte length, the ASCII tag `IHDR`, then width (4, big-endian), height (4), bit depth (1), colour type (1). Colour type 4 is grey+alpha and 6 is RGBA; type 3 (palette) carries transparency only if a `tRNS` chunk is present, so we scan for one.

- [ ] **Step 1: Write the failing test**

Create `test/png.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readPngHeader, PNG_SIGNATURE } = require('../src/png.js');

/** Build a minimal PNG header for a given geometry and colour type. */
function fakePng(width, height, colorType, { withTrns = false } = {}) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = colorType;

  const chunks = [PNG_SIGNATURE];

  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  chunks.push(ihdrLen, Buffer.from('IHDR'), ihdrData, Buffer.alloc(4));

  if (withTrns) {
    const trnsLen = Buffer.alloc(4);
    trnsLen.writeUInt32BE(2, 0);
    chunks.push(trnsLen, Buffer.from('tRNS'), Buffer.alloc(2), Buffer.alloc(4));
  }

  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(0, 0);
  chunks.push(idatLen, Buffer.from('IDAT'), Buffer.alloc(4));

  return Buffer.concat(chunks);
}

test('reads dimensions from a PNG header', () => {
  const header = readPngHeader(fakePng(1920, 1080, 6));
  assert.equal(header.width, 1920);
  assert.equal(header.height, 1080);
  assert.equal(header.bitDepth, 8);
});

test('reports alpha for RGBA and grey+alpha', () => {
  assert.equal(readPngHeader(fakePng(10, 10, 6)).hasAlpha, true);
  assert.equal(readPngHeader(fakePng(10, 10, 4)).hasAlpha, true);
});

test('reports no alpha for RGB and greyscale', () => {
  assert.equal(readPngHeader(fakePng(10, 10, 2)).hasAlpha, false);
  assert.equal(readPngHeader(fakePng(10, 10, 0)).hasAlpha, false);
});

test('reports alpha for a palette PNG only when tRNS is present', () => {
  assert.equal(readPngHeader(fakePng(10, 10, 3)).hasAlpha, false);
  assert.equal(readPngHeader(fakePng(10, 10, 3, { withTrns: true })).hasAlpha, true);
});

test('returns null for a non-PNG buffer', () => {
  assert.equal(readPngHeader(Buffer.from('this is not a png at all')), null);
  assert.equal(readPngHeader(Buffer.alloc(4)), null);
  assert.equal(readPngHeader(Buffer.alloc(0)), null);
});

test('returns null for a truncated PNG', () => {
  assert.equal(readPngHeader(fakePng(10, 10, 6).subarray(0, 20)), null);
});

test('reads the real Mochi sheet', (t) => {
  const sheet = path.join(__dirname, '..', 'assets', 'sprites', 'mochi', 'Sleeping.png');
  if (!fs.existsSync(sheet)) return t.skip('Mochi master sheet not present');

  const header = readPngHeader(fs.readFileSync(sheet));
  assert.equal(header.width, 1920);
  assert.equal(header.height, 1080);
  assert.equal(header.hasAlpha, true, 'the master sheet must have a real alpha channel');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/png.test.js`
Expected: FAIL — `Cannot find module '../src/png.js'`

- [ ] **Step 3: Write the implementation**

Create `src/png.js`:

```js
'use strict';

/**
 * Minimal PNG header reader.
 *
 * Theme validation needs a sheet's real dimensions and whether it carries
 * transparency. Both live in the first 26 bytes, so there is no need to inflate
 * and unfilter the pixel data — which is the only part that would require a
 * real decoder.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Colour types that carry an alpha channel intrinsically. */
const COLOR_TYPE_GREY_ALPHA = 4;
const COLOR_TYPE_RGBA = 6;
const COLOR_TYPE_PALETTE = 3;

/** Walk the chunk list looking for a tag, without decoding any of it. */
function hasChunk(buffer, tag) {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === tag) return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    // length + type + data + crc
    offset += 12 + length;
  }
  return false;
}

/**
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,hasAlpha:boolean}|null}
 */
function readPngHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  // signature (8) + length (4) + 'IHDR' (4) + 13 bytes of header data
  if (buffer.length < 8 + 4 + 4 + 13) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];

  // The PNG spec requires both to be non-zero. Rejecting them here matters
  // because a 0x0 sheet would sail through grid validation downstream: the
  // derived frame size is 0/cols = 0, and the geometry check then compares
  // 0 === 0 and passes.
  if (width === 0 || height === 0) return null;

  const hasAlpha =
    colorType === COLOR_TYPE_RGBA ||
    colorType === COLOR_TYPE_GREY_ALPHA ||
    (colorType === COLOR_TYPE_PALETTE && hasChunk(buffer, 'tRNS'));

  return { width, height, bitDepth, colorType, hasAlpha };
}

module.exports = { readPngHeader, PNG_SIGNATURE };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/png.test.js`
Expected: PASS — 7 tests, including the real Mochi sheet reading 1920×1080 with alpha

- [ ] **Step 5: Commit**

```bash
git add src/png.js test/png.test.js
git commit -m "feat: add minimal PNG header reader for theme validation"
```

---

### Task 3: Theme manifest parsing and validation

**Files:**
- Create: `src/theme.js`
- Test: `test/theme.test.js`

**Interfaces:**
- Consumes: `STATES` from `src/state-machine.js`; `isSafeRelativePath` from `src/config.js`
- Produces:
  - `validateTheme(manifest, sheetInfo) => { errors: string[], warnings: string[], theme: object|null }`
  - `resolveStateGeometry(entry, sheet) => { frame, cols, rows, totalFrames }`
  - `sheetInfo` is `Record<filename, { width, height, hasAlpha } | null>` — `null` meaning the file is missing or unreadable

**Contract being enforced** (spec §7):
- Frames are indexed **0-based in reading order** — left to right, then top to bottom.
- **Strip:** `frames: N`; sheet width must equal `N × frame.width`.
- **Grid:** `grid: { cols, rows }`; sheet must be `cols × frame.width` by `rows × frame.height`. `frame` may be omitted and is then derived.
- `range: [from, to]` plays a sub-range. `variants: [[from,to], ...]` gives interchangeable animations, chosen by `variantPick` (`"random"` default, or `"sequential"`).
- **`idle` is the only state whose absence is worth warning about**; every other missing state falls back.
- Unknown state keys are an error, not a silent no-op — a typo like `needsinput` must be caught here rather than silently never firing.

- [ ] **Step 1: Write the failing test**

Create `test/theme.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateTheme, resolveStateGeometry } = require('../src/theme.js');

const SHEET = { width: 1920, height: 1080, hasAlpha: true };

const gridManifest = (overrides = {}) => ({
  name: 'Mochi',
  states: {
    sleeping: {
      sheet: 'sleeping.png',
      grid: { cols: 8, rows: 4 },
      fps: 4,
      loop: true,
      ...overrides,
    },
  },
});

test('accepts a valid grid theme and derives the frame size', () => {
  const { errors, theme } = validateTheme(gridManifest(), { 'sleeping.png': SHEET });
  assert.deepEqual(errors, []);
  assert.deepEqual(theme.states.sleeping.frame, { width: 240, height: 270 });
  assert.equal(theme.states.sleeping.totalFrames, 32);
});

test('accepts a valid strip theme', () => {
  const manifest = {
    name: 'Strip',
    frame: { width: 64, height: 64 },
    states: { idle: { sheet: 'idle.png', frames: 4, fps: 6, loop: true } },
  };
  const { errors, theme } = validateTheme(manifest, {
    'idle.png': { width: 256, height: 64, hasAlpha: true },
  });
  assert.deepEqual(errors, []);
  assert.equal(theme.states.idle.totalFrames, 4);
  assert.equal(theme.states.idle.cols, 4);
  assert.equal(theme.states.idle.rows, 1);
});

test('rejects a strip whose width does not match frames x frame width', () => {
  const manifest = {
    name: 'Bad',
    frame: { width: 64, height: 64 },
    states: { idle: { sheet: 'idle.png', frames: 5, fps: 6 } },
  };
  const { errors } = validateTheme(manifest, {
    'idle.png': { width: 256, height: 64, hasAlpha: true },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /idle/);
  assert.match(errors[0], /320/, 'the message should name the width it expected');
});

test('rejects a grid whose dimensions do not divide evenly', () => {
  const { errors } = validateTheme(gridManifest({ grid: { cols: 7, rows: 4 } }), {
    'sleeping.png': SHEET,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sleeping/);
});

test('reports a missing sheet file by name', () => {
  const { errors } = validateTheme(gridManifest(), { 'sleeping.png': null });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sleeping\.png/);
});

test('rejects a sheet with no alpha channel', () => {
  const { errors } = validateTheme(gridManifest(), {
    'sleeping.png': { ...SHEET, hasAlpha: false },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /alpha/i);
});

test('rejects an unknown state key rather than ignoring it', () => {
  const manifest = {
    name: 'Typo',
    states: { needsinput: { sheet: 'a.png', grid: { cols: 1, rows: 1 }, fps: 1 } },
  };
  const { errors } = validateTheme(manifest, {
    'a.png': { width: 10, height: 10, hasAlpha: true },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /needsinput/);
  assert.match(errors[0], /needsInput/, 'should suggest the correct casing');
});

test('rejects a sheet path that could escape the theme directory', () => {
  const manifest = {
    name: 'Evil',
    states: { idle: { sheet: '../../../../etc/passwd', frames: 1, fps: 1 } },
  };
  const { errors } = validateTheme(manifest, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /path/i);
});

test('rejects a range outside the frame count', () => {
  const { errors } = validateTheme(gridManifest({ range: [0, 99] }), { 'sleeping.png': SHEET });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /range/i);
});

test('rejects an inverted range', () => {
  const { errors } = validateTheme(gridManifest({ range: [10, 2] }), { 'sleeping.png': SHEET });
  assert.equal(errors.length, 1);
});

test('accepts variants and normalizes variantPick', () => {
  const { errors, theme } = validateTheme(
    gridManifest({ variants: [[0, 7], [8, 15], [16, 23], [24, 31]] }),
    { 'sleeping.png': SHEET },
  );
  assert.deepEqual(errors, []);
  assert.equal(theme.states.sleeping.variants.length, 4);
  assert.equal(theme.states.sleeping.variantPick, 'random');
});

test('rejects a variant outside the frame count', () => {
  const { errors } = validateTheme(gridManifest({ variants: [[0, 7], [8, 99]] }), {
    'sleeping.png': SHEET,
  });
  assert.equal(errors.length, 1);
});

test('warns but does not error when idle is absent', () => {
  const { errors, warnings } = validateTheme(gridManifest(), { 'sleeping.png': SHEET });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /idle/);
});

test('rejects a manifest with no states at all', () => {
  const { errors } = validateTheme({ name: 'Empty', states: {} }, {});
  assert.equal(errors.length, 1);
});

test('rejects a malformed manifest without throwing', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const { errors, theme } = validateTheme(bad, {});
    assert.ok(errors.length > 0);
    assert.equal(theme, null);
  }
});

test('defaults fps and loop when omitted', () => {
  const manifest = {
    name: 'Defaults',
    states: { idle: { sheet: 'idle.png', grid: { cols: 2, rows: 1 } } },
  };
  const { errors, theme } = validateTheme(manifest, {
    'idle.png': { width: 128, height: 64, hasAlpha: true },
  });
  assert.deepEqual(errors, []);
  assert.equal(theme.states.idle.fps, 8);
  assert.equal(theme.states.idle.loop, true);
});

test('carries next through for one-shot states', () => {
  const manifest = {
    name: 'OneShot',
    states: {
      done: { sheet: 'done.png', grid: { cols: 2, rows: 1 }, loop: false, next: 'idle' },
    },
  };
  const { theme } = validateTheme(manifest, {
    'done.png': { width: 128, height: 64, hasAlpha: true },
  });
  assert.equal(theme.states.done.loop, false);
  assert.equal(theme.states.done.next, 'idle');
});

test('defaults offset to zero and accepts an explicit one', () => {
  const plain = validateTheme(gridManifest(), { 'sleeping.png': SHEET });
  assert.deepEqual(plain.theme.states.sleeping.offset, { x: 0, y: 0 });

  const nudged = validateTheme(gridManifest({ offset: { y: -12 } }), { 'sleeping.png': SHEET });
  assert.deepEqual(nudged.errors, []);
  assert.deepEqual(nudged.theme.states.sleeping.offset, { x: 0, y: -12 });
});

test('rejects a non-integer or malformed offset', () => {
  for (const bad of [{ y: 1.5 }, { x: 'left' }, 'down', [0, 1], null]) {
    const { errors } = validateTheme(gridManifest({ offset: bad }), { 'sleeping.png': SHEET });
    assert.equal(errors.length, 1, `should reject ${JSON.stringify(bad)}`);
  }
});

test('resolveStateGeometry maps a frame index to a grid position', () => {
  const geom = resolveStateGeometry({ grid: { cols: 8, rows: 4 } }, SHEET);
  assert.deepEqual(geom.frame, { width: 240, height: 270 });
  assert.equal(geom.cols, 8);
  assert.equal(geom.totalFrames, 32);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/theme.test.js`
Expected: FAIL — `Cannot find module '../src/theme.js'`

- [ ] **Step 3: Write the implementation**

Create `src/theme.js`:

```js
'use strict';

/**
 * Theme manifest parsing and validation.
 *
 * Pure: it never touches the filesystem. The caller supplies `sheetInfo`,
 * a map of filename to `{width, height, hasAlpha}` (or `null` when the file is
 * missing), so every rule here is testable without any real images.
 */

const { STATES } = require('./state-machine.js');
const { isSafeRelativePath } = require('./config.js');

const DEFAULT_FPS = 8;

/** Case-insensitive lookup so we can suggest the right spelling on a typo. */
const STATE_BY_LOWER = new Map(STATES.map((s) => [s.toLowerCase(), s]));

/**
 * Frame geometry for one state.
 *
 * Grid sheets may omit `frame`; it is derived by dividing the sheet. Strips
 * require a frame width, because a strip's height alone cannot tell us how many
 * frames it holds.
 */
function resolveStateGeometry(entry, sheet, fallbackFrame) {
  const declared = entry.frame ?? fallbackFrame ?? null;

  if (entry.grid) {
    const cols = entry.grid.cols;
    const rows = entry.grid.rows;
    return {
      cols,
      rows,
      frame: {
        width: Math.floor(sheet.width / cols),
        height: Math.floor(sheet.height / rows),
      },
      declaredFrame: declared,
      totalFrames: cols * rows,
    };
  }

  const frames = entry.frames;
  return {
    cols: frames,
    rows: 1,
    frame: declared ?? { width: Math.floor(sheet.width / (frames || 1)), height: sheet.height },
    declaredFrame: declared,
    totalFrames: frames,
  };
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function isRange(v, total) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isInteger(v[0]) &&
    Number.isInteger(v[1]) &&
    v[0] >= 0 &&
    v[1] >= v[0] &&
    v[1] < total
  );
}

/**
 * @param {object} manifest parsed theme.json
 * @param {Record<string, {width:number,height:number,hasAlpha:boolean}|null>} sheetInfo
 * @returns {{errors: string[], warnings: string[], theme: object|null}}
 */
function validateTheme(manifest, sheetInfo) {
  const errors = [];
  const warnings = [];

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['theme.json must contain a JSON object'], warnings, theme: null };
  }

  const states = manifest.states;
  if (states === null || typeof states !== 'object' || Array.isArray(states)) {
    return { errors: ['theme.json must have a "states" object'], warnings, theme: null };
  }

  const stateKeys = Object.keys(states);
  if (stateKeys.length === 0) {
    return { errors: ['theme.json defines no states'], warnings, theme: null };
  }

  const fallbackFrame = manifest.frame ?? null;
  const resolved = {};

  for (const key of stateKeys) {
    if (!STATES.includes(key)) {
      const suggestion = STATE_BY_LOWER.get(key.toLowerCase());
      errors.push(
        suggestion
          ? `unknown state "${key}" — did you mean "${suggestion}"? State keys are case-sensitive.`
          : `unknown state "${key}" — valid states are: ${STATES.join(', ')}`,
      );
      continue;
    }

    const entry = states[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`state "${key}" must be an object`);
      continue;
    }

    if (typeof entry.sheet !== 'string' || !isSafeRelativePath(entry.sheet)) {
      errors.push(`state "${key}" has a missing or unsafe sheet path`);
      continue;
    }

    const sheet = Object.hasOwn(sheetInfo, entry.sheet) ? sheetInfo[entry.sheet] : null;
    if (sheet === null || sheet === undefined) {
      errors.push(`state "${key}" references "${entry.sheet}", which is missing or unreadable`);
      continue;
    }

    if (!sheet.hasAlpha) {
      errors.push(
        `"${entry.sheet}" has no alpha channel — export PNG-32 with real transparency, ` +
          `not a flattened or checkerboard background`,
      );
      continue;
    }

    const hasGrid = entry.grid !== undefined;
    if (hasGrid) {
      if (
        entry.grid === null ||
        typeof entry.grid !== 'object' ||
        !isPositiveInt(entry.grid.cols) ||
        !isPositiveInt(entry.grid.rows)
      ) {
        errors.push(`state "${key}" has an invalid grid — expected {cols, rows} of positive ints`);
        continue;
      }
    } else if (!isPositiveInt(entry.frames)) {
      errors.push(`state "${key}" needs either "grid" {cols, rows} or "frames" (a positive int)`);
      continue;
    }

    const geom = resolveStateGeometry(entry, sheet, fallbackFrame);

    if (hasGrid) {
      const expectedW = geom.frame.width * geom.cols;
      const expectedH = geom.frame.height * geom.rows;
      if (expectedW !== sheet.width || expectedH !== sheet.height) {
        errors.push(
          `state "${key}": ${entry.sheet} is ${sheet.width}x${sheet.height}, which does not ` +
            `divide evenly into a ${geom.cols}x${geom.rows} grid`,
        );
        continue;
      }
    } else {
      const frameW = geom.declaredFrame?.width;
      if (!isPositiveInt(frameW)) {
        errors.push(`state "${key}" is a strip, so it needs a frame width (top-level or per-state)`);
        continue;
      }
      const expectedW = frameW * entry.frames;
      if (expectedW !== sheet.width) {
        errors.push(
          `state "${key}": expected ${entry.sheet} to be ${expectedW}px wide ` +
            `(${entry.frames} frames x ${frameW}px) but it is ${sheet.width}px`,
        );
        continue;
      }
    }

    const total = geom.totalFrames;

    if (entry.range !== undefined && !isRange(entry.range, total)) {
      errors.push(
        `state "${key}" has an invalid range ${JSON.stringify(entry.range)} — ` +
          `must be [from, to] with 0 <= from <= to < ${total}`,
      );
      continue;
    }

    let variants = null;
    if (entry.variants !== undefined) {
      if (!Array.isArray(entry.variants) || entry.variants.length === 0) {
        errors.push(`state "${key}" has an invalid variants list`);
        continue;
      }
      const bad = entry.variants.find((v) => !isRange(v, total));
      if (bad !== undefined) {
        errors.push(
          `state "${key}" has an invalid variant ${JSON.stringify(bad)} — ` +
            `must be [from, to] with 0 <= from <= to < ${total}`,
        );
        continue;
      }
      variants = entry.variants;
    }

    let offset = { x: 0, y: 0 };
    if (entry.offset !== undefined) {
      const o = entry.offset;
      const ok =
        o !== null &&
        typeof o === 'object' &&
        !Array.isArray(o) &&
        (o.x === undefined || Number.isInteger(o.x)) &&
        (o.y === undefined || Number.isInteger(o.y));
      if (!ok) {
        errors.push(`state "${key}" has an invalid offset — expected {x, y} of whole pixels`);
        continue;
      }
      offset = { x: o.x ?? 0, y: o.y ?? 0 };
    }

    const range = entry.range ?? [0, total - 1];

    resolved[key] = {
      sheet: entry.sheet,
      offset,
      frame: geom.frame,
      cols: geom.cols,
      rows: geom.rows,
      totalFrames: total,
      fps: Number.isFinite(entry.fps) && entry.fps > 0 ? entry.fps : DEFAULT_FPS,
      loop: entry.loop !== false,
      next: typeof entry.next === 'string' ? entry.next : null,
      range,
      variants: variants ?? [range],
      variantPick: entry.variantPick === 'sequential' ? 'sequential' : 'random',
    };
  }

  if (errors.length > 0) return { errors, warnings, theme: null };

  if (!Object.hasOwn(resolved, 'idle')) {
    warnings.push(
      'no "idle" state — the procedural blob will be used for every state this theme omits',
    );
  }

  return {
    errors,
    warnings,
    theme: {
      name: typeof manifest.name === 'string' ? manifest.name : 'unnamed',
      scale: Number.isFinite(manifest.scale) && manifest.scale > 0 ? manifest.scale : 1,
      states: resolved,
    },
  };
}

module.exports = { validateTheme, resolveStateGeometry, DEFAULT_FPS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/theme.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add src/theme.js test/theme.test.js
git commit -m "feat: add pure theme manifest validation with grid, range and variant support"
```

---

### Task 4: The `validate-theme` CLI, the template theme, and the Mochi theme

**Files:**
- Create: `tools/validate-theme.js`
- Create: `themes/_template/theme.json`
- Create: `themes/_template/README.md`
- Create: `docs/THEMES.md`
- Modify: `package.json` (add the `validate-theme` script)
- Modify: `.gitignore` (Mochi's generated theme dir is ignored; make that explicit)
- Test: `test/validate-theme.test.js`

**Interfaces:**
- Consumes: `readPngHeader` from `src/png.js`; `validateTheme` from `src/theme.js`
- Produces:
  - `collectSheetInfo(themeDir, manifest) => Record<filename, info|null>`
  - `validateThemeDir(themeDir) => { errors, warnings, theme }`
  - CLI: `npm run validate-theme -- themes/mochi`

**Note on Mochi:** the master sheet lives at `assets/sprites/mochi/Sleeping.png` and is committed. The runtime theme at `themes/mochi/` is **gitignored build output**. Since Phase 2 has no `import-sprite`, the runtime theme is produced by a plain file copy, documented in `docs/THEMES.md`. The lowercase filename matters — `theme.json` references `sleeping.png`, and case-sensitive filesystems will not forgive `Sleeping.png`.

- [ ] **Step 1: Write the failing test**

Create `test/validate-theme.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectSheetInfo, validateThemeDir } = require('../src/theme-loader.js');
const { PNG_SIGNATURE } = require('../src/png.js');

/** Write a PNG with a real header but no meaningful pixel data. */
function writeFakePng(file, width, height, colorType = 6) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(0, 0);
  fs.writeFileSync(
    file,
    Buffer.concat([
      PNG_SIGNATURE,
      len,
      Buffer.from('IHDR'),
      ihdr,
      Buffer.alloc(4),
      idatLen,
      Buffer.from('IDAT'),
      Buffer.alloc(4),
    ]),
  );
}

function makeThemeDir(manifest, sheets = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-theme-'));
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(manifest, null, 2), 'utf8');
  for (const [name, dims] of Object.entries(sheets)) {
    writeFakePng(path.join(dir, name), dims.width, dims.height, dims.colorType ?? 6);
  }
  return dir;
}

const MOCHI_MANIFEST = {
  name: 'Mochi',
  states: {
    sleeping: {
      sheet: 'sleeping.png',
      grid: { cols: 8, rows: 4 },
      fps: 4,
      loop: true,
      variants: [[0, 7], [8, 15], [16, 23], [24, 31]],
    },
  },
};

test('validates a correct theme directory', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, { 'sleeping.png': { width: 1920, height: 1080 } });
  const { errors, theme } = validateThemeDir(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(theme.states.sleeping.frame, { width: 240, height: 270 });
});

test('reports a missing theme.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-theme-'));
  const { errors } = validateThemeDir(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /theme\.json/);
});

test('reports malformed JSON without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-theme-'));
  fs.writeFileSync(path.join(dir, 'theme.json'), '{ not json', 'utf8');
  const { errors } = validateThemeDir(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /JSON/i);
});

test('reports a sheet whose geometry contradicts the grid', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, { 'sleeping.png': { width: 1000, height: 1080 } });
  const { errors } = validateThemeDir(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /grid/);
});

test('reports a sheet with no alpha channel', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, {
    'sleeping.png': { width: 1920, height: 1080, colorType: 2 },
  });
  const { errors } = validateThemeDir(dir);
  assert.match(errors[0], /alpha/i);
});

test('collectSheetInfo reports null for a missing file', () => {
  const dir = makeThemeDir(MOCHI_MANIFEST, {});
  const info = collectSheetInfo(dir, MOCHI_MANIFEST);
  assert.equal(info['sleeping.png'], null);
});

test('collectSheetInfo refuses a sheet path that escapes the theme directory', () => {
  const manifest = { name: 'Evil', states: { idle: { sheet: '../../etc/passwd', frames: 1 } } };
  const dir = makeThemeDir(manifest, {});
  const info = collectSheetInfo(dir, manifest);
  assert.equal(info['../../etc/passwd'], null);
});

test('the committed _template theme validates against its own documentation', () => {
  // The template ships no art, so every sheet is reported missing. What must
  // hold is that the manifest itself parses and names only real states.
  const templateDir = path.join(__dirname, '..', 'themes', '_template');
  const manifestFile = path.join(templateDir, 'theme.json');
  assert.ok(fs.existsSync(manifestFile), 'the _template theme must be committed');

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const { STATES } = require('../src/state-machine.js');
  for (const key of Object.keys(manifest.states)) {
    assert.ok(STATES.includes(key), `_template names an unknown state: ${key}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/validate-theme.test.js`
Expected: FAIL — `Cannot find module '../src/theme-loader.js'`

- [ ] **Step 3: Write the filesystem half**

Create `src/theme-loader.js`. This owns every filesystem touch; `src/theme.js` stays pure and `tools/` stays a thin shell over this.

```js
'use strict';

/**
 * The filesystem half of theme loading.
 *
 * `src/theme.js` holds the pure validation rules; this module supplies it with
 * real sheet dimensions and catches the problems only a real directory can
 * have — a missing manifest, unreadable JSON, or a filename whose case differs
 * from what the manifest claims.
 */

const fs = require('node:fs');
const path = require('node:path');

const { readPngHeader } = require('./png.js');
const { validateTheme } = require('./theme.js');
const { isSafeRelativePath } = require('./config.js');

/**
 * Read the header of every sheet the manifest references.
 * A sheet that is missing, unreadable, unsafe, or not a PNG maps to `null`,
 * which `validateTheme` turns into a per-state error naming the file.
 */
function collectSheetInfo(themeDir, manifest) {
  const info = {};
  const states = manifest && typeof manifest.states === 'object' ? manifest.states : {};

  for (const entry of Object.values(states ?? {})) {
    const sheet = entry && entry.sheet;
    if (typeof sheet !== 'string' || Object.hasOwn(info, sheet)) continue;

    if (!isSafeRelativePath(sheet)) {
      info[sheet] = null;
      continue;
    }

    try {
      const header = readPngHeader(fs.readFileSync(path.join(themeDir, sheet)));
      info[sheet] = header;
    } catch {
      info[sheet] = null;
    }
  }
  return info;
}

/** Case-insensitive filename check, so a Mac/Linux-only break is caught here. */
function checkFilenameCase(themeDir, manifest) {
  const problems = [];
  let entries;
  try {
    entries = fs.readdirSync(themeDir);
  } catch {
    return problems;
  }
  const byLower = new Map(entries.map((e) => [e.toLowerCase(), e]));

  const states = manifest && typeof manifest.states === 'object' ? manifest.states : {};
  for (const entry of Object.values(states ?? {})) {
    const sheet = entry && entry.sheet;
    if (typeof sheet !== 'string' || !isSafeRelativePath(sheet)) continue;
    if (entries.includes(sheet)) continue;

    const actual = byLower.get(sheet.toLowerCase());
    if (actual) {
      problems.push(
        `theme.json says "${sheet}" but the file on disk is "${actual}". ` +
          `Filenames are case-sensitive on Linux and on case-sensitive macOS volumes.`,
      );
    }
  }
  return problems;
}

function validateThemeDir(themeDir) {
  const manifestFile = path.join(themeDir, 'theme.json');

  let raw;
  try {
    raw = fs.readFileSync(manifestFile, 'utf8');
  } catch {
    return { errors: [`no theme.json found in ${themeDir}`], warnings: [], theme: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return { errors: [`theme.json is not valid JSON: ${err.message}`], warnings: [], theme: null };
  }

  const caseProblems = checkFilenameCase(themeDir, manifest);
  const result = validateTheme(manifest, collectSheetInfo(themeDir, manifest));

  return { ...result, errors: [...caseProblems, ...result.errors] };
}

module.exports = { collectSheetInfo, validateThemeDir, checkFilenameCase };
```

- [ ] **Step 3b: Write the thin CLI**

Create `tools/validate-theme.js`:

```js
#!/usr/bin/env node
'use strict';

/**
 * Validate a theme directory.
 *
 *   npm run validate-theme -- themes/mochi
 *
 * Reports geometry mismatches, missing alpha, unknown state names, filename
 * case mismatches and out-of-range frames — with messages that say what to fix.
 * All logic lives in src/theme-loader.js; this is presentation only.
 */

const { validateThemeDir } = require('../src/theme-loader.js');

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: npm run validate-theme -- <theme-directory>');
    process.exitCode = 1;
    return;
  }

  const { errors, warnings, theme } = validateThemeDir(target);

  for (const w of warnings) console.warn(`warning: ${w}`);

  if (errors.length > 0) {
    console.error(`\n${target} is not a valid theme:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  const states = Object.keys(theme.states);
  console.log(`${target} is valid.`);
  console.log(`  theme:  ${theme.name}`);
  console.log(`  states: ${states.join(', ')}`);
  for (const name of states) {
    const s = theme.states[name];
    console.log(
      `    ${name}: ${s.totalFrames} frames of ${s.frame.width}x${s.frame.height} ` +
        `@ ${s.fps}fps${s.variants.length > 1 ? `, ${s.variants.length} variants` : ''}`,
    );
  }
}

if (require.main === module) main();
```

- [ ] **Step 4: Add the npm script**

In `package.json`, add to `scripts`:

```json
    "validate-theme": "node tools/validate-theme.js",
```

- [ ] **Step 5: Create the template theme**

Create `themes/_template/theme.json`:

```json
{
  "name": "My Pet",
  "author": "you",
  "license": "CC0-1.0",
  "scale": 1,

  "frame": { "width": 128, "height": 128 },

  "states": {
    "idle": { "sheet": "idle.png", "frames": 4, "fps": 6, "loop": true },
    "thinking": { "sheet": "thinking.png", "frames": 6, "fps": 10, "loop": true },
    "working": { "sheet": "working.png", "frames": 8, "fps": 12, "loop": true },
    "done": { "sheet": "done.png", "frames": 6, "fps": 12, "loop": false, "next": "idle" },
    "needsInput": { "sheet": "knock.png", "frames": 4, "fps": 8, "loop": true },
    "subagent": { "sheet": "blip.png", "frames": 3, "fps": 12, "loop": false, "next": "thinking" },
    "error": { "sheet": "error.png", "frames": 4, "fps": 8, "loop": false, "next": "idle" },
    "sleeping": { "sheet": "sleep.png", "frames": 2, "fps": 2, "loop": true }
  }
}
```

Create `themes/_template/README.md`:

```markdown
# Theme template

Copy this directory to `themes/<your-theme>/`, drop your sheets beside the
manifest, and edit `theme.json` to match.

This template ships **no artwork** — Claude Buddy deliberately bundles no
character art. Every sheet named here is one you provide.

## The short version

- **`idle` is the only state worth providing first.** Any state you omit falls
  back to the built-in procedural blob, so a one-state theme is valid and works.
- Sheets are **PNG-32 with a real alpha channel**. A checkerboard background
  means you exported a screenshot of a transparent image, not a transparent one.
- Frames run **left to right, then top to bottom**, starting at 0.
- Keep **uniform padding across all frames**. Cropping each frame to its own
  content makes the character jitter as its silhouette changes.
- Filenames are **case-sensitive**. `Sleeping.png` and `sleeping.png` are
  different files everywhere except Windows.

## Check your work

```bash
npm run validate-theme -- themes/my-theme
```

Full contract and worked examples: [`docs/THEMES.md`](../../docs/THEMES.md).
```

- [ ] **Step 6: Write `docs/THEMES.md`**

Create `docs/THEMES.md`:

```markdown
# Authoring a theme

Claude Buddy ships no character art. The renderer is pluggable: drop a theme
into `themes/<name>/`, point `config.json` at it, and the pet wears it.

`themes/` is **gitignored** (except `_template/`), so art you did not create can
never be committed by this repository.

## Quick start

1. `cp -r themes/_template themes/my-pet`
2. Put your sheets in `themes/my-pet/`
3. Edit `themes/my-pet/theme.json`
4. `npm run validate-theme -- themes/my-pet`
5. Set `"theme": "my-pet"` in `config.json` and run `npm start`

## Sheet layouts

Frames are indexed from **0**, in reading order: left to right, then top to
bottom.

**Strip** — one row. Declare `frames` and a frame width.

```jsonc
"idle": { "sheet": "idle.png", "frames": 4, "fps": 6, "loop": true }
```
Sheet width must equal `frames x frame.width`.

**Grid** — rows and columns. Frame size is derived from the sheet, so you can
omit `frame` entirely.

```jsonc
"sleeping": {
  "sheet": "sleeping.png",
  "grid": { "cols": 8, "rows": 4 },
  "fps": 4,
  "loop": true
}
```
Sheet must be exactly `cols x frame.width` by `rows x frame.height`.

## Ranges and variants

`range` plays a sub-range, so one sheet can serve several states:

```jsonc
"sleeping": { "sheet": "mochi.png", "grid": {"cols":8,"rows":4}, "range": [0, 7],  "fps": 4 },
"idle":     { "sheet": "mochi.png", "grid": {"cols":8,"rows":4}, "range": [8, 15], "fps": 6 }
```

`variants` gives one state several interchangeable animations, picked on each
entry into that state:

```jsonc
"sleeping": {
  "sheet": "sleeping.png",
  "grid": { "cols": 8, "rows": 4 },
  "fps": 4,
  "variants": [[0, 7], [8, 15], [16, 23], [24, 31]],
  "variantPick": "random"
}
```

This is the cheapest liveliness you can buy: the animation is unchanged, only
*which slice plays* varies, and a pet that repeats the identical loop every time
reads as mechanical.

`variantPick` is `"random"` (default) or `"sequential"`.

## Aligning sheets that disagree

Each sheet can look perfectly consistent on its own and still disagree with its
siblings about where the ground is. When that happens the character visibly
jumps as states swap — internally consistent, mutually wrong.

The fix is a per-state pixel nudge:

```jsonc
"sleeping": { "sheet": "sleeping.png", "grid": {"cols":8,"rows":4}, "offset": { "y": -45 } }
```

`offset` shifts what is drawn inside the frame, in whole pixels. Negative `y`
moves the character up. Use it when you cannot re-cut the art; prefer fixing the
art itself when you can, since every sheet sharing one baseline needs no offsets
at all.

To find the number: note where the character's feet sit in each sheet and take
the difference. Mochi's sheets are all pre-aligned to a baseline of y=250, so
they need no offsets.

## The eight states

| State | Fires when | Required |
|---|---|:--:|
| `idle` | nothing is happening | recommended |
| `thinking` | you submitted a prompt | optional |
| `working` | sustained activity | optional |
| `done` | Claude finished | optional |
| `needsInput` | Claude needs permission | optional |
| `subagent` | a sub-task finished | optional |
| `error` | something failed | optional |
| `sleeping` | idle timeout elapsed | optional |

**Any state you omit falls back to the procedural blob.** A theme with one
state is valid — start with `sleeping` or `idle` and grow it.

One-shot states should set `"loop": false` and a `"next"`:

```jsonc
"done": { "sheet": "done.png", "frames": 6, "fps": 12, "loop": false, "next": "idle" }
```

## Image requirements

- **PNG-32 with true alpha.** No matte colour, no white background, and no
  baked-in checkerboard — a checkerboard means the file is a screenshot of a
  transparent image rather than a transparent image.
- Semi-transparent pixels are fine and encouraged (drop shadows, motion blur).
- **Uniform padding across all frames.** Do not crop each frame to its own
  content, or the character will jitter as its silhouette changes.
- Anchor the character **bottom-centre** so states line up when swapping.
- Leave headroom for effects that sit above the character (`zzz` puffs,
  exclamation marks). That padding is part of the frame geometry.

## Case sensitivity

Filenames in `theme.json` must match the files on disk **exactly**, including
case. Windows will forgive `Sleeping.png` vs `sleeping.png`; Linux and
case-sensitive macOS volumes will not. `validate-theme` treats a case mismatch
as an error rather than a warning, so your theme does not break for the first
person who clones it on a Mac.

## Worked example: Mochi

The repo includes a master sheet at `assets/sprites/mochi/Sleeping.png` —
1920x1080, an 8x4 grid of 240x270 frames, holding four distinct sleeping poses
of eight frames each.

Build the runtime theme from it:

```bash
mkdir -p themes/mochi
cp assets/sprites/mochi/Sleeping.png themes/mochi/sleeping.png   # note the lowercase
cp assets/sprites/mochi/theme.json themes/mochi/theme.json
npm run validate-theme -- themes/mochi
```

Then set `"theme": "mochi"` in `config.json`.

Mochi currently supplies only `sleeping`, so the pet renders as the procedural
blob in every other state and turns into a sleeping beagle when it dozes off.
Add more sheets to `assets/sprites/mochi/` and extend `theme.json` to cover more
states.

## Licensing

Only art the project owns belongs in `assets/`. Anything you did not create
belongs in `themes/`, which is gitignored — see [`../assets/README.md`](../assets/README.md).
```

- [ ] **Step 7: Confirm the Mochi manifest**

`assets/sprites/mochi/theme.json` already exists and covers four states. Verify
it matches this, and do not edit the sheets — they are pre-aligned to a shared
baseline of y=250 within each 240x270 cell, so no `offset` is needed:

```json
{
  "name": "Mochi",
  "author": "Marc",
  "license": "See ../../README.md",
  "scale": 0.6,

  "states": {
    "idle":     { "sheet": "idle.png",    "grid": { "cols": 8, "rows": 1 }, "fps": 6,  "loop": true },
    "working":  { "sheet": "working.png", "grid": { "cols": 8, "rows": 1 }, "fps": 12, "loop": true },
    "error":    { "sheet": "error.png",   "grid": { "cols": 8, "rows": 1 }, "fps": 8,  "loop": false, "next": "idle" },
    "sleeping": {
      "sheet": "sleeping.png",
      "grid": { "cols": 8, "rows": 4 },
      "fps": 4,
      "loop": true,
      "variants": [[0, 7], [8, 15], [16, 23], [24, 31]],
      "variantPick": "random"
    }
  }
}
```

`scale: 0.6` because a 240x270 frame renders large for a desktop pet.

Because `idle` is present, the four states Mochi does **not** define
(`thinking`, `done`, `needsInput`, `subagent`) fall back to the idle art per
spec §7.7 — so the pet is a beagle at all times, never a blob.

- [ ] **Step 8: Build and validate the Mochi runtime theme**

Run:

```bash
mkdir -p themes/mochi
cp assets/sprites/mochi/idle.png     themes/mochi/idle.png
cp assets/sprites/mochi/working.png  themes/mochi/working.png
cp assets/sprites/mochi/error.png    themes/mochi/error.png
cp assets/sprites/mochi/sleeping.png themes/mochi/sleeping.png
cp assets/sprites/mochi/theme.json   themes/mochi/theme.json
npm run validate-theme -- themes/mochi
```

Expected output:

```
themes/mochi is valid.
  theme:  Mochi
  states: idle, working, error, sleeping
    idle: 8 frames of 240x270 @ 6fps
    working: 8 frames of 240x270 @ 12fps
    error: 8 frames of 240x270 @ 8fps
    sleeping: 32 frames of 240x270 @ 4fps, 4 variants
```

No `idle` warning this time — the theme defines it.

- [ ] **Step 9: Confirm the template theme fails cleanly**

Run: `npm run validate-theme -- themes/_template`
Expected: exits non-zero and lists each missing sheet by name (the template ships no art). This proves the error path produces useful messages rather than a stack trace.

- [ ] **Step 10: Run the suite and commit**

Run: `npm test`

```bash
git add src/theme-loader.js tools/validate-theme.js test/validate-theme.test.js package.json \
        themes/_template docs/THEMES.md assets/sprites/mochi/theme.json
git commit -m "feat: add validate-theme CLI, template theme and authoring guide"
```

---

### Task 5: Load theme and sound assets in the main process

**Files:**
- Create: `src/assets.js`
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Modify: `src/renderer/index.html`
- Test: `test/assets.test.js`

**Interfaces:**
- Consumes: `validateThemeDir` from `tools/validate-theme.js`; `isSafeRelativePath` from `src/config.js`
- Produces:
  - `loadAssets(config, projectRoot) => { theme, sheets, sounds, sound, states, problems }`
    - `theme` — the resolved theme object, or `null` for the procedural theme
    - `sheets` — `Record<filename, dataUri>`, deduped so a sheet shared by several states is sent once
    - `sounds` — `Record<stateName, dataUri>`
    - `sound` — `{ enabled, volume }` passed through from config
    - `states` — per-state config passed through (currently `scalePulse`)
    - `problems` — human-readable strings for anything that could not be loaded
  - `toDataUri(buffer, filename) => string|null`
  - New IPC channel `assets`, exposed as `window.buddy.onAssets(callback)`

**Why data URIs:** the renderer is `sandbox: true` and must stay that way, so it cannot read files. The main process already does filesystem work, and the CSP already permits `img-src data:`. Sending bytes over IPC once at startup keeps the sandbox intact with no path plumbing in the renderer.

- [ ] **Step 1: Write the failing test**

Create `test/assets.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadAssets, toDataUri } = require('../src/assets.js');
const { DEFAULTS } = require('../src/config.js');
const { PNG_SIGNATURE } = require('../src/png.js');

function writeFakePng(file, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(0, 0);
  fs.writeFileSync(
    file,
    Buffer.concat([
      PNG_SIGNATURE, len, Buffer.from('IHDR'), ihdr, Buffer.alloc(4),
      idatLen, Buffer.from('IDAT'), Buffer.alloc(4),
    ]),
  );
}

/** Build a throwaway project root with a theme and a sounds folder. */
function makeProject({ theme = null, sounds = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-assets-'));
  if (theme) {
    const dir = path.join(root, 'themes', theme.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme.manifest), 'utf8');
    for (const [file, dims] of Object.entries(theme.sheets ?? {})) {
      writeFakePng(path.join(dir, file), dims.width, dims.height);
    }
  }
  if (Object.keys(sounds).length > 0) {
    fs.mkdirSync(path.join(root, 'sounds'), { recursive: true });
    for (const [file, bytes] of Object.entries(sounds)) {
      fs.writeFileSync(path.join(root, 'sounds', file), Buffer.from(bytes), 'utf8');
    }
  }
  return root;
}

const MOCHI = {
  name: 'mochi',
  manifest: {
    name: 'Mochi',
    scale: 0.6,
    states: {
      sleeping: { sheet: 'sleeping.png', grid: { cols: 8, rows: 4 }, fps: 4, loop: true },
    },
  },
  sheets: { 'sleeping.png': { width: 1920, height: 1080 } },
};

test('toDataUri picks a mime type from the extension', () => {
  assert.match(toDataUri(Buffer.from('x'), 'a.png'), /^data:image\/png;base64,/);
  assert.match(toDataUri(Buffer.from('x'), 'a.mp3'), /^data:audio\/mpeg;base64,/);
  assert.match(toDataUri(Buffer.from('x'), 'a.wav'), /^data:audio\/wav;base64,/);
  assert.match(toDataUri(Buffer.from('x'), 'a.ogg'), /^data:audio\/ogg;base64,/);
});

test('toDataUri refuses an unknown extension', () => {
  assert.equal(toDataUri(Buffer.from('x'), 'a.exe'), null);
  assert.equal(toDataUri(Buffer.from('x'), 'noext'), null);
});

test('the procedural theme loads no theme and no sheets', () => {
  const root = makeProject();
  const assets = loadAssets({ ...DEFAULTS, theme: 'procedural', states: {} }, root);
  assert.equal(assets.theme, null);
  assert.deepEqual(assets.sheets, {});
  assert.deepEqual(assets.problems, []);
});

test('loads a theme and inlines its sheet as a data URI', () => {
  const root = makeProject({ theme: MOCHI });
  const assets = loadAssets({ ...DEFAULTS, theme: 'mochi', states: {} }, root);
  assert.deepEqual(assets.problems, []);
  assert.equal(assets.theme.name, 'Mochi');
  assert.equal(assets.theme.scale, 0.6);
  assert.match(assets.sheets['sleeping.png'], /^data:image\/png;base64,/);
});

test('a missing theme directory degrades to procedural with a problem reported', () => {
  const root = makeProject();
  const assets = loadAssets({ ...DEFAULTS, theme: 'nope', states: {} }, root);
  assert.equal(assets.theme, null);
  assert.ok(assets.problems.length > 0);
  assert.match(assets.problems[0], /nope/);
});

test('an invalid theme degrades to procedural rather than throwing', () => {
  const broken = {
    name: 'broken',
    manifest: { name: 'Broken', states: { sleeping: { sheet: 'missing.png', frames: 4 } } },
    sheets: {},
  };
  const root = makeProject({ theme: broken });
  const assets = loadAssets({ ...DEFAULTS, theme: 'broken', states: {} }, root);
  assert.equal(assets.theme, null);
  assert.ok(assets.problems.length > 0);
});

test('loads per-state sounds', () => {
  const root = makeProject({ sounds: { 'tada.mp3': 'fake-audio' } });
  const assets = loadAssets(
    { ...DEFAULTS, theme: 'procedural', states: { done: { sound: 'sounds/tada.mp3' } } },
    root,
  );
  assert.match(assets.sounds.done, /^data:audio\/mpeg;base64,/);
  assert.deepEqual(assets.problems, []);
});

test('a missing sound file is reported and skipped, not fatal', () => {
  const root = makeProject();
  const assets = loadAssets(
    { ...DEFAULTS, theme: 'procedural', states: { done: { sound: 'sounds/absent.mp3' } } },
    root,
  );
  assert.equal(assets.sounds.done, undefined);
  assert.equal(assets.problems.length, 1);
  assert.match(assets.problems[0], /absent\.mp3/);
});

test('refuses a sound path that escapes the project root', () => {
  const root = makeProject();
  const assets = loadAssets(
    { ...DEFAULTS, theme: 'procedural', states: { done: { sound: '../../../etc/passwd' } } },
    root,
  );
  assert.equal(assets.sounds.done, undefined);
  assert.ok(assets.problems.length > 0);
});

test('passes sound settings and per-state scalePulse through', () => {
  const root = makeProject();
  const assets = loadAssets(
    {
      ...DEFAULTS,
      theme: 'procedural',
      sound: { enabled: false, volume: 0.2 },
      states: { done: { scalePulse: 1.4 } },
    },
    root,
  );
  assert.deepEqual(assets.sound, { enabled: false, volume: 0.2 });
  assert.equal(assets.states.done.scalePulse, 1.4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/assets.test.js`
Expected: FAIL — `Cannot find module '../src/assets.js'`

- [ ] **Step 3: Write `src/assets.js`**

```js
'use strict';

/**
 * Resolve a theme and its sounds from disk into an IPC-safe payload.
 *
 * The renderer runs sandboxed and cannot read files, so every asset crosses the
 * boundary as a `data:` URI produced here. Nothing in this module throws: a
 * broken theme or a missing sound degrades to the procedural blob or to silence,
 * and the reason is reported in `problems` for the tray and the console.
 */

const fs = require('node:fs');
const path = require('node:path');

const { isSafeRelativePath, PROCEDURAL_THEME } = require('./config.js');
const { validateThemeDir } = require('./theme-loader.js');

/** Only these types may be inlined. An unknown extension is refused outright. */
const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.apng': 'image/apng',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
});

function toDataUri(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const mime = Object.hasOwn(MIME_BY_EXTENSION, ext) ? MIME_BY_EXTENSION[ext] : null;
  if (mime === null) return null;
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function loadTheme(config, projectRoot, problems) {
  if (config.theme === PROCEDURAL_THEME) return { theme: null, sheets: {} };

  const themeDir = path.join(projectRoot, 'themes', config.theme);
  if (!fs.existsSync(themeDir)) {
    problems.push(`theme "${config.theme}" not found at themes/${config.theme}`);
    return { theme: null, sheets: {} };
  }

  const { errors, warnings, theme } = validateThemeDir(themeDir);
  for (const w of warnings) problems.push(`theme "${config.theme}": ${w}`);

  if (errors.length > 0 || theme === null) {
    problems.push(`theme "${config.theme}" is invalid: ${errors.join('; ')}`);
    return { theme: null, sheets: {} };
  }

  // Dedupe: several states may share one sheet, and these are large.
  const sheets = {};
  for (const state of Object.values(theme.states)) {
    if (Object.hasOwn(sheets, state.sheet)) continue;
    try {
      const uri = toDataUri(fs.readFileSync(path.join(themeDir, state.sheet)), state.sheet);
      if (uri === null) {
        problems.push(`theme "${config.theme}": unsupported image type ${state.sheet}`);
        return { theme: null, sheets: {} };
      }
      sheets[state.sheet] = uri;
    } catch (err) {
      problems.push(`theme "${config.theme}": could not read ${state.sheet} (${err.message})`);
      return { theme: null, sheets: {} };
    }
  }

  return { theme, sheets };
}

function loadSounds(config, projectRoot, problems) {
  const sounds = {};

  for (const [state, settings] of Object.entries(config.states ?? {})) {
    const rel = settings && settings.sound;
    if (typeof rel !== 'string') continue;

    if (!isSafeRelativePath(rel)) {
      problems.push(`sound for "${state}" has an unsafe path and was ignored`);
      continue;
    }

    try {
      const uri = toDataUri(fs.readFileSync(path.join(projectRoot, rel)), rel);
      if (uri === null) {
        problems.push(`sound for "${state}": unsupported audio type ${rel}`);
        continue;
      }
      sounds[state] = uri;
    } catch {
      problems.push(`sound for "${state}": ${rel} is missing or unreadable`);
    }
  }

  return sounds;
}

/**
 * @param {object} config a validated Config
 * @param {string} projectRoot
 */
function loadAssets(config, projectRoot) {
  const problems = [];
  const { theme, sheets } = loadTheme(config, projectRoot, problems);
  const sounds = loadSounds(config, projectRoot, problems);

  return {
    theme,
    sheets,
    sounds,
    sound: { ...config.sound },
    states: { ...config.states },
    problems,
  };
}

module.exports = { loadAssets, toDataUri, MIME_BY_EXTENSION };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/assets.test.js`
Expected: PASS

- [ ] **Step 5: Add the `assets` channel to the preload**

Replace `src/preload.js`:

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

  /**
   * Theme sheets and sounds, inlined as data URIs by the main process because
   * the sandboxed renderer cannot read files. Delivered once, after load.
   * @param {(assets: object) => void} callback
   */
  onAssets(callback) {
    ipcRenderer.on('assets', (_event, assets) => callback(assets));
  },

  /** Report that a non-looping animation has finished playing. */
  animationEnded() {
    ipcRenderer.send('animation-ended');
  },
});
```

- [ ] **Step 6: Allow audio data URIs in the CSP**

In `src/renderer/index.html`, change the CSP meta tag to:

```html
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src data:;"
    />
```

**Exactly one change:** `media-src data:`, so `new Audio(dataUri)` is permitted.
`data:` is not a network origin, so the "zero outbound connections" guarantee is
untouched.

`style-src` stays `'self'` — do **not** add `'unsafe-inline'`. CSP governs
inline `<style>` blocks and `style=""` attributes in markup; it does not govern
CSSOM writes like `el.style.backgroundPosition = ...`, which is all the sprite
renderer does. Verified empirically against this exact CSP: the property
applied, a `data:` background image loaded, and zero violations were reported.

- [ ] **Step 7: Wire asset loading into `src/main.js`**

Add near the other requires:

```js
const { loadAssets } = require('./assets.js');
```

Add a module-level constant beside the others:

```js
const PROJECT_ROOT = path.join(__dirname, '..');
const assets = loadAssets(config, PROJECT_ROOT);
```

Inside `createWindow`, in the `did-finish-load` handler, send the assets **before** the state resync so the renderer can choose a renderer before it is asked to show a state. Replace the handler body with:

```js
  win.webContents.on('did-finish-load', () => {
    const scale = Number(config.scale) > 0 ? Number(config.scale) : 1;
    win.webContents.insertCSS(`#stage { transform: scale(${scale}); }`);

    // Assets first: the renderer must know which theme it has before it is
    // told which state to show, or the first state would render with the
    // procedural fallback and then visibly swap.
    win.webContents.send('assets', assets);

    // The renderer has only just subscribed; catch it up on anything it
    // missed while the page was loading. See machine.snapshot().
    //
    // Flagged as a resync so the renderer can ignore it when it is already
    // showing this state: an event delivered after preload registered but
    // before this fires was NOT lost, and replaying it would restart a live
    // one-shot's settle timer and re-run its pulse.
    pushStateChange({ ...machine.snapshot(), resync: true });
  });
```

In `createTray`, surface asset problems so a broken theme is visible rather than mysterious. Change the menu template's first entries to:

```js
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      {
        label: assets.theme ? `Theme: ${assets.theme.name}` : 'Theme: procedural',
        enabled: false,
      },
      ...(assets.problems.length > 0
        ? [{ label: `${assets.problems.length} asset problem(s) — see console`, enabled: false }]
        : []),
      { type: 'separator' },
```

And log them once at startup, immediately after the `assets` constant:

```js
for (const problem of assets.problems) console.warn(`[buddy] ${problem}`);
```

- [ ] **Step 8: Verify the app still boots**

**Environment note:** this shell has `ELECTRON_RUN_AS_NODE` set, which breaks `require('electron')`. Prefix launches with `env -u ELECTRON_RUN_AS_NODE`.

Run: `npm start`
Expected: the blob appears exactly as before (config still says `"theme": "procedural"`), the tray shows `Theme: procedural`, and the console reports no asset problems.

- [ ] **Step 9: Run the suite and commit**

Run: `npm test`

```bash
git add src/assets.js src/preload.js src/main.js src/renderer/index.html test/assets.test.js
git commit -m "feat: load theme and sound assets as data URIs over one new IPC channel"
```

---

### Task 6: The sprite renderer

**Files:**
- Create: `src/renderer/frame-math.js`
- Create: `src/renderer/sprite.js`
- Modify: `src/renderer/procedural.js` (add `setActive`)
- Modify: `src/renderer/index.html` (load the new scripts)
- Test: `test/sprite-frames.test.js`

**Interfaces:**
- Consumes: the resolved theme from `window.buddy.onAssets`
- Produces:
  - `createSpriteRenderer(theme, sheets) => Renderer`
  - Renderer contract: `mount(rootEl)`, `setState(change)`, `setActive(bool)`, `supports(state) => boolean`, `destroy()`
  - `frameOffset(index, cols, frame) => { x, y }`, `framesOf(range) => number[]`, `pickVariant(variants, mode, entryCount) => range` — pure

**On the one shared file:** the frame arithmetic is the only genuinely testable logic here, and a sandboxed renderer cannot `require()`. Rather than keep two copies in sync, `src/renderer/frame-math.js` detects its environment: Node's test runner `require()`s it, and the page loads the same file with a `<script>` tag where it assigns to `window.frameMath`. One source of truth, no duplication.

**Fallback rule (spec §7.7):** a state the theme omits falls back to the theme's **`idle`** state, not to the procedural blob — a beagle that stays a beagle beats one that turns into an orange blob mid-session. Only when the theme has no `idle` either does the orchestrator hand off to the procedural renderer. That is exactly Mochi's situation today.

- [ ] **Step 1: Write the failing test for the pure frame maths**

Create `test/sprite-frames.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { frameOffset, framesOf, pickVariant } = require('../src/renderer/frame-math.js');

const FRAME = { width: 240, height: 270 };

test('frame 0 sits at the origin', () => {
  assert.deepEqual(frameOffset(0, 8, FRAME), { x: 0, y: 0 });
});

test('frames advance left to right across a row', () => {
  assert.deepEqual(frameOffset(1, 8, FRAME), { x: -240, y: 0 });
  assert.deepEqual(frameOffset(7, 8, FRAME), { x: -1680, y: 0 });
});

test('frames wrap to the next row in reading order', () => {
  assert.deepEqual(frameOffset(8, 8, FRAME), { x: 0, y: -270 });
  assert.deepEqual(frameOffset(9, 8, FRAME), { x: -240, y: -270 });
  assert.deepEqual(frameOffset(31, 8, FRAME), { x: -1680, y: -810 });
});

test('a single-row strip never advances vertically', () => {
  for (let i = 0; i < 4; i += 1) {
    assert.equal(frameOffset(i, 4, FRAME).y, 0);
  }
});

test('framesOf expands an inclusive range', () => {
  assert.deepEqual(framesOf([0, 3]), [0, 1, 2, 3]);
  assert.deepEqual(framesOf([8, 8]), [8]);
  assert.deepEqual(framesOf([2, 5]), [2, 3, 4, 5]);
});

test('pickVariant returns the only variant when there is one', () => {
  assert.deepEqual(pickVariant([[0, 7]], 'random', 0), [0, 7]);
  assert.deepEqual(pickVariant([[0, 7]], 'sequential', 5), [0, 7]);
});

test('pickVariant cycles in sequential mode', () => {
  const variants = [[0, 7], [8, 15], [16, 23]];
  assert.deepEqual(pickVariant(variants, 'sequential', 0), [0, 7]);
  assert.deepEqual(pickVariant(variants, 'sequential', 1), [8, 15]);
  assert.deepEqual(pickVariant(variants, 'sequential', 3), [0, 7], 'wraps around');
});

test('pickVariant stays in range in random mode', () => {
  const variants = [[0, 7], [8, 15], [16, 23], [24, 31]];
  for (let i = 0; i < 200; i += 1) {
    assert.ok(variants.includes(pickVariant(variants, 'random', i)));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/sprite-frames.test.js`
Expected: FAIL — `Cannot find module '../src/renderer/frame-math.js'`

- [ ] **Step 3: Write the pure frame maths**

Create `src/renderer/frame-math.js`. The wrapper is what lets one file serve both the Node test runner and the sandboxed page:

```js
'use strict';

/**
 * Pure sprite-sheet frame arithmetic.
 *
 * Loaded two ways from this single file: `require()`d by the Node test runner,
 * and pulled in with a <script> tag by the renderer, which is sandboxed and
 * therefore cannot require(). Keeping one file avoids two copies drifting.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api;
  } else {
    root.frameMath = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * Background offset for a frame index, in reading order: left to right, then
   * top to bottom. Values are negative because they shift the sheet behind a
   * fixed viewport, rather than moving the viewport.
   */
  function frameOffset(index, cols, frame) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return { x: -col * frame.width, y: -row * frame.height };
  }

  /** Expand an inclusive [from, to] range into a list of frame indices. */
  function framesOf(range) {
    const out = [];
    for (let i = range[0]; i <= range[1]; i += 1) out.push(i);
    return out;
  }

  /**
   * Choose which variant to play on entering a state.
   * `entryCount` makes sequential mode deterministic, and therefore testable.
   */
  function pickVariant(variants, mode, entryCount) {
    if (variants.length === 1) return variants[0];
    if (mode === 'sequential') return variants[entryCount % variants.length];
    return variants[Math.floor(Math.random() * variants.length)];
  }

  return { frameOffset, framesOf, pickVariant };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/sprite-frames.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Write the sprite renderer**

Create `src/renderer/sprite.js`:

```js
'use strict';

/**
 * Sprite-sheet renderer.
 *
 * Implements the same contract as the procedural blob — mount / setState /
 * setActive / destroy — plus `supports(state)`, because a theme may cover only
 * some states and the orchestrator falls back per state.
 *
 * Sheets arrive as data URIs from the main process; this renderer never touches
 * the filesystem. Frames are stepped by moving the background position, which
 * keeps the whole sheet as one decoded image rather than re-decoding per frame.
 */

const { frameOffset, framesOf, pickVariant } = window.frameMath;

function createSpriteRenderer(theme, sheets) {
  let root = null;
  let el = null;
  let currentState = null;
  let timer = null;
  let settleTimer = null;
  let entryCount = 0;

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    clearTimeout(settleTimer);
    settleTimer = null;
  }

  function show(spec, index) {
    const { x, y } = frameOffset(index, spec.cols, spec.frame);
    // spec.offset nudges a sheet whose baseline disagrees with its siblings,
    // so the character does not jump vertically when states swap.
    el.style.backgroundPosition = `${x + spec.offset.x}px ${y + spec.offset.y}px`;
  }

  /** How long to show borrowed `idle` art before acking a one-shot. */
  const FALLBACK_ONE_SHOT_MS = 700;

  /**
   * Play a state.
   *
   * The visual loop and the `animation-ended` ack are deliberately independent.
   * When we are showing borrowed `idle` art for a one-shot state, the art loops
   * forever but the ack must still fire — otherwise `completeOneShot()` never
   * runs, the machine stays stuck in `done`, and since `tick()` only sleeps from
   * `idle` the buddy would never sleep again. That is the Phase 1 wedge, and
   * tying the ack to the end of the animation would reintroduce it here.
   */
  function play(spec, change, isFallback) {
    const range = pickVariant(spec.variants, spec.variantPick, entryCount);
    const frames = framesOf(range);
    const loopVisually = isFallback ? true : spec.loop;
    let i = 0;

    el.style.width = `${spec.frame.width}px`;
    el.style.height = `${spec.frame.height}px`;
    el.style.backgroundImage = `url("${sheets[spec.sheet]}")`;
    show(spec, frames[0]);

    const intervalMs = Math.max(16, Math.round(1000 / spec.fps));

    timer = setInterval(() => {
      i += 1;
      if (i >= frames.length) {
        if (loopVisually) {
          i = 0;
        } else {
          // Hold the final frame rather than snapping back.
          clearInterval(timer);
          timer = null;
          return;
        }
      }
      show(spec, frames[i]);
    }, intervalMs);

    if (change.next) {
      const ackMs = isFallback
        ? FALLBACK_ONE_SHOT_MS
        : Math.round((frames.length / spec.fps) * 1000);
      settleTimer = setTimeout(() => window.buddy.animationEnded(), ackMs);
    }
  }

  /**
   * Which sheet spec to play for a state.
   *
   * Spec §7.7: a state the theme omits falls back to `idle`, so a themed
   * character stays itself rather than turning into the procedural blob
   * mid-session. Only a theme with no `idle` at all returns null, which is the
   * orchestrator's signal to hand off.
   */
  function specFor(state) {
    if (Object.hasOwn(theme.states, state)) return theme.states[state];
    if (Object.hasOwn(theme.states, 'idle')) return theme.states.idle;
    return null;
  }

  return {
    supports(state) {
      return specFor(state) !== null;
    },

    mount(rootEl) {
      if (el) this.destroy();
      root = rootEl;
      el = document.createElement('div');
      el.className = 'sprite';
      root.appendChild(el);
    },

    setState(change) {
      if (!el) return;
      if (change.resync && change.state === currentState) return;

      const spec = specFor(change.state);
      if (spec === null) return;

      stop();
      currentState = change.state;
      entryCount += 1;
      play(spec, change, !Object.hasOwn(theme.states, change.state));
    },

    setActive(isActive) {
      if (!el) return;
      el.style.display = isActive ? '' : 'none';
      // A hidden renderer must not keep burning a timer per frame.
      if (!isActive) stop();
    },

    destroy() {
      stop();
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
      root = null;
      currentState = null;
    },
  };
}

window.createSpriteRenderer = createSpriteRenderer;
```

- [ ] **Step 6: Add `setActive` to the procedural renderer**

In `src/renderer/procedural.js`, add this method to the returned object, directly after `setState`:

```js
    setActive(isActive) {
      if (!el) return;
      el.style.display = isActive ? '' : 'none';
      if (!isActive) {
        clearTimeout(pulseTimer);
        clearTimeout(settleTimer);
      }
    },
```

- [ ] **Step 7: Add sprite styling and load the script**

Append to `src/renderer/styles.css`:

```css
/* Sprite-sheet renderer. Pixel art must not be smoothed when scaled. */
.sprite {
  background-repeat: no-repeat;
  image-rendering: pixelated;
  -webkit-app-region: drag;
  filter: drop-shadow(0 8px 10px rgba(0, 0, 0, 0.35));
}
```

In `src/renderer/index.html`, add the sprite script before `renderer.js`:

```html
    <script src="frame-math.js"></script>
    <script src="procedural.js"></script>
    <script src="sprite.js"></script>
    <script src="sound.js"></script>
    <script src="renderer.js"></script>
```

`frame-math.js` must come before `sprite.js`, which reads `window.frameMath` at load time. (`sound.js` is created in Task 7; add the tag now so the markup is written once.)

- [ ] **Step 8: Run the suite and commit**

Run: `npm test`

```bash
git add src/renderer/frame-math.js src/renderer/sprite.js src/renderer/procedural.js \
        src/renderer/styles.css src/renderer/index.html test/sprite-frames.test.js
git commit -m "feat: add sprite-sheet renderer with grid, range and variant playback"
```

---

### Task 7: Sound playback and the renderer orchestrator

**Files:**
- Create: `src/renderer/sound.js`
- Modify: `src/renderer/renderer.js`
- Modify: `src/main.js` (autoplay policy)

**Interfaces:**
- Consumes: `window.buddy.onAssets`, `window.buddy.onStateChange`
- Produces:
  - `createSoundPlayer({ sounds, enabled, volume }) => { play(state), setEnabled(bool) }`
  - The orchestrator in `renderer.js`, which picks a renderer per state and triggers sound

**Why an orchestrator:** a theme may cover only some states. `renderer.js` holds both renderers, asks the sprite renderer `supports(state)`, activates the winner and deactivates the loser. That is what makes a one-state Mochi theme usable.

**Autoplay:** Chromium blocks audio until a user gesture. A desktop pet never gets one, so the main process must set `autoplayPolicy: 'no-user-gesture-required'`.

- [ ] **Step 1: Set the autoplay policy**

In `src/main.js`, inside `createWindow`'s `webPreferences`, add:

```js
      // A desktop pet never receives a user gesture, so Chromium's default
      // autoplay policy would silently block every sound.
      autoplayPolicy: 'no-user-gesture-required',
```

- [ ] **Step 2: Write the sound player**

Create `src/renderer/sound.js`:

```js
'use strict';

/**
 * Per-state sound playback.
 *
 * Sounds arrive as data URIs, so there is no network fetch and no filesystem
 * access — `media-src data:` in the CSP is what permits them. Each sound is
 * decoded once and rewound on replay rather than re-created, so a rapid burst
 * of events cannot pile up Audio objects.
 */
function createSoundPlayer({ sounds = {}, enabled = true, volume = 0.5 } = {}) {
  const cache = new Map();
  let isEnabled = enabled;

  for (const [state, uri] of Object.entries(sounds)) {
    try {
      const audio = new Audio(uri);
      audio.volume = Math.min(1, Math.max(0, volume));
      audio.preload = 'auto';
      cache.set(state, audio);
    } catch {
      // A sound that will not construct is not worth failing the pet over.
    }
  }

  return {
    play(state) {
      if (!isEnabled) return;
      const audio = cache.get(state);
      if (!audio) return;
      try {
        audio.currentTime = 0;
        // play() rejects if the browser still blocks autoplay; ignore it
        // rather than surfacing an unhandled rejection every state change.
        const result = audio.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        /* never let audio break the animation */
      }
    },

    setEnabled(value) {
      isEnabled = Boolean(value);
    },

    has(state) {
      return cache.has(state);
    },
  };
}

window.createSoundPlayer = createSoundPlayer;
```

- [ ] **Step 3: Rewrite the orchestrator**

Replace `src/renderer/renderer.js`:

```js
'use strict';

(function main() {
  const stage = document.getElementById('stage');
  const badge = document.getElementById('badge');

  const procedural = window.createProceduralRenderer();
  procedural.mount(stage);

  /** Set once assets arrive; null means "procedural for everything". */
  let sprite = null;
  let sounds = null;
  let stateConfig = {};
  let active = procedural;
  let badgeTimer = null;

  /** The sprite renderer wins for any state its theme actually covers. */
  function rendererFor(state) {
    if (sprite && sprite.supports(state)) return sprite;
    return procedural;
  }

  function applyState(change) {
    const target = rendererFor(change.state);

    if (target !== active) {
      active.setActive(false);
      target.setActive(true);
      active = target;
    }

    target.setState(change);

    // A per-state scalePulse is the "enlarging itself" attention behaviour.
    const pulse = stateConfig[change.state] && stateConfig[change.state].scalePulse;
    if (Number.isFinite(pulse) && pulse !== 1) {
      stage.style.transition = 'none';
      stage.style.setProperty('--pulse', String(pulse));
      stage.classList.remove('pulsing');
      void stage.offsetWidth;
      stage.classList.add('pulsing');
    }

    if (sounds) sounds.play(change.state);

    badge.textContent = change.state;
    badge.classList.add('visible');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => badge.classList.remove('visible'), 1600);
  }

  window.buddy.onAssets((assets) => {
    stateConfig = assets.states || {};

    if (assets.theme && assets.sheets) {
      sprite = window.createSpriteRenderer(assets.theme, assets.sheets);
      sprite.mount(stage);
      sprite.setActive(false);
    }

    sounds = window.createSoundPlayer({
      sounds: assets.sounds,
      enabled: assets.sound && assets.sound.enabled,
      volume: assets.sound && assets.sound.volume,
    });
  });

  window.buddy.onStateChange(applyState);
})();
```

- [ ] **Step 4: Add the pulse styling**

Append to `src/renderer/styles.css`:

```css
/* Per-state attention pulse, driven by config.states.<state>.scalePulse. */
#stage.pulsing {
  animation: stagePulse 420ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes stagePulse {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(var(--pulse, 1.2));
  }
  100% {
    transform: scale(1);
  }
}
```

**Note:** `#stage` already carries a `transform: scale()` injected by `main.js` for `config.scale`. The keyframe overrides it for the duration of the pulse and returns to `scale(1)`, which drops the configured scale mid-animation. To avoid that, change the injected rule in `src/main.js` to set a variable instead:

```js
    win.webContents.insertCSS(`#stage { --base-scale: ${scale}; transform: scale(var(--base-scale)); }`);
```

and make the keyframe compose with it:

```css
@keyframes stagePulse {
  0% {
    transform: scale(var(--base-scale, 1));
  }
  45% {
    transform: scale(calc(var(--base-scale, 1) * var(--pulse, 1.2)));
  }
  100% {
    transform: scale(var(--base-scale, 1));
  }
}
```

- [ ] **Step 5: Verify with the procedural theme (no regression)**

Run: `npm start`

Expected: the blob behaves exactly as in Phase 1. Confirm by POSTing events:

```bash
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"done\"}"
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"needsInput\"}"
```

- [ ] **Step 6: Verify with the Mochi theme**

Set `config.json` to:

```json
{
  "theme": "mochi",
  "idleTimeoutMinutes": 0.1,
  "states": {
    "done": { "scalePulse": 1.4 }
  }
}
```

Run `npm start` and confirm:
1. The tray reads `Theme: Mochi`
2. The pet is a **sitting beagle** at rest, blinking — not the blob
3. After ~6 seconds idle it becomes a **sleeping beagle**, animating at 4fps
4. POSTing `error` plays the droop-and-curl, then returns to sitting
5. POSTing `done` shows the **idle art** (Mochi defines no `done`), proving the §7.7 fallback — a beagle throughout, never a blob
6. Letting it idle again shows a sleeping beagle, sometimes in a **different pose** (four variants, picked at random)

Delete `config.json` afterwards to restore defaults.

- [ ] **Step 7: Verify sound**

Place any short `.mp3` at `sounds/tada.mp3`, set `config.json` to:

```json
{ "states": { "done": { "sound": "sounds/tada.mp3" } } }
```

Run `npm start`, POST a `done` event, and confirm the sound plays. Then set `"sound": { "enabled": false }` and confirm it does not.

Delete `config.json` afterwards.

- [ ] **Step 8: Run the suite and commit**

Run: `npm test`

```bash
git add src/renderer/sound.js src/renderer/renderer.js src/renderer/styles.css src/main.js
git commit -m "feat: add per-state sound playback and per-state renderer selection"
```

---

## Phase 2 Definition of Done

- [ ] `npm test` passes, with no Phase 1 test broken
- [ ] `npm run validate-theme -- themes/mochi` reports a valid theme with 32 frames and 4 variants
- [ ] `npm run validate-theme -- themes/_template` fails with per-file messages, not a stack trace
- [ ] With `"theme": "procedural"` the pet behaves exactly as in Phase 1
- [ ] With `"theme": "mochi"` the pet sleeps as a beagle and uses the blob for other states
- [ ] Sleeping repeatedly shows different poses (variants working)
- [ ] A per-state sound plays, and `sound.enabled: false` silences it
- [ ] A missing or invalid theme degrades to the procedural blob with a problem logged and shown in the tray
- [ ] A traversal path in `theme` or a state's `sound` is refused
- [ ] `package.json` still lists **electron and nothing else**
- [ ] `contextIsolation`, `nodeIntegration: false` and `sandbox: true` all unchanged

---

## Deferred to Phase 3

- **`rules.js`** — the imperative config escape hatch (spec §6.2). Runs user code in the main process; deserves its own security review.
- **`import-sprite`** — normalizing messy source art. Needs a from-scratch PNG encoder; not required by any asset we have.
- **Click interactions** and **speech bubbles** (spec §13). The `/event` payload already carries `message`, so the door is open.
- **`clickThrough`** (spec §6.3) — transparent pixels currently still capture clicks across the whole window.
- **More Mochi sheets** — `idle`, `done`, `needsInput` and the rest, so the theme stops mixing a beagle with a blob.
