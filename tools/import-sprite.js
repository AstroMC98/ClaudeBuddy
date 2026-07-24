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

/**
 * Decode the source ONCE and keep its pixels resident on the page's `window`,
 * so the many per-cell `analyze` calls (up to cols*rows of them) and the final
 * `composite` all reference the same already-decoded image instead of
 * re-decoding a multi-megabyte data URL each time. Re-decoding per call turned
 * a 32-cell grid into a multi-minute, memory-thrashing run.
 *
 * Returns the source dimensions.
 */
async function loadSheet(win, inputPath, key) {
  const bytes = fs.readFileSync(inputPath);
  const ext = path.extname(inputPath).toLowerCase();
  const mime =
    ext === '.svg' ? 'image/svg+xml'
    : ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : 'image/jpeg';
  const srcUri = `data:${mime};base64,${bytes.toString('base64')}`;

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
      const imageData = ctx.getImageData(0, 0, W, H);
      const d = imageData.data;
      if (key) {
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
        ctx.putImageData(imageData, 0, 0);
      }

      // Persist the decoded canvas and its pixel buffer for later calls.
      window.__sheet = { W, H, canvas: c, data: d };
      return { W, H };
    })()
  `;
  return win.webContents.executeJavaScript(script);
}

/** Column/row alpha profiles for a region of the resident sheet. No re-decode. */
async function analyze(win, region) {
  const script = `
    (() => {
      const s = window.__sheet, d = s.data, W = s.W, A = ${ALPHA_FLOOR};
      const { x0, y0, x1, y1 } = ${JSON.stringify(region)};
      const rowProfile = [], colProfile = [];
      for (let y = y0; y <= y1; y++) { let n = 0; for (let x = x0; x <= x1; x++) if (d[(y*W+x)*4+3] > A) n++; rowProfile.push(n); }
      for (let x = x0; x <= x1; x++) { let n = 0; for (let y = y0; y <= y1; y++) if (d[(y*W+x)*4+3] > A) n++; colProfile.push(n); }
      return { rowProfile, colProfile };
    })()
  `;
  return win.webContents.executeJavaScript(script);
}

/** Composite source rects from the resident sheet onto a clean grid. */
async function composite(win, cells, frameW, frameH, cols, rows) {
  const script = `
    (() => {
      const src = window.__sheet.canvas;
      const cells = ${JSON.stringify(cells)};
      const c = document.createElement('canvas');
      c.width = ${frameW} * ${cols}; c.height = ${frameH} * ${rows};
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      cells.forEach((cell, i) => {
        const col = i % ${cols}, row = Math.floor(i / ${cols});
        ctx.drawImage(
          src, cell.sx, cell.sy, cell.sw, cell.sh,
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
  // A malformed hex key would silently key nothing (parseInt -> NaN, every
  // comparison false), leaving the user with an un-keyed sheet and no clue why.
  if (args.key && args.key !== 'checker' && args.key !== 'auto' && !/^#?[0-9a-fA-F]{6}$/.test(args.key)) {
    console.error(`--key must be "checker", "auto", or a 6-digit hex colour like #88a0c0 (got "${args.key}")`);
    process.exitCode = 1;
    return;
  }

  // A plain hidden window, NOT offscreen. This tool draws to a canvas and reads
  // it back with toDataURL — it never needs capturePage, so it does not need
  // offscreen rendering. Offscreen windows throttle executeJavaScript to
  // seconds per call, which turned the many per-cell analyze calls into a
  // multi-minute run; a hidden window with throttling disabled runs them in ms.
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');

  const { W, H } = await loadSheet(win, args.input, args.key);

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
        const { rowProfile, colProfile } = await analyze(win, { x0, y0, x1: x0 + frameW - 1, y1: y0 + frameH - 1 });
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
    const whole = await analyze(win, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const rowBands = detectBands(whole.rowProfile, { minRun: 40, mergeGap: 12 });
    if (rowBands.length !== rows) {
      console.warn(`warning: detected ${rowBands.length} row band(s), expected ${rows}; using detected count`);
      rows = rowBands.length;
    }
    // Within each row band, find the frame (column) bands.
    let maxCols = 0;
    const perRow = [];
    for (const [ry0, ry1] of rowBands) {
      const prof = await analyze(win, { x0: 0, y0: ry0, x1: W - 1, y1: ry1 });
      const colBands = detectBands(prof.colProfile, { minRun: 8, mergeGap: 18 });
      perRow.push({ ry0, ry1, colBands });
      maxCols = Math.max(maxCols, colBands.length);
    }
    cols = maxCols;
    if (rows === 0 || cols === 0) {
      throw new Error(
        `no sprites detected (rows=${rows}, cols=${cols}). Is the background transparent? ` +
          `Try --key to remove a solid or checkerboard background first.`,
      );
    }
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

  const outUrl = await composite(win, cells, frameW, frameH, cols, rows);
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
  // The stub maps everything to `idle`. Never clobber a real, hand-edited
  // theme.json that already lives in the output directory — the whole point of
  // editing the stub is lost if a re-import silently overwrites it.
  const stubPath = path.join(path.dirname(outPath), 'theme.json');
  const wroteStub = !fs.existsSync(stubPath);
  if (wroteStub) {
    fs.writeFileSync(stubPath, `${JSON.stringify(stub, null, 2)}\n`);
  }

  console.log(`wrote ${outPath}`);
  console.log(`  ${header.width}x${header.height}, ${cols}x${rows} grid, ${frameW}x${frameH} frames, alpha=${header.hasAlpha}`);
  console.log(
    wroteStub
      ? `wrote ${stubPath} (edit the "states" map to assign frames to states)`
      : `kept existing ${stubPath} (not overwritten) — update its grid/sheet if needed`,
  );

  win.destroy();
}

// Guard the Electron bootstrap so `require('./import-sprite.js')` from a
// node --test file (for the parseArgs test) does not try to boot Electron.
// Gate on `process.versions.electron`, NOT `require.main === module`: under
// Electron the entry's require.main.filename is literally "electron", so
// require.main === module is FALSE and the bootstrap would never run — the CLI
// would idle with no window forever. `process.versions.electron` is defined
// only under Electron and absent under plain `node --test`, which is exactly
// the distinction we need.
if (process.versions.electron) {
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
