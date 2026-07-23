# Claude Buddy — Design Document

**Date:** 2026-07-23
**Status:** Approved for planning
**Author:** Marc (with Claude)

---

## 1. Overview

**Claude Buddy** is a customizable desktop pet that reacts in real time to Claude Code activity. When Claude starts thinking, finishes a task, needs your permission, or hits an error, the pet plays a corresponding animation and optional sound — knocking to get your attention, celebrating a completed task, or dozing off when you walk away.

It is a small, dependency-light Electron app that runs **from source**, makes **zero outbound network connections**, and ships **no bundled character art**.

### Problem it solves

Claude Code often works for minutes at a time. You context-switch away, and either miss that it finished or miss that it's blocked waiting on a permission prompt. A glanceable, ambient, physically-present indicator solves this better than a notification toast that disappears.

---

## 2. Goals & Non-Goals

### Goals

- React to Claude Code lifecycle events with distinct visual states
- Work out of the box with **no art assets required** (procedural renderer)
- Support user-supplied sprite-sheet themes via a documented, validated contract
- Be programmable: declarative config for the common case, code escape-hatch for power users
- Play configurable sounds per state
- Be auditable and safe: minimal dependencies, no telemetry, no outbound network, no packaged binary

### Non-Goals (v1)

- Support for agents other than Claude Code (Codex, Gemini, etc.)
- Autostart on login
- A packaged/signed `.exe` installer
- Speech bubbles / message text rendering
- Multi-pet or multi-monitor choreography
- Bundled character artwork

---

## 3. Architecture

### 3.1 High-level data flow

```
┌─────────────────┐
│  Claude Code    │
│  (any terminal) │
└────────┬────────┘
         │ fires hook (Stop / Notification / UserPromptSubmit / SubagentStop)
         ▼
┌─────────────────┐
│ hooks/notify.js │  tiny zero-dep Node shim
│  node notify.js │  • reads hook JSON from stdin
│      done       │  • POSTs to localhost
└────────┬────────┘  • 1s timeout, ALWAYS exits 0
         │ HTTP POST 127.0.0.1:4747/event
         │ {"type":"done","message":"...","cwd":"..."}
         ▼
╔══════════════════════════════════════════════════╗
║  Electron MAIN process                           ║
║                                                  ║
║  server.js ──▶ config.js ──▶ state-machine.js    ║
║  (validate)    (map event)   (compute next state)║
║                                    │             ║
╚════════════════════════════════════│═════════════╝
                                     │ IPC: {state, sound, theme}
                                     ▼
╔══════════════════════════════════════════════════╗
║  Electron RENDERER process (sandboxed)           ║
║                                                  ║
║  renderer.js ──▶ renderers/procedural.js         ║
║              └─▶ renderers/sprite.js             ║
║              └─▶ sound.js                        ║
╚══════════════════════════════════════════════════╝
                     transparent, frameless,
                     always-on-top window
```

### 3.2 Why this shape

- **The shim, not raw `curl`.** Embedding escaped JSON inside a JSON settings file inside a shell command is unreadable and breaks differently on every shell. A 40-line Node script takes the event name as `argv[2]`, reads Claude Code's hook payload from stdin, and handles timeouts. It uses only `node:http` — no dependencies.
- **Hooks must never block Claude Code.** `notify.js` uses a 1-second timeout and **always exits 0**, even if the pet isn't running. A dead pet must never stall or fail your Claude session.
- **State logic lives in the main process, not the renderer.** The renderer only ever receives "you are now in state X." This keeps the state machine pure, testable without Electron or a DOM, and keeps the sandboxed renderer dumb.

---

## 4. Components

Each component has one job and a narrow interface.

| Module | Process | Responsibility | Depends on |
|---|---|---|---|
| `main.js` | main | Electron lifecycle, window creation, tray menu | electron |
| `server.js` | main | Listen on `127.0.0.1:<port>`, validate payloads, emit normalized events | `node:http` |
| `config.js` | main | Load + validate `config.json`, merge defaults, optionally load `rules.js` | `node:fs` |
| `state-machine.js` | main | **Pure.** `(currentState, event) → nextState`. Idle timeout, one-shot `next` transitions | *nothing* |
| `preload.js` | bridge | `contextBridge` — exposes exactly one subscribe function | electron |
| `renderer.js` | renderer | Receive state changes, select + drive active renderer | — |
| `renderers/procedural.js` | renderer | Draw + animate the default blob character in CSS/Canvas | — |
| `renderers/sprite.js` | renderer | Play sprite sheets / animated files from a theme | — |
| `theme.js` | renderer | Load + validate `theme.json`, resolve state → asset | — |
| `sound.js` | renderer | Play audio on state entry, respect mute/volume | — |
| `tools/validate-theme.js` | CLI | Standalone theme validator with actionable errors | `node:fs` |

