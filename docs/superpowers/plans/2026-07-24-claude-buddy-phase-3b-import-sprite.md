# Claude Buddy — Phase 3B (import-sprite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI that normalizes messy source art — a `feColorMatrix`-masked SVG, a JPG with a baked checkerboard, a sheet whose rows don't sit on the grid — into a theme-conforming PNG-32 sheet plus a `theme.json` stub, so the theme system (Phase 2) can consume it.

**Architecture:** The band-detection and placement math is a pure module tested with synthetic alpha profiles. The rendering, chroma-keying, compositing, and file output run in an Electron process, because that is where a real canvas (SVG rasterization, `getImageData`, `toDataURL`) lives. The tool re-composites each detected sprite onto a clean grid at a shared baseline — the exact operation that rescued the Mochi sheets by hand.

**Tech Stack:** Electron 43 (for the canvas), Node 24, `node:test`. No new dependencies.

**Scope:** Spec §7.8 (`import-sprite`), deferred from Phase 2. This is Phase 3, sub-plan B of three.

**Spec:** [`docs/superpowers/specs/2026-07-23-claude-buddy-design.md`](../specs/2026-07-23-claude-buddy-design.md) §7

## Global Constraints

- **Electron is the ONLY entry in `package.json` dependencies/devDependencies.** No image library. The canvas is Electron's.
- **Tests run via `npm test` → `node --test test/*.js`.** The pure module is tested there. The Electron CLI is verified by the controller running it on the real Mochi SVGs.
- `'use strict';` and CommonJS throughout.
- **This is a build-time tool, not part of the running pet.** It is never `require`d by `src/main.js` or the renderer; it does not touch the HTTP server, state machine, or hardening surface.
- **Output must pass `validate-theme`.** The tool's whole purpose is producing conforming sheets; a sheet it emits, referenced by the stub it emits, must validate.
- **Input paths come from the CLI, not a network.** No outbound connections. Output is written only under the path the user specifies.
- **Environment note:** this shell has `ELECTRON_RUN_AS_NODE` set, which breaks `require('electron')`. Electron runs are prefixed `env -u ELECTRON_RUN_AS_NODE`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/image-bands.js` | **New, pure.** Detect contiguous bands in a 1-D alpha profile; frame geometry; baseline placement math |
| `tools/import-sprite.js` | **New.** Electron CLI: render → optional chroma-key → detect/slice → re-composite → write PNG + stub |
| `docs/THEMES.md` | **Modify.** Document `import-sprite` in the tooling section |
| `test/image-bands.test.js` | Unit tests over synthetic profiles |

**Dependency direction:** `image-bands.js` imports nothing and is pure. `tools/import-sprite.js` imports `image-bands.js` and `electron`; it may import `src/png.js` (`readPngHeader`) to self-check its own output. `src/` never imports `tools/`.

---

### Task 1: Pure band detection and placement math

**Files:**
- Create: `src/image-bands.js`
- Test: `test/image-bands.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `detectBands(profile, { minRun = 1, mergeGap = 0 }) => Array<[start, end]>` — contiguous runs of non-zero values in a 1-D array, small gaps merged, short runs dropped. Inclusive indices.
  - `gridGeometry(sheetW, sheetH, cols, rows) => { frameW, frameH, exact }` — even frame size; `exact` is false when the sheet does not divide evenly.
  - `baselineTop(bandTop, bandBottom, cellHeight, baseline) => number` — the y at which to draw a band of the given extent so its content bottom lands on `baseline` within a cell of `cellHeight`. Clamped so nothing is drawn above the cell.
  - `centeredLeft(bandLeft, bandRight, cellWidth) => number` — the x to draw a band so it is horizontally centred in a cell.

- [ ] **Step 1: Write the failing test**

