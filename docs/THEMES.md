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

One-shot states should set `"loop": false`:

```jsonc
"done": { "sheet": "done.png", "frames": 6, "fps": 12, "loop": false }
```

Which state follows a one-shot is decided by Claude Buddy itself, not by the
theme — `done` and `error` return to `idle`, and `subagent` returns to
`thinking`. A theme controls how a state *looks*, never what happens next.

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

The repo includes master sheets at `assets/sprites/mochi/`. They all use
240x270 frames sharing a baseline of y=250 within each cell, so the character
never jumps vertically when states swap — which is why none of them needs an
`offset`.

| Sheet | Layout | State | Animation |
|---|---|---|---|
| `idle.png` | 8x1 | `idle` | Sitting; ear flick, then a blink |
| `working.png` | 8x1 | `working` | Digging, dirt flying |
| `error.png` | 8x1 | `error` | Ears flatten, head lowers, curls up |
| `sleeping.png` | 8x4 | `sleeping` | 4 sleep-pose variants, chosen at random |

Build the runtime theme from them:

```bash
mkdir -p themes/mochi
cp assets/sprites/mochi/idle.png     themes/mochi/idle.png
cp assets/sprites/mochi/working.png  themes/mochi/working.png
cp assets/sprites/mochi/error.png    themes/mochi/error.png
cp assets/sprites/mochi/sleeping.png themes/mochi/sleeping.png
cp assets/sprites/mochi/theme.json   themes/mochi/theme.json
npm run validate-theme -- themes/mochi
```

Then set `"theme": "mochi"` in `config.json`.

Mochi defines four of the eight states. The other four — `thinking`, `done`,
`needsInput` and `subagent` — fall back to `idle`, so the pet stays a beagle at
all times rather than switching to the procedural blob mid-session.

Note the lowercase filenames. `theme.json` references `sleeping.png`, and a
case-sensitive filesystem will not accept `Sleeping.png` in its place.

## Importing messy art

Source art rarely arrives theme-ready: SVGs wrap raster data behind masks, JPGs
bake in a checkerboard where the transparency should be, and hand-laid-out
sheets have rows that do not sit on a fixed grid. `tools/import-sprite.js` is a
build-time CLI (run under Electron, since it needs a real canvas for SVG
rasterization, `getImageData`, and `toDataURL`) that normalizes source art into
a conforming PNG-32 sheet plus a `theme.json` stub:

```bash
npm run import-sprite -- <input> [options]
```

`<input>` may be `.svg`, `.png`, `.jpg`, `.jpeg`, or `.webp`. Pick one of two
modes:

- `--grid CxR` — the input is already laid out as a `C x R` grid; each cell is
  normalized in place (content re-centred and baselined) at the derived frame
  size. Use this for art that is gridded but whose content wobbles cell to
  cell.
- `--rows N` — auto-detect mode: find `N` sprite rows by alpha bands, then the
  frames within each row, and re-composite everything onto a clean grid. Use
  this when the source rows do not sit on a fixed grid at all.

`--key MODE` strips a background before processing:

- `checker` — a baked light/dark checkerboard
- `auto` — the solid colour of the top-left pixel
- `#RRGGBB` — a specific solid colour

Other options: `--baseline N` (content-bottom target within each cell, default
`cellH - 20`), `--scale S` (written into the `theme.json` stub, default `1`),
`--name NAME` (theme name in the stub, default: input basename), `--out PATH`
(output PNG path, default `<input dir>/<basename>.png`).

The tool writes the sheet, self-checks it with `readPngHeader`, and prints the
grid it produced. The emitted `theme.json` is only a **stub** — every frame is
mapped to a single `idle` state spanning the whole sheet. Edit the `states` map
by hand afterward to assign frame ranges (`range`, `variants`) to the states
your theme actually needs; see "Ranges and variants" above.

## Licensing

Only art the project owns belongs in `assets/`. Anything you did not create
belongs in `themes/`, which is gitignored — see [`../assets/README.md`](../assets/README.md).
