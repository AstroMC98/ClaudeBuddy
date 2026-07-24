# Claude Buddy — Phase 3C (Interactions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pet feel physically present — it remembers where you dragged it, shows what Claude is saying, reacts when you poke it, and lets clicks fall through to whatever is behind it.

**Architecture:** Four small, independent features. Position persistence adds a pure `state.json` store and window wiring. Speech bubbles ride the message already carried on hook events out to the renderer. Click reactions are pure renderer CSS. Click-through uses Electron's `setIgnoreMouseEvents(..., {forward})` with the renderer reporting whether the cursor is over the pet.

**Tech Stack:** Electron 43, Node 24, `node:test`. No new dependencies.

**Scope:** Spec §6.3 (`clickThrough`, `position`) and §13 (click interactions, speech bubbles). Phase 3, sub-plan C of three.

**Spec:** [`docs/superpowers/specs/2026-07-23-claude-buddy-design.md`](../specs/2026-07-23-claude-buddy-design.md) §6.3, §13

## Global Constraints

- **Electron is the ONLY entry in `package.json` dependencies/devDependencies.** No packages.
- **Tests run via `npm test` → `node --test test/*.js`.** The pure store is unit-tested; window/DOM behavior is verified by the controller.
- `'use strict';` and CommonJS in `src/`; renderer scripts are plain browser scripts.
- **Do NOT weaken Electron hardening** (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) or the CSP.
- **Speech-bubble text is untrusted** (it comes from the hook payload / rules) and must be rendered with `textContent`, never `innerHTML` — no markup injection into the sandboxed page.
- **`state.json` is gitignored** (user-local runtime state). Writes are best-effort and never crash the pet.
- **Backward compatible:** every feature is gated by config that defaults to today's behavior where a default is meaningful (`clickThrough` defaults **on** per spec §6.3; `position` defaults to remember-last).
- The IPC surface may grow by **one** function (`setInteractive`, renderer→main, needed for click-through). Nothing else.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/state-store.js` | **New, pure-ish.** Load/save `state.json`; never throws |
| `src/config.js` | **Modify.** Add `position` and `clickThrough` keys |
| `src/main.js` | **Modify.** Restore/persist window position; forward `message`; wire click-through |
| `src/preload.js` | **Modify.** Add `setInteractive(bool)` |
| `src/renderer/index.html` | **Modify.** Add the speech-bubble element |
| `src/renderer/renderer.js` | **Modify.** Show bubbles, poke reaction, report hover for click-through |
| `src/renderer/styles.css` | **Modify.** Bubble and poke styles |
| `test/state-store.test.js` | Unit tests |
| `test/config.test.js` | **Modify.** Cover the new keys |

---

### Task 1: Position persistence

**Files:**
- Create: `src/state-store.js`
- Modify: `src/config.js`, `config.example.json`, `src/main.js`
- Test: `test/state-store.test.js`, `test/config.test.js`

**Interfaces:**
- `loadState(filePath) => { position: {x,y}|null }` — never throws; missing/malformed → `{ position: null }`
- `saveState(filePath, state) => void` — best-effort; never throws
- Config gains `position: {x,y}|null` (default `null` = remember last dragged position)

**Behavior:** on launch, an explicit `config.position` pins the window; otherwise the saved `state.json` position is restored; otherwise Electron centres it. When `config.position` is `null` (remember mode), the window's position is saved to `state.json` on every move (debounced).

- [ ] **Step 1: Write the failing test**

Create `test/state-store.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadState, saveState } = require('../src/state-store.js');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-state-')), 'state.json');
}

test('returns a null position when the file is missing', () => {
  assert.deepEqual(loadState(path.join(os.tmpdir(), 'no-such-state-4821.json')), { position: null });
});

test('round-trips a position', () => {
  const file = tmpFile();
  saveState(file, { position: { x: 100, y: 200 } });
  assert.deepEqual(loadState(file), { position: { x: 100, y: 200 } });
});

