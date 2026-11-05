'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron');
const path = require('path');

app.setName('Renatel Shop POS');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  const isAppUrl = (u) => u.startsWith('file://');
  const openOutside = (u) => {
    if (/^(https?:|mailto:|sms:|tel:)/i.test(u)) shell.openExternal(u);
  };

  function createWindow() {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 360,
      minHeight: 500,
      backgroundColor: '#f6f5f1',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, 'app', 'index.html'));

    // Links (WhatsApp, email, etc.) open in the normal browser / mail app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!isAppUrl(url)) {
        e.preventDefault();
        openOutside(url);
      }
    });
    win.on('closed', () => { win = null; });
  }

  // ---- Replacement for alert / confirm / prompt (not supported in desktop apps) ----
  const pending = new Map();

  ipcMain.on('native-dialog', (event, req) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const type = ['alert', 'confirm', 'prompt'].includes(req && req.type) ? req.type : 'alert';
    const w = new BrowserWindow({
      parent: parent || undefined,
      modal: !!parent,
      width: 460,
      height: type === 'prompt' ? 300 : 240,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      title: 'Renatel Shop POS',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'dialogPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    w.removeMenu();
    const id = w.webContents.id;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      event.returnValue = val;
    };
    pending.set(id, finish);
    w.on('closed', () => {
      // Closed without pressing a button = cancel
      finish(type === 'confirm' ? false : type === 'prompt' ? null : true);
      pending.delete(id);
      if (parent && !parent.isDestroyed()) {
        parent.focus();
        parent.webContents.focus();
      }
    });
    w.once('ready-to-show', () => w.show());
    w.loadFile(path.join(__dirname, 'dialog.html'), {
      query: {
        type,
        message: String(req && req.message != null ? req.message : ''),
        def: String(req && req.def != null ? req.def : '')
      }
    });
  });

  ipcMain.on('dialog-done', (event, val) => {
    const f = pending.get(event.sender.id);
    if (f) f(val);
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) w.close();
  });

  app.whenReady().then(() => {
    // No camera, microphone, location etc. for the shop page.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'View',
        submenu: [
          { role: 'reload', accelerator: 'CmdOrCtrl+R' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
    ]));

    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => app.quit());
}
