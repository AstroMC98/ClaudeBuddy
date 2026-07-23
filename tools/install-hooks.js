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
      (h) =>
        h && typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(SHIM_MARKER),
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

/**
 * Read the user's settings.
 *
 * A missing file is normal and yields `{}`. Anything else — unreadable,
 * malformed, or not a JSON object — throws, because the caller's next move is
 * to OVERWRITE this file. Treating an unreadable-but-present file as empty
 * would silently discard every setting the user has.
 */
function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read ${file}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Refusing to touch it.`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object. Refusing to touch it.`);
  }

  return parsed;
}

/**
 * Pick a backup path that does not already exist.
 *
 * The first backup captures the user's true pre-Buddy configuration and is
 * their only complete undo. A second --write must not clobber it.
 */
function backupPath(file) {
  const base = `${file}.buddy-backup`;
  if (!fs.existsSync(base)) return base;
  let n = 2;
  while (fs.existsSync(`${base}.${n}`)) n += 1;
  return `${base}.${n}`;
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
    const backup = backupPath(file);
    fs.copyFileSync(file, backup);
    console.log(`Backed up existing settings to ${backup}`);
  }
  fs.writeFileSync(file, serialized, 'utf8');
  console.log(`Installed Claude Buddy hooks into ${file}`);
  console.log('Restart Claude Code for the hooks to take effect.');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`claude-buddy: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildHookEntries,
  mergeHooks,
  isBuddyEntry,
  readSettings,
  backupPath,
  HOOK_EVENTS,
  SHIM_MARKER,
};