### 4.1 Key interfaces

**Normalized event** (what `server.js` emits):

```ts
{
  type: "thinking" | "working" | "done" | "needsInput" | "subagent" | "error",
  message?: string,   // optional context from the hook payload
  cwd?: string,       // which project fired it
  at: number          // timestamp
}
```

**State change** (what crosses IPC to the renderer):

```ts
{
  state: string,      // resolved state name
  loop: boolean,
  next: string|null,  // auto-transition target for one-shots
  sound: string|null, // resolved absolute path, or null
  theme: string       // active theme name, or "procedural"
}
```

That is the **entire** IPC surface. The renderer cannot invoke anything else.

---

## 5. State machine

### 5.1 States

Eight states. Seven are event- or timer-driven and land in v1; `working` is defined in the contract but its **trigger** is deferred (see §13) so theme authors have a stable slot to draw for.

| State | Triggered by | Loop | On finish |
|---|---|:--:|---|
| `idle` | default / fallback | ✅ | — |
| `thinking` | `UserPromptSubmit` hook | ✅ | — |
| `working` | sustained activity (`PreToolUse`, optional) | ✅ | — |
| `done` | `Stop` hook | ❌ | → `idle` |
| `needsInput` | `Notification` hook | ✅ | stays until next event |
| `subagent` | `SubagentStop` hook | ❌ | → `thinking` |
| `error` | `Stop` hook with error flag | ❌ | → `idle` |
| `sleeping` | **no hook** — idle timeout (default 10 min) | ✅ | → `idle` on any event |

### 5.2 Rules

- Any incoming event **interrupts** the current animation immediately. Responsiveness beats animation integrity.
- `sleeping` is driven purely by a timer in `state-machine.js`; it requires no hook wiring at all.
- Unknown event types are logged and **ignored** — never crash, never fall to a random state.
- If a state is not defined in the active theme, it **falls back to `idle`**.

---

## 6. Configuration model

Two layers. The declarative one is always used; the code one is entirely optional.

### 6.1 `config.json` (the 90% case)

```jsonc
{
  "port": 4747,
  "token": null,              // optional shared secret; null = no auth (localhost only)
  "theme": "procedural",      // "procedural" or a folder name under themes/
  "scale": 1.0,
  "position": { "x": null, "y": null },   // null = remember last drag
  "alwaysOnTop": true,
  "clickThrough": true,       // see 6.3 — transparent areas only
  "idleTimeoutMinutes": 10,

  "sound": {
    "enabled": true,
    "volume": 0.5
  },

  "states": {
    "done":       { "sound": "sounds/tada.mp3",   "scalePulse": 1.4 },
    "needsInput": { "sound": "sounds/knock.mp3",  "scalePulse": 1.2 },
    "error":      { "sound": "sounds/uhoh.mp3" },
    "thinking":   { "sound": null },
    "sleeping":   { "sound": null }
  }
}
```

### 6.2 `rules.js` (optional escape hatch)

Loaded **only if the file exists**. Receives the full event and the config-derived default behavior, and may return an override.

```js
// rules.js — runs in the MAIN process. Your own local file. Never auto-updated.
module.exports = function rules(event, defaultBehavior) {
  // Silence the pet late at night
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) return { ...defaultBehavior, sound: null };

  // Extra-loud celebration when tests pass
  if (event.type === "done" && /tests? passed/i.test(event.message ?? "")) {
    return { ...defaultBehavior, sound: "sounds/fanfare.mp3", scalePulse: 2.0 };
  }

  // Ignore events from a noisy scratch project
  if (event.cwd?.includes("scratch")) return null;   // null = do nothing

  return defaultBehavior;
};
```

**Contract:** returning `null` suppresses the event entirely. Any thrown error is caught, logged, and falls back to `defaultBehavior` — a broken `rules.js` degrades to stock behavior rather than killing the pet.

### 6.3 Defined config terms

