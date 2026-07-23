'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog } = require('electron');

const { loadConfig } = require('./config.js');
const { createStateMachine } = require('./state-machine.js');
const { createEventServer } = require('./server.js');

const config = loadConfig();

/** How often to check whether the buddy should fall asleep. */
const TICK_INTERVAL_MS = 15 * 1000;

let win = null;
let tray = null;
let server = null;
let tickTimer = null;

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
    },
  });

  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');

  // Apply config.scale by injecting a rule rather than widening the IPC
  // surface. #stage carries no animation, so this cannot fight the keyframes
  // that drive .buddy.
  win.webContents.on('did-finish-load', () => {
    const scale = Number(config.scale) > 0 ? Number(config.scale) : 1;
    win.webContents.insertCSS(`#stage { transform: scale(${scale}); }`);
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

app.on('before-quit', async () => {
  clearInterval(tickTimer);
  if (server) await server.close();
});
