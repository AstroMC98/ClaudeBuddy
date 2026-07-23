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

| Character | Sheet | Size | Layout | Frame | Contents |
|---|---|---|---|---|---|
| Mochi (beagle) | `Sleeping.png` | 1920×1080 | 8×4 grid | 240×270 | 4 sleep-pose variants, 8 frames each |