Create `test/image-bands.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectBands, gridGeometry, baselineTop, centeredLeft } = require('../src/image-bands.js');

test('detects a single contiguous band', () => {
  // profile: zeros, then content at 2..5, then zeros
  const profile = [0, 0, 3, 4, 5, 2, 0, 0];
  assert.deepEqual(detectBands(profile, {}), [[2, 5]]);
});

test('detects multiple bands separated by gaps', () => {
  const profile = [1, 1, 0, 0, 0, 2, 2, 0, 3];
  assert.deepEqual(detectBands(profile, {}), [[0, 1], [5, 6], [8, 8]]);
});

test('merges bands separated by a gap no larger than mergeGap', () => {
  const profile = [1, 1, 0, 1, 1]; // gap of 1 at index 2
  assert.deepEqual(detectBands(profile, { mergeGap: 1 }), [[0, 4]]);
  assert.deepEqual(detectBands(profile, { mergeGap: 0 }), [[0, 1], [3, 4]]);
});

test('drops runs shorter than minRun', () => {
  const profile = [1, 0, 1, 1, 1, 0, 1]; // runs of length 1, 3, 1
  assert.deepEqual(detectBands(profile, { minRun: 2 }), [[2, 4]]);
});

test('returns an empty list for an all-zero profile', () => {
  assert.deepEqual(detectBands([0, 0, 0], {}), []);
  assert.deepEqual(detectBands([], {}), []);
});

test('handles a band running to the end of the profile', () => {
  assert.deepEqual(detectBands([0, 0, 1, 1], {}), [[2, 3]]);
});

test('gridGeometry derives an even frame size', () => {
  assert.deepEqual(gridGeometry(1920, 1080, 8, 4), { frameW: 240, frameH: 270, exact: true });
});

test('gridGeometry reports a sheet that does not divide evenly', () => {
  const g = gridGeometry(1921, 1080, 8, 4);
  assert.equal(g.frameW, 240); // Math.floor
  assert.equal(g.exact, false);
});

test('baselineTop places a band so its bottom sits on the baseline', () => {
  // band is 100px tall (top..bottom = 0..99); cell 270; baseline 250
  // draw so content bottom = 250 -> top at 250 - 100 = 150
  assert.equal(baselineTop(0, 99, 270, 250), 150);
});

test('baselineTop clamps so content never starts above the cell', () => {
  // a band taller than the baseline would go negative; clamp to 0
  assert.equal(baselineTop(0, 299, 270, 250), 0);
});

test('centeredLeft centres a band horizontally in the cell', () => {
  // band 100 wide (0..99) in a 240 cell -> left = (240-100)/2 = 70
  assert.equal(centeredLeft(0, 99, 240), 70);
});

test('centeredLeft rounds to a whole pixel', () => {
  // band 99 wide (0..98) in 240 -> (240-99)/2 = 70.5 -> 70 or 71, must be integer
  const left = centeredLeft(0, 98, 240);
  assert.equal(Number.isInteger(left), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/image-bands.test.js`
Expected: FAIL — `Cannot find module '../src/image-bands.js'`

- [ ] **Step 3: Write the implementation**

Create `src/image-bands.js`:

```js
'use strict';

/**
 * Pure geometry for the import-sprite tool.
 *
 * The CLI feeds these functions 1-D alpha profiles (how many opaque pixels sit
 * in each row or column) extracted from a real canvas. Keeping the band-finding
 * and placement maths here — free of any canvas — is what makes the tricky part
 * testable without an image.
 */

/**
 * Contiguous runs of non-zero values in a 1-D profile.
 * Small gaps (<= mergeGap) are bridged; runs shorter than minRun are dropped.
 * Indices are inclusive.
 */
function detectBands(profile, { minRun = 1, mergeGap = 0 } = {}) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < profile.length; i += 1) {
    if (profile[i] > 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, profile.length - 1]);

  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] - 1 <= mergeGap) last[1] = run[1];
    else merged.push([...run]);
  }

  return merged.filter((b) => b[1] - b[0] + 1 >= minRun);
}

/** Even frame size for a cols x rows grid; `exact` false if it does not divide. */
function gridGeometry(sheetW, sheetH, cols, rows) {
  const frameW = Math.floor(sheetW / cols);
  const frameH = Math.floor(sheetH / rows);
  return { frameW, frameH, exact: frameW * cols === sheetW && frameH * rows === sheetH };
}

/**
 * The y at which to draw a band so its content bottom lands on `baseline`
 * within a cell of `cellHeight`. Clamped to >= 0 so a too-tall band is not
 * drawn starting above the cell.
 */
function baselineTop(bandTop, bandBottom, cellHeight, baseline) {
  const h = bandBottom - bandTop + 1;
  return Math.max(0, baseline - h);
}

/** The x to draw a band so it is horizontally centred in a cell. */
function centeredLeft(bandLeft, bandRight, cellWidth) {
  const w = bandRight - bandLeft + 1;
  return Math.round((cellWidth - w) / 2);
}

module.exports = { detectBands, gridGeometry, baselineTop, centeredLeft };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/image-bands.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add src/image-bands.js test/image-bands.test.js
git commit -m "feat: add pure band-detection and baseline placement for import-sprite"
```

