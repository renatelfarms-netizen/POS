'use strict';
// Gives the shop page working alert(), confirm() and prompt() in the desktop app.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('__nativeDialog', (type, message, def) =>
  ipcRenderer.sendSync('native-dialog', { type, message, def })
);

webFrame.executeJavaScript(`
  (function () {
    var nd = window.__nativeDialog;
    window.alert = function (m) { nd('alert', m == null ? '' : String(m)); };
    window.confirm = function (m) { return nd('confirm', m == null ? '' : String(m)) === true; };
    window.prompt = function (m, d) {
      var v = nd('prompt', m == null ? '' : String(m), d == null ? '' : String(d));
      return v == null ? null : String(v);
    };
    window.__isDesktopApp = true;
  })();
`);
