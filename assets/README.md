# Assets

Master source art for Claude Buddy.

## Provenance & licensing

All artwork in this directory was **created by the repository owner** and is
distributed under the same license as this project. No third-party or
asset-pack art is included here.

Claude Buddy deliberately ships **no** artwork it does not own. If you add art
you did not create, put it in `themes/` (gitignored) rather than here, so it is
never redistributed by this repository.

## Layout

```
assets/
  sprites/
    <character>/
      <State>.png      master sheets, full resolution, true alpha
```

These are **masters**, not runtime assets. `npm run import-sprite` normalizes
them into `themes/<character>/`, which is gitignored and regenerable.

## Requirements for master sheets

- PNG-32 with a true alpha channel (semi-transparent pixels welcome)
- No baked-in checkerboard, matte colour, or cell separator guides
- Uniform padding across all frames — do not crop frames individually
- Character anchored bottom-center, with headroom reserved for effects
  such as `zzz` puffs

See [`docs/superpowers/specs`](../docs/superpowers/specs) §7 for the full theme
contract.

## Inventory

All Mochi sheets use **240×270 frames** and share a **baseline of y=250** within
each cell, so the character does not jump vertically when states swap.

| Sheet | Size | Layout | State | Contents |
|---|---|---|---|---|
| `idle.png` | 1920×270 | 8×1 | `idle` | Sitting; ear flick, then a blink |
| `working.png` | 1920×270 | 8×1 | `working` | Digging, dirt flying |
| `error.png` | 1920×270 | 8×1 | `error` | Ears flatten → head lowers → curls up |
| `sleeping.png` | 1920×1080 | 8×4 | `sleeping` | 4 sleep-pose variants, 8 frames each |
| `drowsy.png` | 1920×270 | 8×1 | *(unassigned)* | Sitting, ears droop, eyes close |

### `_raw/`

The original generated SVGs, kept for provenance. They wrap raster data behind
`feColorMatrix` luminance masks, so the PNGs above were produced by rendering
them through a browser engine and re-compositing each detected sprite band onto
a clean grid at the shared baseline. Extracting the embedded PNGs directly would
yield opaque images with no transparency.