test('returns a null position for malformed json', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.deepEqual(loadState(file), { position: null });
});

test('returns a null position when position is not two integers', () => {
  const file = tmpFile();
  for (const bad of [{ position: { x: 1 } }, { position: [1, 2] }, { position: { x: 'a', y: 2 } }, {}]) {
    fs.writeFileSync(file, JSON.stringify(bad), 'utf8');
    assert.deepEqual(loadState(file), { position: null });
  }
});

test('saveState never throws on an unwritable path', () => {
  // A path whose parent does not exist and cannot be created silently.
  assert.doesNotThrow(() => saveState('/no/such/dir/deeper/state.json', { position: { x: 1, y: 2 } }));
});

test('saveState ignores a non-integer position rather than writing garbage', () => {
  const file = tmpFile();
  saveState(file, { position: { x: 1.5, y: 'nope' } });
  assert.deepEqual(loadState(file), { position: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/state-store.test.js`
Expected: FAIL — `Cannot find module '../src/state-store.js'`

- [ ] **Step 3: Write the store**

Create `src/state-store.js`:

```js
'use strict';

const fs = require('node:fs');

/** True for a plain {x, y} of two integers. */
function isPosition(p) {
  return (
    p !== null &&
    typeof p === 'object' &&
    !Array.isArray(p) &&
    Number.isInteger(p.x) &&
    Number.isInteger(p.y)
  );
}

/**
 * Load runtime state. Never throws: a missing, unreadable, or malformed file —
 * or one whose position is not two integers — yields `{ position: null }`.
 */
function loadState(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { position: null };
  }
  if (parsed === null || typeof parsed !== 'object') return { position: null };
  return { position: isPosition(parsed.position) ? { x: parsed.position.x, y: parsed.position.y } : null };
}

/**
 * Persist runtime state, best-effort. Never throws — a failed write just means
 * the pet forgets where it was, which must not crash it. A non-integer position
 * is dropped rather than written.
 */
function saveState(filePath, state) {
  const position = state && isPosition(state.position) ? { x: state.position.x, y: state.position.y } : null;
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({ position }, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

module.exports = { loadState, saveState, isPosition };
```

- [ ] **Step 4: Add the config keys**

In `src/config.js`, add to `DEFAULTS` (after `states`):

```js
  position: null,
  clickThrough: true,
```

Add to `VALIDATORS`:

```js
  position: (v) => v === null || (v !== null && typeof v === 'object' && !Array.isArray(v) && Number.isInteger(v.x) && Number.isInteger(v.y)),
  clickThrough: (v) => typeof v === 'boolean',
```

(Only `clickThrough` is used until Task 4, but adding both validators here keeps the config schema in one commit.)

Add both to `config.example.json`:

```json
  "position": null,
  "clickThrough": true,
```

Append to `test/config.test.js`:

```js
test('accepts an explicit position and rejects a malformed one', () => {
  assert.deepEqual(loadConfig(tempConfig('{"position":{"x":10,"y":20}}')).position, { x: 10, y: 20 });
  assert.equal(loadConfig(tempConfig('{"position":{"x":10}}')).position, null);
  assert.equal(loadConfig(tempConfig('{"position":[1,2]}')).position, null);
  assert.equal(loadConfig(tempConfig('{"position":"middle"}')).position, null);
});

test('clickThrough defaults on and rejects a non-boolean', () => {
  assert.equal(loadConfig(tempConfig('{}')).clickThrough, true);
  assert.equal(loadConfig(tempConfig('{"clickThrough":false}')).clickThrough, false);
  assert.equal(loadConfig(tempConfig('{"clickThrough":"yes"}')).clickThrough, true);
});
```

- [ ] **Step 5: Wire persistence into `src/main.js`**

Add near the requires:

```js
const { loadState, saveState } = require('./state-store.js');
```

Add module-level state:

```js
const STATE_PATH = path.join(PROJECT_ROOT, 'state.json');
let saveTimer = null;
```

Compute the initial window position before `createWindow`. Change the `BrowserWindow` construction so it takes an `x`/`y` when one is known:

```js
function initialPosition() {
  if (config.position) return config.position; // explicit pin
  const saved = loadState(STATE_PATH).position; // remember-last
  return saved || null;
}
```

In `createWindow`, spread the position into the options:

```js
  const pos = initialPosition();
  win = new BrowserWindow({
    width: config.width,
    height: config.height,
    ...(pos ? { x: pos.x, y: pos.y } : {}),
    transparent: true,
    // ...everything else unchanged...
  });
```

After the window is created (still in `createWindow`, after `setAlwaysOnTop`), persist moves when in remember mode:

```js
  // Remember where the user drags the pet, unless the position is pinned.
  if (!config.position) {
    win.on('moved', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        const [x, y] = win.getPosition();
        saveState(STATE_PATH, { position: { x, y } });
      }, 400);
    });
  }
```

Clear the debounce timer in `before-quit`, next to `clearInterval(tickTimer)`:

```js
  clearTimeout(saveTimer);
```

- [ ] **Step 6: Verify (controller)**

Run `npm test` (state-store + config tests pass). Then, with `npm start`, drag the pet, quit, and relaunch — it should reappear where it was left. With `"position": {"x":50,"y":50}` in `config.json`, it should always start at 50,50 and NOT persist drags.

- [ ] **Step 7: Commit**

```bash
git add src/state-store.js src/config.js config.example.json src/main.js test/state-store.test.js test/config.test.js
git commit -m "feat: remember the pet's dragged position in state.json"
```

---

### Task 2: Speech bubbles

**Files:**
- Modify: `src/main.js`, `src/renderer/index.html`, `src/renderer/renderer.js`, `src/renderer/styles.css`

**Interfaces:** the `state-change` payload gains an optional `message` (a short string). The renderer shows it in a bubble and auto-hides it.

**Why:** `Notification` hooks carry a message ("Allow bash?"), and `rules.js`/`done` events can too. Showing it turns the pet from an ambient indicator into one that says what it needs.

- [ ] **Step 1: Forward the message from `src/main.js`**

The event already carries `event.message` (validated and length-capped by the server in Phase 1). Attach it to the state change. In the `onEvent` handler, both the fast path and the rules path push a change — add the message to each.

Fast path (no rules):

```js
      if (!rules.active) {
        const change = machine.handleEvent(event, Date.now());
        if (change && event.message) change.message = event.message;
        pushStateChange(change);
        return;
      }
```

Rules path — after computing `change`, before pushing:

```js
      const payload = {
        ...change,
        message: event.message,
        behavior: { scalePulse: behavior.scalePulse, soundUri: soundCache.resolve(behavior.sound) },
      };
      pushStateChange(payload);
```

(`message` is `undefined` when the event had none; the renderer treats a falsy message as "no bubble".)

- [ ] **Step 2: Add the bubble element**

In `src/renderer/index.html`, add after `<div id="badge">`:

```html
    <div id="bubble" role="status" aria-live="polite"></div>
```

- [ ] **Step 3: Style it**

Append to `src/renderer/styles.css`:

```css
/* Speech bubble: shows an event's message briefly, above the pet. */
#bubble {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%) translateY(-6px);
  max-width: 88%;
  padding: 6px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.96);
  color: #1c2333;
  font-size: 12px;
  line-height: 1.3;
  text-align: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28);
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease, transform 160ms ease;
  word-break: break-word;
}
#bubble.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
#bubble::after {
  content: '';
  position: absolute;
  bottom: -5px;
  left: 50%;
  margin-left: -5px;
  border: 5px solid transparent;
  border-top-color: rgba(255, 255, 255, 0.96);
  border-bottom: 0;
}
```

- [ ] **Step 4: Show it in `src/renderer/renderer.js`**

Add a bubble reference and a helper at the top of the IIFE (beside `badge`):

```js
  const bubble = document.getElementById('bubble');
  let bubbleTimer = null;

  function showBubble(message) {
    if (!message) return;
    // textContent, never innerHTML: the message is untrusted (hook/rules text).
    bubble.textContent = message;
    bubble.classList.add('visible');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('visible'), 4000);
  }
