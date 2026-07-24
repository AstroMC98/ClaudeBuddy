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

  /**
   * Theme sheets and sounds, inlined as data URIs by the main process because
   * the sandboxed renderer cannot read files. Delivered once, after load.
   * @param {(assets: object) => void} callback
   */
  onAssets(callback) {
    ipcRenderer.on('assets', (_event, assets) => callback(assets));
  },

  /** Report that a non-looping animation has finished playing. */
  animationEnded() {
    ipcRenderer.send('animation-ended');
  },

  /** Tell main whether the cursor is over the pet (drives click-through). */
  setInteractive(isInteractive) {
    ipcRenderer.send('set-interactive', Boolean(isInteractive));
  },

  /** Receive interaction config (whether click-through is active). */
  onInteraction(callback) {
    ipcRenderer.on('interaction', (_event, cfg) => callback(cfg));
  },
});
