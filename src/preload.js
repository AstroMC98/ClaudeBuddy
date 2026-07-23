'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The ENTIRE IPC surface. The renderer is sandboxed and can reach nothing else.
 * Keep this minimal: every addition here is attack surface.
 */
contextBridge.exposeInMainWorld('buddy', {
  /** @param {(change: object) => void} callback */
  onStateChange(callback) {
    ipcRenderer.on('state-change', (_event, change) => callback(change));
  },

  /** Report that a non-looping animation has finished playing. */
  animationEnded() {
    ipcRenderer.send('animation-ended');
  },
});
