'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog } = require('electron');

const { loadConfig } = require('./config.js');
const { createStateMachine, ONE_SHOT } = require('./state-machine.js');
const { createEventServer } = require('./server.js');

const config = loadConfig();

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

/**
 * The machine's current state, shaped as a StateChange, for resyncing the
 * renderer after a page load.
 *
 * `webContents.send` does not queue for a renderer that has not subscribed
 * yet, so an event arriving during startup is applied to the machine but never
 * displayed. For a one-shot state that is worse than a dropped frame: the
 * renderer never reports `animation-ended`, `completeOneShot()` never runs, the
 * machine stays stuck in `done`, and since `tick()` only sleeps from `idle` the
 * buddy would never sleep again either. Resyncing on load closes that window.
 */
function currentStateChange() {
  const state = machine.getState();
  const next = Object.hasOwn(ONE_SHOT, state) ? ONE_SHOT[state] : null;
  return { state, previous: null, loop: next === null, next };
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
    },
  });

  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');

  // Apply config.scale by injecting a rule rather than widening the IPC
  // surface. #stage carries no animation, so this cannot fight the keyframes
  // that drive .buddy.
  win.webContents.on('did-finish-load', () => {
    const scale = Number(config.scale) > 0 ? Number(config.scale) : 1;
    win.webContents.insertCSS(`#stage { transform: scale(${scale}); }`);
    // The renderer has only just subscribed; catch it up on anything it
    // missed while the page was loading. See currentStateChange().
    pushStateChange(currentStateChange());
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

  Promise.resolve(server ? server.close() : undefined)
    .catch(() => {})
    .finally(() => app.quit());
});