---

### Task 2: The import-sprite Electron CLI

**Files:**
- Create: `tools/import-sprite.js`
- Modify: `package.json` (add the `import-sprite` script)
- Modify: `docs/THEMES.md` (document the tool)

**Interfaces:**
- Consumes: `detectBands`, `gridGeometry`, `baselineTop`, `centeredLeft` from `src/image-bands.js`; `readPngHeader` from `src/png.js` (to self-check output)
- Produces: a CLI run as `npm run import-sprite -- <input> [options]`

**CLI contract:**

```
npm run import-sprite -- <input> [options]

  <input>            source image: .svg .png .jpg .jpeg .webp

  --grid CxR         treat the input as an already-laid-out C x R grid; each
                     cell is normalized in place (content re-centred and
                     baselined) at the derived frame size
  --rows N           auto-detect mode: find N sprite rows by alpha bands, then
                     the frames within each row, and re-composite onto a clean
                     grid. Use when the source rows do not sit on a fixed grid
  --key MODE         remove a background before processing:
                       checker   a baked light/dark checkerboard
                       auto      the solid colour of the top-left pixel
                       #RRGGBB   a specific solid colour
  --baseline N       content bottom target within each cell (default: cellH-20)
  --scale S          write scale S into the theme.json stub (default 1)
  --name NAME        theme name in the stub (default: input basename)
  --out PATH         output PNG path (default: <input dir>/<basename>.png)

Writes the conforming PNG and a sibling theme.json stub, then self-checks the
PNG with readPngHeader and prints the grid it produced.
```

**Note on verification:** the CLI is verified by the controller running it on the real Mochi SVGs (`assets/sprites/mochi/_raw/*.svg`) and confirming the output passes `validate-theme`. Do NOT attempt visual verification.

- [ ] **Step 1: Write the CLI**

Create `tools/import-sprite.js`:

```js
#!/usr/bin/env node
'use strict';

/**
 * Normalize messy source art into a theme-conforming sprite sheet.
 *
 * Runs under Electron because it needs a real canvas: SVG rasterization,
 * getImageData for alpha analysis, and toDataURL to encode PNG-32. The maths
 * (band detection, baseline placement) lives in src/image-bands.js so it can be
 * unit-tested; this file is the canvas glue and CLI.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const { detectBands, gridGeometry, baselineTop, centeredLeft } = require('../src/image-bands.js');
const { readPngHeader } = require('../src/png.js');

const ALPHA_FLOOR = 16; // ignore near-invisible antialiasing fringe

function parseArgs(argv) {
  const args = { input: null, grid: null, rows: null, key: null, baseline: null, scale: 1, name: null, out: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) {
      if (args.input === null) args.input = a;
      continue;
    }
    const val = rest[i + 1];
    switch (a) {
      case '--grid': {
        const m = /^(\d+)x(\d+)$/.exec(val);
        if (m) args.grid = { cols: Number(m[1]), rows: Number(m[2]) };
        i += 1;
        break;
      }
      case '--rows': args.rows = Number(val); i += 1; break;
      case '--key': args.key = val; i += 1; break;
      case '--baseline': args.baseline = Number(val); i += 1; break;
      case '--scale': args.scale = Number(val); i += 1; break;
      case '--name': args.name = val; i += 1; break;
      case '--out': args.out = val; i += 1; break;
      default: break;
    }
  }
  return args;
}

/** Load the source into an <img> inside an offscreen page and return its size. */
async function renderToDataUrl(win, inputPath, key) {
  const bytes = fs.readFileSync(inputPath);
  const ext = path.extname(inputPath).toLowerCase();
  const mime =
    ext === '.svg' ? 'image/svg+xml'
    : ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : 'image/jpeg';
  const srcUri = `data:${mime};base64,${bytes.toString('base64')}`;

  // Draw the image to a canvas, optionally strip a background, return the
  // full-size RGBA data URL plus dimensions.
  const script = `
    (async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode failed')); img.src = ${JSON.stringify(srcUri)}; });
      const W = img.naturalWidth, H = img.naturalHeight;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);

      const key = ${JSON.stringify(key)};
      if (key) {
        const data = ctx.getImageData(0, 0, W, H);
        const d = data.data;
        const px = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i+1], d[i+2]]; };
        const near = (a, b, tol) => Math.abs(a[0]-b[0]) <= tol && Math.abs(a[1]-b[1]) <= tol && Math.abs(a[2]-b[2]) <= tol;
        let match;
        if (key === 'checker') {
          // A checkerboard is two greys; treat any near-grey light pixel as bg.
          match = (c) => Math.abs(c[0]-c[1]) < 12 && Math.abs(c[1]-c[2]) < 12 && c[0] > 140;
        } else if (key === 'auto') {
          const corner = px(0, 0);
          match = (c) => near(c, corner, 24);
        } else {
          const hex = key.replace('#', '');
          const target = [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
          match = (c) => near(c, target, 24);
        }
        for (let i = 0; i < d.length; i += 4) {
          if (match([d[i], d[i+1], d[i+2]])) d[i+3] = 0;
        }
        ctx.putImageData(data, 0, 0);
      }

      return { url: c.toDataURL('image/png'), W, H };
    })()
  `;
  return win.webContents.executeJavaScript(script);
}

/** Column/row alpha profiles for a region, computed in the page. */
async function analyze(win, dataUrl, region) {
  const script = `
    (async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(dataUrl)}; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { x0, y0, x1, y1 } = ${JSON.stringify(region)};
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const W = img.width, A = ${ALPHA_FLOOR};
      const rowProfile = [], colProfile = [];
      for (let y = y0; y <= y1; y++) { let n = 0; for (let x = x0; x <= x1; x++) if (data[(y*W+x)*4+3] > A) n++; rowProfile.push(n); }
      for (let x = x0; x <= x1; x++) { let n = 0; for (let y = y0; y <= y1; y++) if (data[(y*W+x)*4+3] > A) n++; colProfile.push(n); }
      return { rowProfile, colProfile };
    })()
  `;
  return win.webContents.executeJavaScript(script);
}

/** Composite a list of source rects onto a clean grid, return a PNG data URL. */
async function composite(win, dataUrl, cells, frameW, frameH, cols, rows) {
  const script = `
    (async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(dataUrl)}; });
      const cells = ${JSON.stringify(cells)};
      const c = document.createElement('canvas');
      c.width = ${frameW} * ${cols}; c.height = ${frameH} * ${rows};
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      cells.forEach((cell, i) => {
        const col = i % ${cols}, row = Math.floor(i / ${cols});
        ctx.drawImage(
          img, cell.sx, cell.sy, cell.sw, cell.sh,
          col * ${frameW} + cell.dx, row * ${frameH} + cell.dy, cell.sw, cell.sh,
        );
      });
      return c.toDataURL('image/png');
    })()
  `;
  return win.webContents.executeJavaScript(script);
}

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error('usage: npm run import-sprite -- <input> [--grid CxR | --rows N] [--key checker|auto|#RRGGBB] [--out PATH]');
    process.exitCode = 1;
    return;
  }
  if (!args.grid && !args.rows) {
    console.error('specify either --grid CxR (already gridded) or --rows N (auto-detect)');
    process.exitCode = 1;
    return;
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
  });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');

  const { url: rendered, W, H } = await renderToDataUrl(win, args.input, args.key);

  let cols;
  let rows;
  let frameW;
  let frameH;
  let cells; // { sx, sy, sw, sh, dx, dy } source rect + in-cell offset

  if (args.grid) {
    cols = args.grid.cols;
    rows = args.grid.rows;
    const geo = gridGeometry(W, H, cols, rows);
    frameW = geo.frameW;
    frameH = geo.frameH;
    const baseline = args.baseline ?? frameH - 20;
    cells = [];
    for (let r = 0; r < rows; r += 1) {
      for (let cIdx = 0; cIdx < cols; cIdx += 1) {
        const x0 = cIdx * frameW;
        const y0 = r * frameH;
        const { rowProfile, colProfile } = await analyze(win, rendered, { x0, y0, x1: x0 + frameW - 1, y1: y0 + frameH - 1 });
        const rBands = detectBands(rowProfile, { minRun: 1, mergeGap: 4 });
        const cBands = detectBands(colProfile, { minRun: 1, mergeGap: 4 });
        if (rBands.length === 0 || cBands.length === 0) {
          cells.push({ sx: x0, sy: y0, sw: frameW, sh: frameH, dx: 0, dy: 0 });
          continue;
        }
        const top = rBands[0][0];
        const bottom = rBands[rBands.length - 1][1];
        const left = cBands[0][0];
        const right = cBands[cBands.length - 1][1];
        cells.push({
          sx: x0 + left, sy: y0 + top, sw: right - left + 1, sh: bottom - top + 1,
          dx: centeredLeft(left, right, frameW),
          dy: baselineTop(top, bottom, frameH, baseline),
        });
      }
    }
  } else {
    rows = args.rows;
    // Detect the row bands across the whole sheet.
    const whole = await analyze(win, rendered, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const rowBands = detectBands(whole.rowProfile, { minRun: 40, mergeGap: 12 });
    if (rowBands.length !== rows) {
      console.warn(`warning: detected ${rowBands.length} row band(s), expected ${rows}; using detected count`);
      rows = rowBands.length;
    }
    // Within each row band, find the frame (column) bands.
    let maxCols = 0;
    const perRow = [];
    for (const [ry0, ry1] of rowBands) {
      const prof = await analyze(win, rendered, { x0: 0, y0: ry0, x1: W - 1, y1: ry1 });
      const colBands = detectBands(prof.colProfile, { minRun: 8, mergeGap: 18 });
      perRow.push({ ry0, ry1, colBands });
      maxCols = Math.max(maxCols, colBands.length);
    }
    cols = maxCols;
    // Frame size: widest sprite + padding, tallest row band; use uniform cell.
    frameW = Math.ceil(W / cols);
    frameH = Math.max(...rowBands.map(([a, b]) => b - a + 1)) + 20;
    const baseline = args.baseline ?? frameH - 10;
    cells = [];
    for (const { ry0, ry1, colBands } of perRow) {
      for (let cIdx = 0; cIdx < cols; cIdx += 1) {
        const cb = colBands[cIdx];
        if (!cb) { cells.push({ sx: 0, sy: 0, sw: 1, sh: 1, dx: 0, dy: -100 }); continue; }
        cells.push({
          sx: cb[0], sy: ry0, sw: cb[1] - cb[0] + 1, sh: ry1 - ry0 + 1,
          dx: centeredLeft(cb[0], cb[1], frameW),
          dy: baselineTop(0, ry1 - ry0, frameH, baseline),
        });
      }
    }
  }

  const outUrl = await composite(win, rendered, cells, frameW, frameH, cols, rows);
  const outBuf = dataUrlToBuffer(outUrl);

  const outPath = args.out ?? path.join(path.dirname(args.input), `${path.basename(args.input, path.extname(args.input))}.png`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outBuf);

  // Self-check.
  const header = readPngHeader(outBuf);
  const name = args.name ?? path.basename(args.input, path.extname(args.input));
  const stub = {
    name,
    author: 'you',
    license: 'CC0-1.0',
    scale: args.scale,
    states: {
      idle: { sheet: path.basename(outPath), grid: { cols, rows }, fps: 6, loop: true },
    },
  };
  const stubPath = path.join(path.dirname(outPath), 'theme.json');
  fs.writeFileSync(stubPath, `${JSON.stringify(stub, null, 2)}\n`);

  console.log(`wrote ${outPath}`);
  console.log(`  ${header.width}x${header.height}, ${cols}x${rows} grid, ${frameW}x${frameH} frames, alpha=${header.hasAlpha}`);
  console.log(`wrote ${stubPath} (edit the "states" map to assign frames to states)`);

  win.destroy();
}

// Guard the Electron bootstrap so `require('./import-sprite.js')` from a
// node --test file (for the parseArgs test) does not try to boot Electron,
// which throws outside an Electron process.
if (require.main === module) {
  app.disableHardwareAcceleration();
  app.whenReady().then(() =>
    run()
      .catch((err) => {
        console.error(`import-sprite failed: ${err && err.message}`);
        process.exitCode = 1;
      })
      .finally(() => app.quit()),
  );
}

module.exports = { parseArgs };
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `scripts`:

```json
    "import-sprite": "electron tools/import-sprite.js",