| Term | Meaning |
|---|---|
| `theme: "procedural"` | Reserved theme name. Selects the built-in blob renderer; never resolved as a folder under `themes/`. |
| `scalePulse` | Multiplier applied to the pet's rendered size on entering a state, easing back to `scale` over the animation. `1.4` = briefly grows 40%. This is the "enlarging itself" attention behavior. Applies to **both** renderers; omit or set `1.0` for none. |
| `clickThrough` | When `true`, **fully transparent pixels** pass clicks to the window beneath. The pet's own body always remains interactive — dragging to reposition and (post-v1) click reactions keep working. When `false`, the entire window rectangle captures clicks. |
| `position: null` | Use the last dragged position, persisted to `state.json` on move. Explicit `{x, y}` pins the pet and disables persistence. |

---

## 7. Theme contract

### 7.1 Layout

Art moves through two tiers: **committed masters** and **generated runtime themes**.

```
assets/sprites/<name>/       ← MASTER art. Committed. Owned by this repo.
  Sleeping.png                  full-resolution source sheet, true alpha
                                    │
                                    │  npm run import-sprite
                                    ▼
themes/                      ← BUILD OUTPUT. Gitignored; ships empty.
  _template/                 ← committed exception: our own placeholder art
    theme.json                  fully commented reference manifest
    _layout-guide.png           labelled frame-geometry guide
    idle.png
  mochi/                     ← generated from assets/sprites/mochi/
    theme.json
    sleeping.png
```

**Why the split.** Masters are authored once and version-controlled; runtime
themes are derived, regenerable, and therefore never committed. This also means
third-party art a user drops into `themes/` is structurally impossible to
redistribute by accident — the gitignore enforces the licensing policy rather
than relying on discipline.

Only art the project owns may live in `assets/`. See `assets/README.md`.

### 7.2 `theme.json`

```jsonc
{
  "name": "My Pet",
  "author": "you",
  "license": "CC0-1.0",
  "frame": { "width": 128, "height": 128 },
  "anchor": "bottom-center",
  "scale": 1,

  "states": {
    // Simple case: horizontal strip
    "idle":       { "sheet": "idle.png",     "frames": 4, "fps": 6,  "loop": true },
    "thinking":   { "sheet": "thinking.png", "frames": 6, "fps": 10, "loop": true },
    "working":    { "sheet": "working.png",  "frames": 8, "fps": 12, "loop": true },
    "done":       { "sheet": "done.png",     "frames": 6, "fps": 12, "loop": false, "next": "idle" },
    "needsInput": { "sheet": "knock.png",    "frames": 4, "fps": 8,  "loop": true  },
    "subagent":   { "sheet": "blip.png",     "frames": 3, "fps": 12, "loop": false, "next": "thinking" },
    "error":      { "sheet": "error.png",    "frames": 4, "fps": 8,  "loop": false, "next": "idle" },

    // Grid sheet with multiple animation variants (real example: Mochi)
    "sleeping": {
      "sheet": "sleeping.png",
      "grid":  { "cols": 8, "rows": 4 },
      "fps": 4,
      "loop": true,
      "variants": [[0, 7], [8, 15], [16, 23], [24, 31]],
      "variantPick": "random"
    }
  }
}
```

Single-file alternative for any state:

```jsonc
"done": { "gif": "done.gif", "loop": false, "next": "idle" }   // .gif / .apng / .webp
```

### 7.3 Sheet layout

Two layouts are supported. Frames are indexed **0-based in reading order** (left → right, then top → bottom) in both.

**Strip** — `"frames": N`. Sheet width must equal `N × frame.width`.

**Grid** — `"grid": { "cols": C, "rows": R }`. Sheet dimensions must equal `C × frame.width` by `R × frame.height`. Total frames = `C × R`.

`frame.width`/`frame.height` may be **omitted when using a grid** — they are derived as `sheetWidth / cols` and `sheetHeight / rows`. Supplying them anyway makes the validator cross-check.

### 7.4 Ranges and variants

- `"range": [from, to]` — play only a sub-range of frames. Lets one sheet serve several states.
- `"variants": [[from,to], ...]` — several interchangeable animations for the *same* state.
  - `"variantPick": "random"` (default) — choose one on each entry into the state
  - `"variantPick": "sequential"` — advance through variants in order on each entry

Variants exist because a pet that plays the *identical* animation every time reads as mechanical. Four sleep poses picked at random make the same asset feel alive at zero runtime cost.

### 7.5 Image requirements

