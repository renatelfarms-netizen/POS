'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dlg', {
  done: (value) => ipcRenderer.send('dialog-done', value)
});
