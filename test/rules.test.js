'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRulesRunner } = require('../src/rules.js');

const DEF = { sound: 'sounds/default.mp3', scalePulse: 1 };

/** Write a rules.js with the given body and return its path. */
function writeRules(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-rules-'));
  const file = path.join(dir, 'rules.js');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('is inactive when rules.js does not exist', async () => {
  const runner = createRulesRunner({ rulesPath: path.join(os.tmpdir(), 'no-such-rules-9931.js') });
  assert.equal(runner.active, false);
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('applies a valid override from rules.js', async () => {
  const file = writeRules(`
    module.exports = (event, def) => {
      if (event.type === 'done') return { ...def, scalePulse: 2 };
      return def;
    };
  `);
  const runner = createRulesRunner({ rulesPath: file });
  assert.equal(runner.active, true);
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), { sound: 'sounds/default.mp3', scalePulse: 2 });
  await runner.close();
});

test('suppresses an event when rules returns null', async () => {
  const file = writeRules(`module.exports = () => null;`);
  const runner = createRulesRunner({ rulesPath: file });
  assert.equal(await runner.run({ type: 'done' }, DEF), null);
  await runner.close();
});

test('sanitizes an out-of-contract override', async () => {
  const file = writeRules(`module.exports = () => ({ scalePulse: 999, sound: '../../etc/passwd' });`);
  const runner = createRulesRunner({ rulesPath: file });
  // Both fields are out of contract, so both fall back to the default.
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('falls back to the default when rules throws', async () => {
  const file = writeRules(`module.exports = () => { throw new Error('boom'); };`);
  const runner = createRulesRunner({ rulesPath: file });
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('falls back to the default when rules.js fails to load', async () => {
  const file = writeRules(`this is not valid javascript {{{`);
  const runner = createRulesRunner({ rulesPath: file });
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('falls back to the default when the export is not a function', async () => {
  const file = writeRules(`module.exports = { not: 'a function' };`);
  const runner = createRulesRunner({ rulesPath: file });
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), DEF);
  await runner.close();
});

test('a hang is terminated within the budget and falls back', async () => {
  const file = writeRules(`module.exports = () => { while (true) {} };`);
  const runner = createRulesRunner({ rulesPath: file, timeoutMs: 60 });
  const started = Date.now();
  const result = await runner.run({ type: 'done' }, DEF);
  const elapsed = Date.now() - started;
  assert.deepEqual(result, DEF);
  assert.ok(elapsed < 2000, `hang should resolve near the budget, took ${elapsed}ms`);
  await runner.close();
});

test('recovers after a hang — the next call works', async () => {
  // Hang on one event type, behave on another, so recovery is demonstrable
  // (a counter would reset when the respawned worker re-requires the file).
  const file = writeRules(`
    module.exports = (event, def) => {
      if (event.type === 'hang') { while (true) {} }
      return { ...def, scalePulse: 3 };
    };
  `);
  const runner = createRulesRunner({ rulesPath: file, timeoutMs: 60 });
  assert.deepEqual(await runner.run({ type: 'hang' }, DEF), DEF); // hang -> default
  // The next call hits a freshly respawned worker and succeeds.
  assert.deepEqual(await runner.run({ type: 'done' }, DEF), { sound: DEF.sound, scalePulse: 3 });
  await runner.close();
});

test('serializes calls so results are never mismatched', async () => {
  const file = writeRules(`
    module.exports = (event, def) => ({ ...def, scalePulse: event.n });
  `);
  const runner = createRulesRunner({ rulesPath: file });
  const results = await Promise.all([
    runner.run({ type: 'done', n: 1.1 }, DEF),
    runner.run({ type: 'done', n: 1.2 }, DEF),
    runner.run({ type: 'done', n: 1.3 }, DEF),
  ]);
  assert.deepEqual(results.map((r) => r.scalePulse), [1.1, 1.2, 1.3]);
  await runner.close();
});

test('run never rejects, even under abuse', async () => {
  const file = writeRules(`module.exports = () => { throw 'a string, not an Error'; };`);
  const runner = createRulesRunner({ rulesPath: file });
  await assert.doesNotReject(() => runner.run({ type: 'done' }, DEF));
  await runner.close();
});
