# Claude Buddy

A customizable desktop pet that reacts in real time to Claude Code activity.

When Claude starts thinking, finishes a task, needs your permission, or hits an
error, the pet plays a matching animation — waving when it's done, knocking to
get your attention, dozing off when you walk away.

**Phase 1** ships a working, reacting pet with a procedurally-drawn character.
Sounds, sprite themes, and a programmable rules layer are Phase 2.

## How it works

```
Claude Code hook
   └─ hooks/notify.js            zero-dependency shim, always exits 0
        └─ POST 127.0.0.1:4747/event
             └─ src/server.js          validate + normalize untrusted input
                  └─ src/state-machine.js   decide the next state
                       └─ IPC 'state-change'
                            └─ src/renderer/     animate
```

The renderer reports back on `animation-ended` so one-shot animations
(`done`, `error`, `subagent`) settle to their resting state.

## Requirements

- **Node.js 20 or newer** (developed on 24)
- Electron is the only dependency, installed by `npm install`

## Setup

```bash
npm install
npm start          # the pet appears
```

You should get a transparent, always-on-top blob that breathes and blinks.
Drag it anywhere. Quit from the tray icon.

### Connect it to Claude Code

Preview the change first — this **only prints**, it writes nothing:

```bash
npm run install-hooks
```

If the output looks right, apply it:

```bash
npm run install-hooks -- --write
```

This merges four hook entries into `~/.claude/settings.json`. It is
non-destructive and idempotent: unrelated settings and unrelated hooks are
preserved, re-running does not duplicate entries, and the previous file is
backed up to `settings.json.buddy-backup` (a second run backs up to
`.buddy-backup.2` rather than overwriting the first).

Restart Claude Code afterwards.

| Claude Code hook | Buddy state | What you see |
|---|---|---|
| `UserPromptSubmit` | `thinking` | breathes faster |
| `Stop` | `done` | jumps and squashes, then settles |
| `SubagentStop` | `subagent` | brief blip |
| `Notification` | `needsInput` | rocks side to side until you respond |
| *(idle timer)* | `sleeping` | dims, closes its eyes, floats a `z` |

## Configuration

Copy `config.example.json` to `config.json` and edit. Every key is validated;
anything missing, unknown, or wrong-typed falls back to its default rather than
breaking the app.

| Key | Default | Meaning |
|---|---|---|
| `port` | `4747` | Loopback port the pet listens on |
| `token` | `null` | Optional shared secret; when set, hooks must send it |
| `idleTimeoutMinutes` | `10` | Inactivity before the pet falls asleep |
| `scale` | `1.0` | Size multiplier (max 8) |
| `alwaysOnTop` | `true` | Float above other windows |
| `width` / `height` | `320` | Window size in pixels (max 4096) |

Two environment variables override the config file, mainly for testing:
`CLAUDE_BUDDY_PORT` and `CLAUDE_BUDDY_TOKEN`.

## Security

This app runs continuously and listens on a socket, so its posture is
deliberate and auditable:

- **No outbound network connections, ever.** It only listens. No telemetry, no
  update checks, no remote assets or fonts.
- **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0`.
- **Requests carrying an `Origin` header are refused**, and a JSON content type
  is required — so a web page cannot drive the pet via a `no-cors` request.
- **Runs from source.** No packaged, unsigned binary, which is what usually
  trips Windows Defender and SmartScreen on apps like this.
- **Near-zero dependencies.** Electron and nothing else — no Express, no test
  framework, no animation library. The whole tree is small enough to read.
- **Renderer is sandboxed:** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, strict CSP, local files only. The entire IPC surface is two
  functions.
- **No autostart.** It runs when you run it.

Setting `token` in `config.json` additionally requires every hook request to
present it, which is worth doing on a shared machine.

## Development

```bash
npm test        # 75 tests, built-in node:test runner — no framework
npm start       # run the app
```

The state machine, HTTP server, config loader, and hook shim are all testable
without Electron, which is where the test coverage lives. Window creation and
CSS animation are verified by hand.

## Themes

The renderer is pluggable — Phase 2 adds sprite-sheet themes. The contract is
documented in
[`docs/superpowers/specs/2026-07-23-claude-buddy-design.md`](docs/superpowers/specs/2026-07-23-claude-buddy-design.md) §7.

Art you did not create belongs in `themes/`, which is gitignored, so it can
never be redistributed by this repository. Master art the project owns lives in
`assets/sprites/`. See [`assets/README.md`](assets/README.md).