```

- [ ] **Step 3: Verify `parseArgs` (the one unit-testable piece of the CLI)**

The CLI is Electron-run and verified by the controller, but `parseArgs` is pure. Add a small test — create `test/import-sprite-args.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../tools/import-sprite.js');

// parseArgs reads process.argv[2..]; simulate by building an argv.
function parse(...cliArgs) {
  return parseArgs(['node', 'import-sprite.js', ...cliArgs]);
}

test('parses the input and a grid', () => {
  const a = parse('in.svg', '--grid', '8x4');
  assert.equal(a.input, 'in.svg');
  assert.deepEqual(a.grid, { cols: 8, rows: 4 });
});

test('parses rows, key, out, name, scale, baseline', () => {
  const a = parse('in.png', '--rows', '4', '--key', 'checker', '--out', 'o.png', '--name', 'Mochi', '--scale', '0.6', '--baseline', '250');
  assert.equal(a.rows, 4);
  assert.equal(a.key, 'checker');
  assert.equal(a.out, 'o.png');
  assert.equal(a.name, 'Mochi');
  assert.equal(a.scale, 0.6);
  assert.equal(a.baseline, 250);
});

test('leaves grid null when no grid flag is given', () => {
  assert.equal(parse('in.png', '--rows', '4').grid, null);
});
```

**Important:** `tools/import-sprite.js` calls `app.whenReady()` at module load, which throws outside Electron and would break this `node --test`. Guard the Electron bootstrap so it only runs as the main entry. Wrap the bottom `app.disableHardwareAcceleration(); app.whenReady()...` block in:

```js
if (require.main === module) {
  app.disableHardwareAcceleration();
  app.whenReady().then(() => run().catch(...).finally(() => app.quit()));
}
```

so that `require('../tools/import-sprite.js')` for the test does not boot Electron. `parseArgs` is exported regardless.

- [ ] **Step 4: Run the pure tests**

Run: `npm test`
Expected: PASS — the `parseArgs` and `image-bands` tests pass; no Electron booted during `node --test`.

- [ ] **Step 5: Controller verification on real Mochi SVGs**

(Performed by the controller, not the implementer — it needs Electron and the real assets.)

Grid mode on a clean SVG:
```bash
env -u ELECTRON_RUN_AS_NODE npx electron tools/import-sprite.js assets/sprites/mochi/_raw/Sleeping.svg --grid 8x4 --name Mochi --out /tmp/mochi-test/sleeping.png
npm run validate-theme -- /tmp/mochi-test
```
Expected: writes a 1920x1080-ish 8x4 sheet with alpha; the emitted `theme.json` validates.

- [ ] **Step 6: Document in `docs/THEMES.md`**

Add an `## Importing messy art` section describing the tool, its two modes (`--grid` for an already-gridded sheet that needs cleanup, `--rows` for auto-detection), and the `--key` options. Note that the output `theme.json` is a stub with everything mapped to `idle` — the author edits the `states` map to assign frame ranges to states.

