// Mictobystar POS for Windows. Opens the Mictobystar POS website in its own window.
// The website keeps a copy of the shop on this computer (app mode), so it keeps working without internet
// and sends everything to the shop when the internet is back.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const HOST = fs.readFileSync(path.join(__dirname, 'site.txt'), 'utf8').trim();
const START = 'https://' + HOST + '/pos?app=windows';
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const sameSite = u => { try { return new URL(u).host === HOST; } catch (e) { return false; } };
const local = u => /^(blob:|about:|data:)/.test(u);

function create() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 380, minHeight: 560, autoHideMenuBar: true, backgroundColor: '#f5f4ef',
    title: 'Mictobystar', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  win.maximize();
  // Links to other sites (WhatsApp, email, maps) open in the normal browser; the POS stays in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameSite(url) || local(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    if (/^(https?:|mailto:|tel:|sms:|whatsapp:)/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (sameSite(url) || local(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^(https?:|mailto:|tel:|sms:|whatsapp:)/.test(url)) shell.openExternal(url);
  });
  // First start with no internet: there is nothing saved on this computer yet.
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !String(url).startsWith('file:')) win.loadFile(path.join(__dirname, 'offline.html'), { query: { u: START } });
  });
  win.on('closed', () => { win = null; });
  win.loadURL(START);
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'Mictobystar', submenu: [
    { label: 'Reload', accelerator: 'F5', click: () => win && win.webContents.reload() },
    { label: 'Go to the start', click: () => win && win.loadURL(START) },
    { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' },
    { type: 'separator' }, { role: 'quit' } ] }
]));
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
