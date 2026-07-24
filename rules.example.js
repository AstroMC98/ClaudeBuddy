'use strict';

/**
 * Claude Buddy rules — OPTIONAL.
 *
 * Copy this file to `rules.js` (same directory) to enable it. It runs in a
 * worker thread on every Claude Code event and may override how that event is
 * handled. It is YOUR code and is never auto-updated.
 *
 * Signature: (event, defaultBehavior) => Behavior | null
 *   event           = { type, message?, cwd?, at }
 *   defaultBehavior = { sound: string|null, scalePulse: number }
 *   return the behavior to use, or null to ignore the event entirely.
 *
 * A thrown error, a return outside the contract, or a hang all fall back to
 * defaultBehavior — a broken rules.js cannot break the pet.
 */
module.exports = function rules(event, defaultBehavior) {
  // Quiet hours: no sound between 11pm and 7am.
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) return { ...defaultBehavior, sound: null };

  // A louder, bigger celebration when your tests pass.
  if (event.type === 'done' && /tests?\s+pass/i.test(event.message ?? '')) {
    return { ...defaultBehavior, sound: 'sounds/fanfare.mp3', scalePulse: 2 };
  }

  // Ignore a noisy scratch project entirely.
  if (event.cwd && event.cwd.includes('scratch')) return null;

  return defaultBehavior;
};