```

Call it from `applyState`, after the badge is set:

```js
    showBubble(change.message);
```

- [ ] **Step 5: Verify (controller)**

`npm test` still green. With `npm start`, POST an event with a message and confirm the bubble shows the text and auto-hides:

```bash
curl -s -X POST http://127.0.0.1:4747/event -H "content-type: application/json" -d "{\"type\":\"needsInput\",\"message\":\"Allow bash command?\"}"
```

Also POST a message containing `<b>markup</b>` and confirm it renders as literal text (no bold), proving `textContent` safety.

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/renderer/index.html src/renderer/renderer.js src/renderer/styles.css
git commit -m "feat: show a speech bubble with the event message"
```

---

### Task 3: Click reactions

**Files:**
- Modify: `src/renderer/renderer.js`, `src/renderer/styles.css`

**Interfaces:** none new. Clicking the pet plays a brief "poke" wiggle, entirely in the renderer.

- [ ] **Step 1: Add the poke wiggle CSS**

Append to `src/renderer/styles.css`:

```css
/* Poke reaction: a quick wobble when the pet is clicked. */
#stage.poked {
  animation: poke 400ms ease-in-out;
}
@keyframes poke {
  0%, 100% { transform: scale(calc(var(--base-scale, 1) * var(--theme-scale, 1))) rotate(0deg); }
  25% { transform: scale(calc(var(--base-scale, 1) * var(--theme-scale, 1) * 1.06)) rotate(-5deg); }
  75% { transform: scale(calc(var(--base-scale, 1) * var(--theme-scale, 1) * 1.06)) rotate(5deg); }
}
```

