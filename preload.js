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
  onNotices: (callback) => on("checkout:notices", callback),
  onData: (callback) => on("checkout:data", callback),
  onAskSettings: (callback) => on("checkout:ask-settings", callback),

  // Kassieren
  state: () => ipcRenderer.invoke("checkout:state"),
  sell: (sale) => ipcRenderer.invoke("checkout:sell", sale),
  receipt: (uuid) => ipcRenderer.invoke("checkout:receipt", uuid),
  cardStart: (payment) => ipcRenderer.invoke("checkout:card-start", payment),
  cardStatus: (id) => ipcRenderer.invoke("checkout:card-status", id),
  cardCancel: (id) => ipcRenderer.invoke("checkout:card-cancel", id),
  cardPending: () => ipcRenderer.invoke("checkout:card-pending"),
  cardBook: (id) => ipcRenderer.invoke("checkout:card-book", id),

  // PIN
  unlock: (pin) => ipcRenderer.invoke("checkout:unlock", pin),
  lock: () => ipcRenderer.invoke("checkout:lock"),

  // Hinter der PIN
  setEvent: (uuid) => ipcRenderer.invoke("checkout:set-event", uuid),
  saveCategory: (data) => ipcRenderer.invoke("checkout:save-category", data),
  deleteCategory: (uuid) => ipcRenderer.invoke("checkout:delete-category", uuid),
  saveArticle: (data) => ipcRenderer.invoke("checkout:save-article", data),
  deleteArticle: (uuid) => ipcRenderer.invoke("checkout:delete-article", uuid),
  soldOut: (uuid, soldOut) => ipcRenderer.invoke("checkout:sold-out", uuid, soldOut),
  saveLayout: (layout) => ipcRenderer.invoke("checkout:save-layout", layout),
  recentSales: () => ipcRenderer.invoke("checkout:recent-sales"),
  reprintBons: (uuid) => ipcRenderer.invoke("checkout:reprint-bons", uuid),
  cancelSale: (uuid, reason) => ipcRenderer.invoke("checkout:cancel-sale", uuid, reason),
  addCash: (entry) => ipcRenderer.invoke("checkout:add-cash", entry),
  summary: (day) => ipcRenderer.invoke("checkout:summary", day),
  printSummary: (day) => ipcRenderer.invoke("checkout:print-summary", day),

  // Einstellungen
  printers: () => ipcRenderer.invoke("checkout:printers"),
  printTest: () => ipcRenderer.invoke("checkout:print-test")
});
