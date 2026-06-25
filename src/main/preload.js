'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('df', {
  pickProject: () => ipcRenderer.invoke('pick-project'),
  loadProject: (p) => ipcRenderer.invoke('load-project', p),
  listProjects: () => ipcRenderer.invoke('list-projects'),
  removeProject: (p) => ipcRenderer.invoke('remove-project', p),
  checkConnection: () => ipcRenderer.invoke('check-connection'),
  detectTools: () => ipcRenderer.invoke('detect-tools'),
  installCli: (which) => ipcRenderer.invoke('install-cli', which),
  openLogin: (which) => ipcRenderer.invoke('open-login', which),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  generateDescription: (p) => ipcRenderer.invoke('generate-description', p),
  saveConfig: (path, patch) => ipcRenderer.invoke('save-config', { path, patch }),
  start: (p, mode) => ipcRenderer.invoke('start', { path: p, mode }),
  stop: () => ipcRenderer.invoke('stop'),
  isRunning: () => ipcRenderer.invoke('is-running'),
  directive: (path, text) => ipcRenderer.invoke('directive', { path, text }),
  on: (channel, cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  }
});