- [ ] **Step 2: Trigger it on click in `src/renderer/renderer.js`**

Add after the renderers are mounted:

```js
  let pokeTimer = null;
  // A poke: clicking the pet plays a quick wobble. Purely cosmetic and local.
  stage.addEventListener('click', () => {
    stage.classList.remove('poked');
    void stage.offsetWidth; // restart the animation
    stage.classList.add('poked');
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(() => stage.classList.remove("poked"), 420);
  });
```

**Note:** the `poke` and `stagePulse` animations both target `#stage`'s `transform`. Only one runs at a time in practice (a poke is a deliberate user action, a pulse follows an event), and each keyframe fully specifies the transform and ends back at the composed rest scale, so they cannot leave `#stage` in a half-transformed state. If both classes are ever set together, the later-added animation wins per CSS rules — acceptable for a cosmetic wobble.

- [ ] **Step 3: Verify (controller)**

`npm test` green. With `npm start`, click the pet and confirm a wobble. Confirm it composes with `config.scale` (the pet does not jump to full size mid-wobble).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/renderer.js src/renderer/styles.css
git commit -m "feat: wobble the pet when it is clicked"
```

---

### Task 4: Click-through

**Files:**
- Modify: `src/preload.js`, `src/main.js`, `src/renderer/renderer.js`

**Interfaces:**
- Preload gains `setInteractive(isInteractive: boolean)` (renderer→main).
- When `config.clickThrough` is on, the window ignores mouse events over its transparent area and only captures them while the cursor is over the pet.

**How it works (the standard Electron desktop-pet recipe):** the window starts with `setIgnoreMouseEvents(true, { forward: true })` — clicks pass through, but mouse-move events are still delivered to the renderer. The renderer watches the cursor; when it enters the pet's rendered box it calls `setInteractive(true)` and main flips to `setIgnoreMouseEvents(false)` so the pet can be clicked and dragged; when it leaves, back to pass-through.

**Scope note:** hit-testing uses the pet element's bounding box, so clicks in the large transparent area *around* the pet pass through, while the pet's own (small) box is interactive. Per-pixel transparency *within* the pet's box is a future refinement; the box approximation is the common, robust desktop-pet behavior.

- [ ] **Step 1: Add the preload channel**

In `src/preload.js`, add to the `buddy` object:

```js
  /** Tell main whether the cursor is over the pet (drives click-through). */
  setInteractive(isInteractive) {
    ipcRenderer.send('set-interactive', Boolean(isInteractive));
  },
