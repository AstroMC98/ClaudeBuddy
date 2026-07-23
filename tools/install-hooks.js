#!/usr/bin/env node
'use strict';

/**
 * Merge Claude Buddy's hook entries into ~/.claude/settings.json.
 *
 *   npm run install-hooks            print the proposed settings, change nothing
 *   npm run install-hooks -- --write apply the change (backs up the original)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Claude Code hook event -> buddy event type. */
const HOOK_EVENTS = Object.freeze({
  UserPromptSubmit: 'thinking',
  Stop: 'done',
  SubagentStop: 'subagent',
  Notification: 'needsInput',
});

/**
 * Marker used to recognise our own entries when re-running.
 *
 * The `hooks/` directory component is load-bearing: this string decides which
 * existing entries get REPLACED. Matching on `notify.js` alone would silently
 * delete a user's own unrelated hook that happens to run some other
 * `notify.js` — data loss in the user's live Claude Code config.
 */
const SHIM_MARKER = 'hooks/notify.js';

function buildHookEntries(notifyPath) {
  const entries = {};
  for (const [hookEvent, buddyEvent] of Object.entries(HOOK_EVENTS)) {
    entries[hookEvent] = [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${notifyPath}" ${buddyEvent}`,
          },
        ],
      },
    ];
  }
  return entries;
}

/** True if this matcher group is one of ours (from any install path). */
function isBuddyEntry(group) {
  return (
    group &&
    Array.isArray(group.hooks) &&
    group.hooks.some(
      (h) => typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(SHIM_MARKER),
    )
  );
}

/**
 * Merge entries into settings without mutating the input.
 * Existing buddy entries are replaced; unrelated hooks are preserved.
 */
function mergeHooks(settings, entries) {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  if (next.hooks === null || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
    next.hooks = {};
  }

  for (const [hookEvent, groups] of Object.entries(entries)) {
    const existing = Array.isArray(next.hooks[hookEvent]) ? next.hooks[hookEvent] : [];
    next.hooks[hookEvent] = [...existing.filter((g) => !isBuddyEntry(g)), ...groups];
  }

  return next;
}

function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function main() {
  const write = process.argv.includes('--write');
  const notifyPath = path.join(__dirname, '..', 'hooks', 'notify.js');
  const file = settingsPath();

  const current = readSettings(file);
  const merged = mergeHooks(current, buildHookEntries(notifyPath));
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  if (!write) {
    console.log(`Would update: ${file}\n`);
    console.log(serialized);
    console.log('Re-run with --write to apply:\n  npm run install-hooks -- --write');
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backup = `${file}.buddy-backup`;
    fs.copyFileSync(file, backup);
    console.log(`Backed up existing settings to ${backup}`);
  }
  fs.writeFileSync(file, serialized, 'utf8');
  console.log(`Installed Claude Buddy hooks into ${file}`);
  console.log('Restart Claude Code for the hooks to take effect.');
}

if (require.main === module) main();

module.exports = { buildHookEntries, mergeHooks, isBuddyEntry, HOOK_EVENTS, SHIM_MARKER };