- [ ] **Step 7: Commit**

```bash
git add tools/import-sprite.js test/import-sprite-args.test.js package.json docs/THEMES.md
git commit -m "feat: add import-sprite CLI to normalize messy art into conforming sheets"
```

---

## Phase 3B Definition of Done

- [ ] `npm test` passes, no earlier test broken, no Electron booted during `node --test`
- [ ] `src/image-bands.js` is pure and unit-tested
- [ ] `import-sprite` renders an SVG, applies the grid, and writes a PNG-32 with alpha
- [ ] The emitted `theme.json` stub passes `validate-theme`
- [ ] `--key checker` removes a baked checkerboard
- [ ] `docs/THEMES.md` documents the tool
- [ ] `package.json` still lists **electron and nothing else**
- [ ] `src/` does not import `tools/`

---

## Deferred to 3C

Click reactions, `clickThrough`, position persistence, speech bubbles.

---

## Post-implementation amendments (Task 2)

Controller verification on the real Mochi SVGs surfaced three defects, all in
this plan's Electron design, none in the transcription:

1. **The bootstrap guard was wrong.** `if (require.main === module)` is FALSE
   under Electron — the entry's `require.main.filename` is literally `"electron"` —
   so the CLI idled with no window forever. Gated on `process.versions.electron`
   instead (defined under Electron, absent under `node --test`).
2. **Per-call image re-decode.** Each `analyze` re-decoded the full multi-MB
   image; 32 cells thrashed memory for minutes. The sheet is now decoded ONCE
   into `window.__sheet` and every call references it.
3. **Offscreen throttling.** An `offscreen: true` window throttles
   `executeJavaScript` to ~seconds per call (32 calls timed out at 90s). The
   tool uses `toDataURL`, not `capturePage`, so it needs no offscreen rendering:
   switched to a plain hidden window with `backgroundThrottling: false` — 32
   calls now run in ~6ms.

Verified end to end: `import-sprite Sleeping.svg --grid 8x4` renders the
feColorMatrix-masked SVG, writes a 1920x1080 alpha PNG in ~8s, emits a stub,
and the output passes `validate-theme` and renders as a clean 32-frame beagle
sheet. The committed source is authoritative.