```

- [ ] **Step 2: Wire it in `src/main.js`**

Send the click-through flag to the renderer so it only reports hover when needed. Add `clickThrough` to the `assets` object sent at `did-finish-load` — simplest is a tiny separate send. After `win.webContents.send('assets', assets);` add:

```js
    win.webContents.send('interaction', { clickThrough: config.clickThrough });
```

Enable pass-through at startup when configured. In `app.whenReady().then(...)`, after `createTray(status)`:

```js
  if (config.clickThrough && win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  ipcMain.on('set-interactive', (_e, isInteractive) => {
    if (!config.clickThrough || !win || win.isDestroyed()) return;
    if (isInteractive) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });
```

- [ ] **Step 3: Report hover from `src/renderer/renderer.js`**

Add the interaction channel handler and the hover reporter:

```js
  let clickThrough = false;
  window.buddy.onInteraction((cfg) => {
    clickThrough = Boolean(cfg && cfg.clickThrough);
  });

  // While click-through is on, tell main whether the cursor is over the pet's
  // rendered box so it can toggle mouse capture. The window forwards mousemove
  // even while ignoring clicks, so this keeps firing.
  let overPet = false;
  document.addEventListener('mousemove', (e) => {
    if (!clickThrough) return;
    const el = active === sprite && sprite ? document.querySelector('.sprite') : document.querySelector('.buddy');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside !== overPet) {
      overPet = inside;
      window.buddy.setInteractive(inside);
    }
  });
```

Add `onInteraction` to the preload (Step 1) — it needs both a sender and a receiver:

```js
  /** Receive interaction config (whether click-through is active). */
  onInteraction(callback) {
    ipcRenderer.on('interaction', (_event, cfg) => callback(cfg));
  },
```

(So the preload grows by exactly two functions: `setInteractive` and `onInteraction`. Both are needed for this feature.)

- [ ] **Step 4: Verify (controller)**

`npm test` green. This one needs live verification: with `"clickThrough": true` (default), run `npm start`, then confirm — via the real window — that clicking the desktop *beside* the pet activates the item behind it, while clicking and dragging the pet still moves it. With `"clickThrough": false`, the whole window captures clicks as before.

Because screen-level click-through is hard to assert headlessly, the controller verifies the mechanism: that `set-interactive` toggles `setIgnoreMouseEvents` (via logging or a spy) and that hover detection fires as the cursor crosses the pet's box.

- [ ] **Step 5: Commit**

```bash
git add src/preload.js src/main.js src/renderer/renderer.js
git commit -m "feat: let clicks fall through the transparent area around the pet"
```

---

## Phase 3C Definition of Done

- [ ] `npm test` passes, no earlier test broken
- [ ] The pet reappears where it was dragged after a restart; an explicit `config.position` pins it
- [ ] An event message shows in a bubble and auto-hides; markup in a message renders as literal text
- [ ] Clicking the pet wobbles it, composing with the configured scale
- [ ] With `clickThrough` on, the transparent area passes clicks through; the pet stays draggable; `clickThrough:false` restores full capture
- [ ] The IPC surface grew by exactly `setInteractive` and `onInteraction`; hardening flags unchanged
- [ ] `package.json` still lists **electron and nothing else**

---

## Phase 3 complete

With 3A (rules.js), 3B (import-sprite), and 3C (interactions), the spec's deferred items are all delivered. Remaining ideas (multi-pet, autostart, packaged binary) are explicit non-goals in the design doc.
