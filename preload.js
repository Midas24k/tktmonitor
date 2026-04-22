/**
 * preload.js
 * Exposes a clean, safe API to the renderer via contextBridge.
 * The renderer never touches Node APIs directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ticketBot', {
  // ── Commands (renderer → main) ──────────────────────────────────────────

  startMonitor: (config) => ipcRenderer.invoke('monitor:start', config),
  stopMonitor: ()        => ipcRenderer.invoke('monitor:stop'),
  confirmOrder: ()       => ipcRenderer.invoke('monitor:autofill'),
  resumeMonitor: ()      => ipcRenderer.invoke('monitor:resume'),

  saveProfile: (profile) => ipcRenderer.invoke('profile:save', profile),
  loadProfile: ()        => ipcRenderer.invoke('profile:load'),

  // ── Events (main → renderer) ────────────────────────────────────────────

  onLog: (cb) => {
    ipcRenderer.on('monitor:log', (_e, data) => cb(data));
    return () => ipcRenderer.removeAllListeners('monitor:log');
  },
  onFound: (cb) => {
    ipcRenderer.on('monitor:found', (_e, result) => cb(result));
    return () => ipcRenderer.removeAllListeners('monitor:found');
  },
  onAutofillComplete: (cb) => {
    ipcRenderer.on('monitor:autofillComplete', cb);
    return () => ipcRenderer.removeAllListeners('monitor:autofillComplete');
  },
  onCaptchaDetected: (cb) => {
    ipcRenderer.on('monitor:captchaDetected', cb);
    return () => ipcRenderer.removeAllListeners('monitor:captchaDetected');
  },
});
