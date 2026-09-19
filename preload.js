// Die Brücke zwischen Oberfläche und Hauptprozess.
//
// Die Oberfläche hat kein Node und keinen Zugriff auf IPC. Sie bekommt genau
// die Aufrufe, die hier stehen, als window.checkout — nicht mehr. Wer eine
// neue Funktion in die Oberfläche bringen will, trägt sie hier UND in main.js
// (registerIpc) ein.

const { contextBridge, ipcRenderer } = require("electron");

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);

  ipcRenderer.on(channel, listener);

  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("checkout", {
  info: () => ipcRenderer.invoke("checkout:info"),
  sync: () => ipcRenderer.invoke("checkout:sync"),
  pair: (code) => ipcRenderer.invoke("checkout:pair", code),
  config: () => ipcRenderer.invoke("checkout:config"),
  saveConfig: (patch) => ipcRenderer.invoke("checkout:config-save", patch),
  configDefaults: () => ipcRenderer.invoke("checkout:config-defaults"),
  openSettings: () => ipcRenderer.invoke("checkout:open-settings"),
  openPath: (which) => ipcRenderer.invoke("checkout:open-path", which),
  onStatus: (callback) => on("checkout:status", callback),
  onNotices: (callback) => on("checkout:notices", callback)
});
