'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { toDataUri } = require('./assets.js');
const { isSafeRelativePath } = require('./config.js');

/**
 * Resolve a relative sound path to a `data:` URI, once.
 *
 * With rules.js active, main resolves a sound per event, and the same sound
 * may fire on every `done`. Caching by path — including negative results —
 * keeps that to one disk read and one failure log, not one per event.
 */
function createSoundCache(projectRoot) {
  const cache = new Map();

  return {
    resolve(relPath) {
      if (relPath === null) return null;
      if (cache.has(relPath)) return cache.get(relPath);

      let uri = null;
      if (isSafeRelativePath(relPath)) {
        try {
          uri = toDataUri(fs.readFileSync(path.join(projectRoot, relPath)), relPath);
        } catch {
          uri = null;
        }
      }

      cache.set(relPath, uri);
      return uri;
    },
  };
}

module.exports = { createSoundCache };
