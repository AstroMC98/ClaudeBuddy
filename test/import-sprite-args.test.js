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

test('leaves grid null for a malformed grid value', () => {
  // A bad grid (regex miss) must not become a partial/garbage grid.
  assert.equal(parse('in.png', '--grid', '8X4').grid, null);
  assert.equal(parse('in.png', '--grid', '8-4').grid, null);
  assert.equal(parse('in.png', '--grid', 'lots').grid, null);
});

test('a non-numeric rows or scale parses to NaN (caller validates)', () => {
  assert.equal(Number.isNaN(parse('in.png', '--rows', 'abc').rows), true);
  assert.equal(Number.isNaN(parse('in.png', '--scale', 'abc').scale), true);
});