- **PNG-32 with true alpha.** No matte color, no white background, and no *baked-in checkerboard* — a checkerboard means the file is a screenshot of a transparent image, not a transparent image.
- Semi-transparent pixels are fine and encouraged (drop shadows, motion blur).
- **Uniform padding across all frames.** Do not tightly crop each frame independently.
- Character anchored **bottom-center** so states align when swapping mid-animation.
- Leave deliberate headroom for above-character effects (`zzz` puffs, exclamation marks). This padding is part of the frame geometry and must be consistent sheet-wide.

**Trimming rule (implementation):** when the importer trims whitespace, it must compute a **single union bounding box across every frame** and apply it uniformly. Per-frame trimming makes the character jitter as its silhouette changes between frames — a subtle bug that is very hard to diagnose after the fact.

### 7.6 File naming

State keys are **case-sensitive** and lowercase-camel (`needsInput`, `sleeping`). Referenced filenames must match on disk **exactly**, including case. Windows will forgive `Sleeping.png` vs `sleeping.png`; Linux and case-sensitive macOS volumes will not. The validator flags case mismatches as errors, not warnings.

### 7.7 Graceful degradation

- `idle` is the **only required state**. A one-file theme is valid.
- Missing states fall back to `idle`.
- A missing or invalid `theme.json` falls back to the **procedural** renderer, with a tray warning.
- Missing sound files are skipped silently with a log line.

### 7.8 Tooling

**`theme.schema.json`** — JSON Schema for editor autocomplete and validation.

**`npm run validate-theme themes/my-pet`** — checks sheet geometry against `grid`/`frames`, alpha channel presence, range/variant bounds, unknown state names, filename case mismatches, and missing files. Actionable messages, not stack traces.

**`npm run import-sprite`** — normalizes messy source art into a conforming sheet. This is the project's "accept messy input at one boundary" stage; the runtime only ever consumes conforming PNG-32.

```bash
npm run import-sprite -- assets/sprites/mochi/Sleeping.png \
    --grid 8x4 --out themes/mochi/sleeping.png
```

Capabilities:

| Flag | Purpose |
|---|---|
| *(input)* | Accepts PNG, JPG, or WebP |
| `--grid CxR` | Declare grid layout; omit to auto-detect from transparent gutters |
| `--key checker` | Remove a **baked-in checkerboard** (tolerance-based, survives JPG artifacts) |
| `--key #RRGGBB` / `--key auto` | Remove a solid background colour (`auto` samples the corner pixel) |
| `--trim-guides` | Strip authoring separator lines between cells |
| `--trim` | Uniform union-bounding-box crop across all frames (see §7.5) |
| `--out` | Destination; also emits a `theme.json` stub with geometry pre-filled |

Conversion happens **once at import**, never in the render loop. Chroma-keying 32 frames every animation cycle would be wasted work forever, and doing it offline lets the author inspect and correct the result before it ships.

> **Note on lossy sources:** JPG is the worst format for pixel art — its compression produces ringing artifacts precisely at hard colour boundaries. `--key checker` recovers usable output, but always prefer an original with a true alpha channel.

**`docs/THEMES.md`** — authoring walkthrough.

---

## 8. Security model

Security is a design constraint, not a later hardening pass. The threat we care about is **supply chain and silent behavior**, not a targeted attacker.

| Risk | Mitigation |
|---|---|
| Supply-chain compromise via npm | **Electron is the only runtime dependency.** HTTP via `node:http` (no Express), animation via CSS/Canvas (no animation libs), audio via native `Audio`. Dependency count is auditable at a glance. |
| Unsigned binary flagged by Defender/SmartScreen | **Ship no binary.** Run from source with `npm start`. No packaging, no reputation check, no opaque executable. |
| Local server reachable from the network | Bind strictly to **`127.0.0.1`**, never `0.0.0.0`. Optional `token` in config, required as a header when set. |
| Renderer process compromise | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, `webSecurity` on. Window loads **local files only** — never remote content. |
| Arbitrary code execution via config | `rules.js` is a local user-authored file, never fetched, never auto-updated, and entirely optional. Themes are data (JSON + images), not code. |
| Silent / hidden behavior | **No autostart. No telemetry. No outbound network connections, ever.** The app only *listens*. Visible tray icon at all times. |
| Malicious hook payload | Payloads are validated against a strict allowlist of event types; unknown fields are dropped; body size capped. Malformed input returns `400` and is ignored. |

