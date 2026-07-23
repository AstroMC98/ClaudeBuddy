#!/usr/bin/env node
'use strict';

/**
 * Validate a theme directory.
 *
 *   npm run validate-theme -- themes/mochi
 *
 * Reports geometry mismatches, missing alpha, unknown state names, filename
 * case mismatches and out-of-range frames — with messages that say what to fix.
 * All logic lives in src/theme-loader.js; this is presentation only.
 */

const { validateThemeDir } = require('../src/theme-loader.js');

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: npm run validate-theme -- <theme-directory>');
    process.exitCode = 1;
    return;
  }

  const { errors, warnings, theme } = validateThemeDir(target);

  for (const w of warnings) console.warn(`warning: ${w}`);

  if (errors.length > 0) {
    console.error(`\n${target} is not a valid theme:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  const states = Object.keys(theme.states);
  console.log(`${target} is valid.`);
  console.log(`  theme:  ${theme.name}`);
  console.log(`  states: ${states.join(', ')}`);
  for (const name of states) {
    const s = theme.states[name];
    console.log(
      `    ${name}: ${s.totalFrames} frames of ${s.frame.width}x${s.frame.height} ` +
        `@ ${s.fps}fps${s.variants.length > 1 ? `, ${s.variants.length} variants` : ''}`,
    );
  }
}

if (require.main === module) main();
