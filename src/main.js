'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog } = require('electron');

const { loadConfig } = require('./config.js');
const { createStateMachine } = require('./state-machine.js');
const { createEventServer } = require('./server.js');
const { loadAssets } = require('./assets.js');

const config = loadConfig();

const PROJECT_ROOT = path.join(__dirname, '..');
const assets = loadAssets(config, PROJECT_ROOT);
for (const problem of assets.problems) console.warn(`[buddy] ${problem}`);

/** How often to check whether the buddy should fall asleep. */
const TICK_INTERVAL_MS = 15 * 1000;

let win = null;
let tray = null;
let server = null;
let tickTimer = null;
let cleaningUp = false;

const machine = createStateMachine({
  idleTimeoutMs: config.idleTimeoutMinutes * 60 * 1000,
  now: Date.now(),
});

/** Push a state change to the renderer, if there is one and it is alive. */
function pushStateChange(change) {
  if (!change) return;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state-change', change);
}

function createWindow() {
  win = new BrowserWindow({
    width: config.width,
    height: config.height,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: config.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A desktop pet never receives a user gesture, so Chromium's default
      // autoplay policy would silently block every sound.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');

  // Apply config.scale by injecting a rule rather than widening the IPC
  // surface. #stage's own pulse keyframe (styles.css) reads --base-scale and
  // composes with it, so injecting the scale via a custom property here
  // (rather than a plain `transform: scale()`) keeps the two from fighting
  // over #stage's transform mid-animation.
  win.webContents.on('did-finish-load', () => {
    const scale = Number(config.scale) > 0 ? Number(config.scale) : 1;
    win.webContents.insertCSS(
      `#stage { --base-scale: ${scale}; transform: scale(calc(var(--base-scale) * var(--theme-scale, 1))); }`,
    );

    // Assets first: the renderer must know which theme it has before it is
    // told which state to show, or the first state would render with the
    // procedural fallback and then visibly swap.
    win.webContents.send('assets', assets);

    // The renderer has only just subscribed; catch it up on anything it
    // missed while the page was loading. See machine.snapshot().
    //
    // Flagged as a resync so the renderer can ignore it when it is already
    // showing this state: an event delivered after preload registered but
    // before this fires was NOT lost, and replaying it would restart a live
    // one-shot's settle timer and re-run its pulse.
    pushStateChange({ ...machine.snapshot(), resync: true });
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

function createTray(status) {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR4' +
      'AWMYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUAAAHkgABs1sVjwAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('Claude Buddy');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      {
        label: assets.theme ? `Theme: ${assets.theme.name}` : 'Theme: procedural',
        enabled: false,
      },
      ...(assets.problems.length > 0
        ? [{ label: `${assets.problems.length} asset problem(s) — see console`, enabled: false }]
        : []),
      { type: 'separator' },
      {
        label: 'Test: done',
        click: () => pushStateChange(machine.handleEvent({ type: 'done' }, Date.now())),
      },
      {
        label: 'Test: needs input',
        click: () => pushStateChange(machine.handleEvent({ type: 'needsInput' }, Date.now())),
      },
      {
        label: 'Test: error',
        click: () => pushStateChange(machine.handleEvent({ type: 'error' }, Date.now())),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

async function startServer() {
  server = createEventServer({
    host: '127.0.0.1',
    port: config.port,
    token: config.token,
    onEvent: (event) => pushStateChange(machine.handleEvent(event, Date.now())),
    onServerError: (err) => console.error('[buddy] server error:', err.message),
  });

  try {
    const address = await server.listen();
    return `Listening on 127.0.0.1:${address.port}`;
  } catch (err) {
    // Deliberately do NOT fall back to another port: the hooks point at this
    // one, and silently moving would leave the buddy permanently deaf.
    const message =
      err && err.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use. Close whatever is using it, or change "port" in config.json.`
        : `Could not start the event server: ${err && err.message}`;
    dialog.showErrorBox('Claude Buddy', message);
    return 'Server failed to start';
  }
}

app.whenReady().then(async () => {
  createWindow();
  const status = await startServer();
  createTray(status);

  // The renderer reports when a one-shot animation has played out.
  ipcMain.on('animation-ended', () => pushStateChange(machine.completeOneShot()));

  tickTimer = setInterval(() => pushStateChange(machine.tick(Date.now())), TICK_INTERVAL_MS);
});

app.on('window-all-closed', () => app.quit());

// Electron does not await an async 'before-quit' listener — it tears the
// process down regardless, so `await server.close()` inside one is decorative.
// Block the quit explicitly, finish cleanup, then quit again for real.
app.on('before-quit', (event) => {
  if (cleaningUp) return;
  cleaningUp = true;

  event.preventDefault();
  clearInterval(tickTimer);

  // close() alone waits for every socket to drain, so a keep-alive client
  // could stall the quit. Drop connections first to keep shutdown bounded.
  if (server && typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }

  Promise.resolve(server ? server.close() : undefined)
    .catch(() => {})
    .finally(() => app.quit());
});
