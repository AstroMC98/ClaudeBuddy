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
