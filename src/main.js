'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage } = require('electron');

const { loadConfig } = require('./config.js');

const config = loadConfig();

let win = null;
let tray = null;

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

  // 'screen-saver' keeps the buddy above full-screen windows too.
  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

function createTray() {
  // A 1x1 transparent image keeps us dependency- and asset-free for now.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR4' +
      'AWMYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUAAAHkgABs1sVjwAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('Claude Buddy');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Listening on 127.0.0.1:${config.port}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

// A desktop pet has no business quitting when its window closes.
app.on('window-all-closed', () => app.quit());
