'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHookEntries,
  mergeHooks,
  HOOK_EVENTS,
} = require('../tools/install-hooks.js');

const NOTIFY = '/home/me/Claude Buddy/hooks/notify.js';

test('builds an entry for every mapped Claude Code hook event', () => {
  const entries = buildHookEntries(NOTIFY);
  assert.deepEqual(Object.keys(entries).sort(), Object.keys(HOOK_EVENTS).sort());
});

test('each command invokes the shim with its buddy event type', () => {
  const entries = buildHookEntries(NOTIFY);
  const command = entries.Stop[0].hooks[0].command;
  assert.ok(command.includes(NOTIFY), 'command should reference the shim path');
  assert.ok(command.endsWith(' done'), `expected the done event, got: ${command}`);
  assert.equal(entries.Stop[0].hooks[0].type, 'command');
});

test('quotes the shim path so spaces survive', () => {
  const command = buildHookEntries(NOTIFY).Stop[0].hooks[0].command;
  assert.ok(command.includes(`"${NOTIFY}"`), `path must be quoted: ${command}`);
});

test('adds hooks to empty settings', () => {
  const merged = mergeHooks({}, buildHookEntries(NOTIFY));
  assert.equal(merged.hooks.Stop.length, 1);
  assert.equal(merged.hooks.UserPromptSubmit.length, 1);
});

test('preserves unrelated top-level settings', () => {
  const settings = { model: 'opus', permissions: { allow: ['Bash'] } };
  const merged = mergeHooks(settings, buildHookEntries(NOTIFY));
  assert.equal(merged.model, 'opus');
  assert.deepEqual(merged.permissions, { allow: ['Bash'] });
});

test('preserves an existing unrelated hook on the same event', () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo something-else' }] }],
    },
  };
  const merged = mergeHooks(settings, buildHookEntries(NOTIFY));
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'echo something-else');
});

test('is idempotent', () => {
  const entries = buildHookEntries(NOTIFY);
  const once = mergeHooks({}, entries);
  const twice = mergeHooks(once, entries);
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.Stop.length, 1);
});

test('replaces a stale buddy hook rather than duplicating it', () => {
  // A real prior install always lives at <project>/hooks/notify.js, which is
  // why SHIM_MARKER includes the directory component.
  const settings = mergeHooks({}, buildHookEntries('/old/project/hooks/notify.js'));
  const merged = mergeHooks(settings, buildHookEntries(NOTIFY));
  assert.equal(merged.hooks.Stop.length, 1, 'old buddy entry should be replaced');
  assert.ok(merged.hooks.Stop[0].hooks[0].command.includes(NOTIFY));
});

test('never clobbers an unrelated user hook that mentions notify.js', () => {
  const settings = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node /home/me/scripts/notify.js slack' }] },
        { hooks: [{ type: 'command', command: 'echo unrelated' }] },
      ],
    },
  };
  const merged = mergeHooks(settings, buildHookEntries(NOTIFY));
  const commands = merged.hooks.Stop.map((g) => g.hooks[0].command);
  assert.ok(
    commands.some((c) => c.includes('/home/me/scripts/notify.js')),
    "the user's own notify.js hook must survive",
  );
  assert.ok(commands.some((c) => c === 'echo unrelated'));
  assert.equal(merged.hooks.Stop.length, 3);
});

test('does not mutate the input settings object', () => {
  const settings = { hooks: { Stop: [] } };
  const snapshot = JSON.stringify(settings);
  mergeHooks(settings, buildHookEntries(NOTIFY));
  assert.equal(JSON.stringify(settings), snapshot);
});