**The verifiable claim:** Claude Buddy makes zero outbound connections. You can confirm this by reading the source or watching it with any network monitor.

---

## 9. Error handling

| Failure | Behavior |
|---|---|
| Pet not running when a hook fires | `notify.js` times out after 1s and exits 0. Claude Code is never blocked or failed. |
| Configured port already in use | Fail loudly at startup: tray warning + clear console message naming the port. Do **not** silently pick another port — hooks would be pointing at the wrong one. |
| Malformed / oversized request body | Respond `400`, log, ignore. Never crash. |
| Unknown event type | Log and ignore. Stay in current state. |
| `config.json` missing or invalid | Fall back to built-in defaults; tray warning. App always starts. |
| `rules.js` throws | Catch, log, use `defaultBehavior`. |
| Theme invalid / missing assets | Fall back to `idle`, then to the procedural renderer. Tray warning. |
| Sound file missing | Skip silently, log once. |

**Principle:** the pet must *always* start and *always* render something. Every failure degrades toward the procedural blob rather than toward a blank screen.

---

## 10. Testing strategy

| Layer | Approach |
|---|---|
| `state-machine.js` | **Pure unit tests.** No Electron, no DOM. Table-driven: event × current state → expected next state. Covers idle timeout, one-shot `next`, interrupts, unknown events. |
| `config.js` | Unit tests over fixture configs: valid, invalid, missing, partial. Assert defaults merge correctly and `rules.js` errors are contained. |
| `tools/validate-theme.js` | Unit tests over good/bad theme fixtures — wrong frame count, bad geometry, missing alpha, unknown state names. |
| `server.js` | Integration tests firing real HTTP requests at a live listener: valid event, malformed JSON, oversized body, wrong token, unknown type. |
| `hooks/notify.js` | Integration test asserting **exit code 0** when no server is listening, and that it terminates within the timeout. |
| Renderer | Manual/visual, aided by a dev-only `/debug` page with buttons to fire each state. Sprite playback verified against `themes/_template`. |

The critical automated tests are the state machine and `notify.js` exit code — those are the two places a bug would be either invisible or actively disruptive to a Claude session.

---

## 11. Hook wiring

Added to `~/.claude/settings.json`. Each hook is one line, with the event name as an argument:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"D:/Minxus Sphinxus/Claude Buddy/hooks/notify.js\" thinking" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"D:/Minxus Sphinxus/Claude Buddy/hooks/notify.js\" done" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node \"D:/Minxus Sphinxus/Claude Buddy/hooks/notify.js\" subagent" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node \"D:/Minxus Sphinxus/Claude Buddy/hooks/notify.js\" needsInput" }] }
    ]
  }
}
```

A `npm run install-hooks` helper will merge these into the user's settings file non-destructively, and print them for manual review first.

---

## 12. Build order

1. **Skeleton** — Electron transparent, frameless, always-on-top, draggable window + tray menu
2. **Procedural renderer** — the blob, with `idle` animation only
3. **State machine** — pure module + full unit tests
4. **HTTP server** — validated `/event` endpoint wired to the state machine
5. **`notify.js` shim** + hook installation helper — end-to-end: Claude finishes → pet reacts
6. **Remaining states** — procedural animations for all 7 + idle timeout `sleeping`
7. **Config layer** — `config.json`, defaults, then optional `rules.js`
8. **Sound** — per-state audio, volume, mute
9. **Theme system** — `theme.json` loader, sprite renderer (strip + grid), ranges, variants, fallback chain
10. **Theme tooling** — schema, `validate-theme`, `import-sprite`, `_template` theme, `docs/THEMES.md`

**First real theme:** `themes/mochi/` — a pixel-art beagle. `sleeping.png` (1920×1080, 8×4 grid, 240×270 frames, 4 sleep-pose variants) already exists and is the reference asset that drives steps 9–10.

Steps 1–5 constitute the **minimum viable buddy**: a reacting pet. Everything after is enrichment along axes that don't block each other.

---

## 13. Open questions

None blocking. Deferred decisions:

- **Project license** — MIT vs AGPL-3.0. No dependency on this for implementation; decide before publishing.
- **`working` state trigger** — whether to wire `PreToolUse` or derive it from elapsed time since `thinking`. Defer until the base loop feels right in practice.
- **Click interactions** — poking the pet to trigger a reaction. Post-v1.
- **Speech bubbles** — the `/event` payload already carries `message`, so the door is open. Post-v1.
