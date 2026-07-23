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
 * derive their height from the sheet, because a strip is a single row.
 *
 * `ownFrame` is what this state declared for itself; `declaredFrame` also
 * takes a top-level frame into account. The distinction matters: a top-level
 * frame exists for a theme's strip states, so a grid state must not be failed
 * merely for inheriting it.
 */
function resolveStateGeometry(entry, sheet, fallbackFrame) {
  const own = entry.frame ?? null;
  const declared = own ?? fallbackFrame ?? null;

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
      ownFrame: own,
      declaredFrame: declared,
      totalFrames: cols * rows,
    };
  }

  const frames = entry.frames;
  // Per-field, never wholesale: taking `declared` as the frame would leave
  // height undefined whenever the author declared only a width.
  return {
    cols: frames,
    rows: 1,
    frame: {
      width: declared?.width ?? Math.floor(sheet.width / (frames || 1)),
      height: declared?.height ?? sheet.height,
    },
    ownFrame: own,
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

      // A frame declared ON THIS STATE must agree with what the grid implies.
      // A top-level frame is deliberately not checked here: it exists for the
      // theme's strip states, and a grid state simply does not need it.
      const own = geom.ownFrame;
      if (
        own !== null &&
        ((isPositiveInt(own.width) && own.width !== geom.frame.width) ||
          (isPositiveInt(own.height) && own.height !== geom.frame.height))
      ) {
        errors.push(
          `state "${key}": declared frame ${own.width}x${own.height} disagrees with the ` +
            `${geom.frame.width}x${geom.frame.height} implied by a ${geom.cols}x${geom.rows} ` +
            `grid on a ${sheet.width}x${sheet.height} sheet`,
        );
        continue;
      }
    } else {
      const frameW = geom.declaredFrame?.width;
      if (!isPositiveInt(frameW)) {
        errors.push(`state "${key}" is a strip, so it needs a frame width (top-level or per-state)`);
        continue;
      }

      const declaredH = geom.declaredFrame?.height;
      if (declaredH !== undefined && declaredH !== sheet.height) {
        errors.push(
          `state "${key}": declared frame height ${declaredH} does not match the ` +
            `${sheet.height}px tall sheet ${entry.sheet} — a strip is a single row`,
        );
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
