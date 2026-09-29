"use strict";

// Electron-Hülle von Zero1 checkout.
//
// Zwei Vorbilder, zwei Gegenstellen:
//
//   Seriennummer und Aktualisierung wie bei Zero1 arena, gegen
//   checkout.null1.media (Repo null1.media). Das ist das Produkt.
//
//   Kopplung und Abgleich wie bei der HSG Kartenkasse, gegen
//   tv-fridingen.de/checkout/. Das sind die Daten des Vereins.
//
// Wie bei der Kartenkasse gibt es keinen HTTP-Server: Die Oberfläche spricht
// über preload.js und IPC mit diesem Prozess — mit contextIsolation und ohne
// Node im Renderer.
//
// Die Reihenfolge beim Start ist nicht beliebig:
//
//   1. Datenverzeichnis und Konfiguration
//   2. Ladebildschirm
//   3. Seriennummer    — nur, wenn keine hinterlegt ist. Ohne sie gibt es
//                        keine Aktualisierungen.
//   4. Aktualisierung  — vor allem anderen, damit schon der neue Code
//                        koppelt und abgleicht
//   5. Kopplung        — nur, wenn kein Kassentoken da ist. Ohne Token gibt
//                        es keine Daten.
//   6. Abgleich        — beim allerersten Start Pflicht, danach mit kurzer
//                        Wartezeit: Ohne Netz öffnet die Kasse mit dem
//                        lokalen Stand
//   7. Kassenfenster

const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } = require("electron"),
      fs = require("fs"),
      path = require("path");

const PRODUCT = "Zero1 checkout";

// Nur eine Instanz. Zwei Kopien schrieben gleichzeitig in dieselbe Datenbank.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName(PRODUCT);

// Das Datenverzeichnis fest benennen, statt es aus dem Namen ableiten zu
// lassen: Ein späterer Wechsel des Anzeigenamens soll die Daten nicht in ein
// neues, leeres Verzeichnis verlegen.
//
// Im Quelltextbetrieb lässt sich das Verzeichnis über ZERO1_CHECKOUT_DATA_DIR
// umlegen — für Probeläufe gegen einen Testserver, ohne das echte Profil
// anzufassen. %APPDATA% umzubiegen hilft dafür nicht: Electron fragt unter
// Windows den Ordner beim System ab, nicht die Umgebungsvariable.
app.setPath("userData", !app.isPackaged && process.env.ZERO1_CHECKOUT_DATA_DIR
  ? path.resolve(process.env.ZERO1_CHECKOUT_DATA_DIR)
  : path.join(app.getPath("appData"), "zero1-checkout"));

const paths = require("./utils/paths"),
      logger = require("./utils/logger"),
      splashView = require("./utils/splash");

paths.setDataDir(app.getPath("userData"));

let config = null;

try {
  config = require("./utils/config").load();
}
catch(e) {
  dialog.showErrorBox(`${PRODUCT} konnte nicht starten`, `${e.message}\n\nDatenverzeichnis:\n${paths.dataDir}`);
  app.exit(1);
}

const { Api } = require("./utils/api"),
      { Store, StoreError } = require("./utils/store"),
      { Sync } = require("./utils/sync"),
      { PinGuard } = require("./utils/pin"),
      { Printer } = require("./utils/printer");

let splash = null,
    mainWindow = null,
    settingsWindow = null,
    device = null,
    api = null,
    store = null,
    sync = null,
    printer = null,
    quitting = false;

// Fenster- und Taskleistensymbol im Null1-Design wie bei Zero1 arena. Das
// Vereinslogo steht nur in der Kassenoberfläche.
const ICON = path.join(__dirname, "public", "img", "favicon.ico");

/* ------------------------------------------------------ Ladebildschirm */

function splashHtml() {
  let logo = "",
      copyright = "";

  try {
    logo = fs.readFileSync(path.join(__dirname, "public", "img", "zero1-checkout.png")).toString("base64");
  }
  catch(e) {
    // Ohne Logo schmuckloser, aber nicht kaputt.
  }

  try {
    copyright = require("./package.json").build.copyright || "";
  }
  catch(e) {
    // Im gepackten Programm fehlt der build-Block womöglich. Dann eben ohne.
  }

  return splashView.html({ logo, version: app.getVersion(), copyright });
}

function createSplash() {
  splashOpenedAt = Date.now();
  splash = new BrowserWindow({
    // Breite wie bei Zero1 arena (Platz für die Copyright-Zeile), höher für
    // die Abfrage des Kopplungscodes samt Knöpfen.
    width: 620,
    height: 400,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: false,
    title: PRODUCT,
    icon: ICON,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(splashHtml()));
  splash.once("ready-to-show", () => splash && !splash.isDestroyed() && splash.show());
}

// Jede Meldung bleibt mindestens so lange stehen, dass man sie lesen kann.
// Kommt in der Zeit eine neue, ersetzt sie die wartende (wie bei Zero1 arena).
const SPLASH_MIN_MS = 420;

// Und der Ladebildschirm als Ganzes bleibt mindestens drei Sekunden stehen,
// auch wenn der Start schneller fertig ist: mit lokalem Bestand und ohne
// Aktualisierung blitzte er sonst nur kurz auf.
const SPLASH_MIN_TOTAL_MS = 3000;

let splashWaiting = null,
    splashTimer = null,
    splashLast = 0,
    splashOpenedAt = 0;

// Die Uebergabe an das Kassenfenster: erst, wenn die drei Sekunden voll
// sind. Ohne Ladebildschirm — das Fenster wird spaeter noch einmal
// geoeffnet — geschieht sie sofort.
function splashHold(done) {
  const rest = splash && !splash.isDestroyed() ? SPLASH_MIN_TOTAL_MS - (Date.now() - splashOpenedAt) : 0;

  if (rest > 0) {
    setTimeout(done, rest);

    return;
  }

  done();
}

function splashSend(message) {
  if (splash && !splash.isDestroyed()) {
    splash.webContents.executeJavaScript(`window.postMessage(${JSON.stringify(message)}, "*")`).catch(() => {});
  }
}

function splashStatus(text, anteil = null) {
  const draw = (entry) => {
    splashLast = Date.now();
    splashSend({ modus: "status", text: entry.text, anteil: entry.anteil });
  };

  const rest = SPLASH_MIN_MS - (Date.now() - splashLast);

  if (rest <= 0 && !splashTimer) {
    draw({ text, anteil });

    return;
  }

  splashWaiting = { text, anteil };

  if (!splashTimer) {
    splashTimer = setTimeout(() => {
      splashTimer = null;

      if (splashWaiting) {
        draw(splashWaiting);
        splashWaiting = null;
      }
    }, Math.max(0, rest));
  }
}

// Eine Frage an den Ladebildschirm, Antwort über ein Promise in der Seite.
async function splashAsk(message) {
  if (splashTimer) {
    clearTimeout(splashTimer);
    splashTimer = null;
    splashWaiting = null;
  }

  splashSend(message);

  try {
    return await splash.webContents.executeJavaScript("new Promise((r) => { window.__antwort = r; })", true);
  }
  catch(e) {
    return null;
  }
}

function closeSplash() {
  if (splashTimer) {
    clearTimeout(splashTimer);
    splashTimer = null;
  }

  if (splash && !splash.isDestroyed()) {
    splash.destroy();
  }

  splash = null;
}

/* ------------------------------------------------------------ Kopplung */

const deviceStore = require("./utils/device").create({
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (buffer) => safeStorage.decryptString(buffer)
}, logger);

async function pairWithCode(code) {
  const result = await api.pair(code);

  device = { id: result.device.id, name: result.device.name, token: result.token };
  deviceStore.save(device);
  api.setToken(device.token);
  logger.success(`Gekoppelt als "${device.name}".`);

  return device;
}

// Rückgabe: false, wenn beendet werden soll.
async function ensurePaired(reason = "") {
  let fehler = reason;

  for (;;) {
    const code = await splashAsk({ modus: "code", fehler });

    if (!code) {
      return false;
    }

    splashStatus("Kasse wird gekoppelt…");

    try {
      await pairWithCode(code);

      return true;
    }
    catch(e) {
      fehler = e.art === "netz"
        ? "Der Vereinsserver ist nicht erreichbar. Besteht eine Internetverbindung?"
        : e.message;
      logger.warn(`Kopplung fehlgeschlagen (${e.art}): ${e.message}`);
    }
  }
}

/* ------------------------------------------------------- Seriennummer */

// Die Seriennummer, wie bei Zero1 arena: Sie steckt als token in
// update.manifestUrl und wird nur abgefragt, wenn KEINE hinterlegt ist. Eine
// hinterlegte wird beim Start nicht geprüft — sonst stünde die Kasse auf
// einem Fest ohne Internet vor derselben Abfrage, obwohl alles da ist.
//
// Rückgabe: false, wenn beendet werden soll.
async function ensureSerial() {
  if (!config.update || config.update.enabled === false || !app.isPackaged) {
    return true;
  }

  const updater = require("./utils/updater"),
        basis = config.update.manifestUrl || "";

  if (updater.tokenAus(basis)) {
    return true;
  }

  if (!basis) {
    logger.warn("Keine Adresse für Aktualisierungen hinterlegt — es wird nicht nach einer Seriennummer gefragt.");

    return true;
  }

  let fehler = "";

  for (;;) {
    const eingabe = await splashAsk({ modus: "seriennummer", fehler });

    if (!eingabe) {
      logger.warn("Keine Seriennummer eingegeben. Die Kasse wird beendet.");

      return false;
    }

    splashStatus("Seriennummer wird geprüft…");

    const url = updater.mitToken(basis, eingabe),
          ergebnis = await updater.pruefeZugang({ manifestUrl: url, token: eingabe, timeoutMs: config.update.timeoutMs || 10000 });

    if (ergebnis.ok) {
      logger.success(`Seriennummer anerkannt. Der Server meldet Version ${ergebnis.version}.`);

      try {
        config = require("./utils/config").save({ update: { manifestUrl: url } });
      }
      catch(e) {
        logger.error(`Die Seriennummer konnte nicht gespeichert werden: ${e.message}`);
      }

      return true;
    }

    // Abgelehnt oder nicht erreichbar: Das eine löst man mit einer anderen
    // Nummer, das andere mit einem Netzwerkkabel.
    fehler = ergebnis.grund === "netz"
      ? "Der Server ist nicht erreichbar. Besteht eine Internetverbindung?"
      : "Diese Seriennummer wurde nicht anerkannt.";

    logger.warn(`Seriennummer abgelehnt (${ergebnis.grund}${ergebnis.message ? ": " + ergebnis.message : ""}).`);
  }
}

/* ------------------------------------------------------ Aktualisierung */

// Rückgabe: true, wenn neu gestartet werden muss.
async function checkForUpdate() {
  if (!config.update || config.update.enabled === false) {
    logger.info("Die Aktualisierung ist abgeschaltet.");

    return false;
  }

  // Aus dem Quelltext heraus nie: Dort ist das Programmverzeichnis die
  // Git-Ablage, und der Updater ersetzte darin Dateien.
  if (!app.isPackaged) {
    logger.info("Quelltextbetrieb: Es wird nicht nach Aktualisierungen gesucht.");

    return false;
  }

  try {
    const result = await require("./utils/updater").run({
      appDir: paths.appDir,
      assetsDir: paths.assets,
      dataDir: paths.dataDir,
      logger,
      config,
      onStatus: splashStatus
    });

    if (result.status === "aktualisiert" && result.programChanged) {
      splashStatus("Neustart…", 1);

      return true;
    }

    return false;
  }
  catch(e) {
    // Eine gescheiterte Aktualisierung darf den Start nicht verhindern. An der
    // Kasse ist die alte Fassung immer besser als gar keine.
    logger.error(`Aktualisierung fehlgeschlagen: ${e.stack || e.message}`);

    return false;
  }
}

/* ------------------------------------------------------------ Abgleich */

// Rückgabe: false, wenn beendet werden soll.
async function initialSync() {
  for (;;) {
    const first = !sync.hasData();

    splashStatus(first ? "Datenbestand wird geladen…" : "Abgleich mit dem Vereinsserver…");

    const result = await sync.run({ timeoutMs: first ? config.sync.timeoutMs : config.sync.startTimeoutMs });

    if (result.ok) {
      return true;
    }

    if (result.error.art === "gesperrt") {
      deviceStore.clear();

      if (!await ensurePaired("Diese Kasse ist nicht mehr freigeschaltet. Bitte einen neuen Kopplungscode eingeben.")) {
        return false;
      }

      continue;
    }

    // Mit lokalem Stand geht es auch ohne Netz weiter. Beim allerersten Start
    // gibt es keinen — dann muss gefragt werden.
    if (!first) {
      logger.warn(`Start ohne Abgleich: ${result.error.message}`);

      return true;
    }

    const again = await splashAsk({
      modus: "frage",
      text: `Beim ersten Start braucht die Kasse einmal den Datenbestand des Vereins. ${result.error.message}`,
      ja: "Erneut versuchen",
      nein: "Beenden"
    });

    if (!again) {
      return false;
    }
  }
}

/* ------------------------------------------------------------- Fenster */

const WEB_PREFERENCES = {
  preload: path.join(__dirname, "preload.js"),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true
};

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: PRODUCT,
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: "#2b292a",
    webPreferences: WEB_PREFERENCES
  });

  // Der Ladebildschirm verschwindet genau dann, wenn die Kasse gezeichnet
  // ist — nicht früher, sonst blitzt dazwischen der Schreibtisch auf.
  mainWindow.once("ready-to-show", () => {
    splashHold(() => {
      closeSplash();
      mainWindow.maximize();
      mainWindow.show();
    });
  });

  mainWindow.loadFile(path.join(__dirname, "public", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);

    return { action: "deny" };
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logger.error(`Kassenoberfläche abgestürzt (${details.reason}), wird neu geladen.`);
    mainWindow.reload();
  });

  // Vor dem Schließen noch einmal abgleichen, wenn etwas offen ist. Gelingt
  // es nicht, bleibt es gespeichert und geht beim nächsten Start hinüber —
  // das wird gesagt, aber nicht verhindert.
  mainWindow.on("close", async (event) => {
    if (quitting || !store || store.pendingCount() === 0) {
      return;
    }

    event.preventDefault();
    quitting = true;

    const result = await sync.run({ timeoutMs: 5000 });
    const open = store.pendingCount();

    if (!result.ok && open > 0) {
      await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: PRODUCT,
        message: `${open} Änderung(en) sind noch nicht auf dem Vereinsserver.`,
        detail: "Sie bleiben auf dieser Kasse gespeichert und werden beim nächsten Start mit Internetverbindung übertragen.",
        buttons: ["Beenden"]
      });
    }

    app.quit();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;

    // Das unsichtbare Druckfenster hielte das Programm sonst am Leben:
    // window-all-closed kommt erst, wenn wirklich kein Fenster mehr offen ist.
    if (printer) {
      printer.close();
    }
  });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();

    return;
  }

  settingsWindow = new BrowserWindow({
    width: 820,
    height: 760,
    title: `${PRODUCT} — Einstellungen`,
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: "#2b292a",
    parent: mainWindow || undefined,
    webPreferences: WEB_PREFERENCES
  });

  settingsWindow.loadFile(path.join(__dirname, "public", "settings.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// Aus dem Menü: offen, wenn entsperrt; sonst fragt die Kasse nach der PIN.
function requestSettings() {
  if (!store || unlocked()) {
    openSettings();
  }
  else if (mainWindow) {
    mainWindow.webContents.send("checkout:ask-settings", {});
  }
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== splash && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function buildMenu() {
  const template = [
    {
      label: "Anwendung",
      submenu: [
        { label: "Einstellungen", accelerator: "Ctrl+,", click: () => requestSettings() },
        { label: "Jetzt abgleichen", accelerator: "F9", click: () => sync && sync.run() },
        { type: "separator" },
        { label: "Oberfläche neu laden", accelerator: "F5", click: () => mainWindow && mainWindow.reload() },
        { type: "separator" },
        { label: "Beenden", accelerator: "Alt+F4", click: () => (mainWindow ? mainWindow.close() : app.quit()) }
      ]
    },
    {
      label: "Hilfe",
      submenu: [
        { label: "Protokoll öffnen", click: () => shell.openPath(logger.getLogFile()) },
        { label: "Protokollordner öffnen", click: () => shell.openPath(logger.getLogDir()) },
        { label: "Datenverzeichnis öffnen", click: () => shell.openPath(paths.dataDir) },
        { type: "separator" },
        { label: `Version ${app.getVersion()}`, enabled: false }
      ]
    }
  ];

  if (config.debug || !app.isPackaged) {
    template.push({ label: "Entwicklung", submenu: [{ role: "toggleDevTools" }, { role: "forceReload" }] });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ----------------------------------------------------------------- IPC */

// Jede Funktion der Oberfläche steht hier UND in preload.js. Fehler gehen als
// Meldung zurück statt als Ausnahme — über IPC käme sonst nur "Error invoking
// remote method" an.
function registerIpc() {
  const info = () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    server: config.server,
    // Nur ob, nie welche: Die Seriennummer gehört nicht in die Oberfläche.
    serial: Boolean(require("./utils/updater").tokenAus(config.update.manifestUrl || "")),
    updateServer: (() => { try { return new URL(config.update.manifestUrl).origin; } catch(e) { return ""; } })(),
    dataDir: paths.dataDir,
    device: device ? { id: device.id, name: device.name } : null,
    settings: store.settings(),
    schema: store.schemaVersion(),
    sync: sync.status()
  });

  ipcMain.handle("checkout:info", () => info());
  ipcMain.handle("checkout:sync", async () => {
    const result = await sync.run();

    return { ok: result.ok, message: result.ok ? "" : result.error.message };
  });
  // Die Einstellungen liegen hinter der PIN; ohne sie fragt die Oberfläche
  // erst danach und ruft dann erneut.
  ipcMain.handle("checkout:open-settings", () => {
    if (!unlocked()) {
      return { ok: false, locked: true };
    }

    openSettings();

    return { ok: true };
  });
  ipcMain.handle("checkout:open-path", (_event, which) => shell.openPath(which === "logs" ? logger.getLogDir() : paths.dataDir));

  ipcMain.handle("checkout:config", () => config);
  ipcMain.handle("checkout:config-defaults", () => require("./utils/config").DEFAULTS);
  ipcMain.handle("checkout:config-save", (_event, patch) => {
    if (!unlocked()) {
      return config;
    }

    config = require("./utils/config").save(patch);

    return config;
  });

  // Neu koppeln aus den Einstellungen — nach dem Sperren oder einer
  // Neuinstallation auf einem anderen Gerät. Der lokale Bestand bleibt; was
  // noch nicht übertragen ist, geht mit dem neuen Token hinüber.
  ipcMain.handle("checkout:pair", async (_event, code) => {
    try {
      await pairWithCode(String(code || ""));
      sync.start();
      const result = await sync.run();

      return { ok: true, device: { id: device.id, name: device.name }, synced: result.ok };
    }
    catch(e) {
      return { ok: false, message: e.art === "netz" ? "Der Vereinsserver ist nicht erreichbar." : e.message };
    }
  });

  sync.on("status", (status) => broadcast("checkout:status", status));
  sync.on("notices", (notices) => broadcast("checkout:notices", notices));
  sync.on("synced", () => broadcast("checkout:data", {}));

  registerKasseIpc();
}

/* ------------------------------------------------------------- Kasse */

// Hinter der PIN: alles außer Kassieren. Entsperrt wird für eine Weile; jede
// geschützte Aktion verlängert, "Sperren" in der Oberfläche beendet sofort.
const UNLOCK_MS = 5 * 60 * 1000;

let unlockedUntil = 0,
    lastSaleUuid = null;

const pinGuard = new PinGuard();

function unlocked() {
  const pinHash = store.settings().pin || "";

  return !pinHash || Date.now() < unlockedUntil;
}

// Kontext für Bons und Belege: wer, wo, wofür.
function printContext(event) {
  const organizer = event ? store.organizer(event.organizer) : null;

  return {
    device: device ? device.name : "",
    event: event ? event.name : "",
    organizer: organizer ? organizer.name : "",
    address: organizer ? organizer.address : "",
    tax_number: organizer ? organizer.tax_number : "",
    footer: event ? event.receipt_footer : "",
    printed_at: require("./utils/store").localDateTime()
  };
}

function registerKasseIpc() {
  // Eine Aktion der Oberfläche: Fehler der Fachlichkeit als Meldung zurück,
  // alles andere ins Protokoll.
  const handle = (channel, fn, { locked = false } = {}) => ipcMain.handle(channel, async (_event, ...args) => {
    if (locked) {
      if (!unlocked()) {
        return { ok: false, locked: true, message: "Bitte zuerst die PIN eingeben." };
      }

      unlockedUntil = Math.max(unlockedUntil, Date.now() + UNLOCK_MS);
    }

    try {
      return { ok: true, ...(await fn(...args)) };
    }
    catch(e) {
      if (!(e instanceof StoreError)) {
        logger.error(`${channel}: ${e.stack || e.message}`);
      }

      return { ok: false, message: e instanceof StoreError ? e.message : "Das hat nicht geklappt. Näheres steht im Protokoll." };
    }
  });

  // Nach jeder Änderung: bald abgleichen und alle Fenster neu zeichnen.
  const changed = () => {
    sync.schedule();
    broadcast("checkout:data", {});
  };

  handle("checkout:state", () => {
    const event = store.activeEvent(),
          settings = store.settings(),
          deviceInfo = store.getMeta("device") || {};

    return {
      // Das SumUp-Terminal dieser Kasse laut letztem Abgleich; null heißt:
      // Karte von Hand ins Terminal tippen.
      terminal: deviceInfo.terminal || null,
      event: event ? { ...event, deposit_return: Boolean(event.deposit_return) } : null,
      organizer: event ? store.organizer(event.organizer) : null,
      layout: event ? store.layout(event.uuid) : { categories: [], articles: [] },
      events: store.events().map((e) => ({ uuid: e.uuid, name: e.name, starts_on: e.starts_on, ends_on: e.ends_on })),
      clubName: settings.club_name || "",
      pinSet: Boolean(settings.pin),
      unlocked: Boolean(settings.pin) && Date.now() < unlockedUntil,
      lastSale: lastSaleUuid ? store.sale(lastSaleUuid) : null
    };
  });

  /* Verkaufen: ohne PIN */

  handle("checkout:sell", ({ items, payment, given = null, sumup_tx = null }) => {
    const event = store.activeEvent(),
          sale = store.createSale({ event: event && event.uuid, items, payment, given, sumup_tx });

    lastSaleUuid = sale.uuid;
    logger.info(`Verkauf ${sale.number}: ${sale.items.length} Position(en), ${(sale.total / 100).toFixed(2)} €, ${sale.payment}.`);
    sync.schedule();

    // Gedruckt wird hinter der Antwort: Die Kasse ist sofort frei für den
    // nächsten Gast. Klemmt der Drucker, sagt es ein Hinweis.
    printer.bons(sale, printContext(event)).then((result) => {
      if (!result.ok) {
        broadcast("checkout:notices", [{ uuid: sale.uuid, level: "error", message: `Bons zu Verkauf ${sale.number} nicht gedruckt. ${result.message}` }]);
      }
    });

    return { sale };
  });

  // Der Beleg zum letzten Verkauf geht ohne PIN (der Gast steht noch da),
  // jeder andere nur entsperrt.
  handle("checkout:receipt", async (uuid) => {
    if (uuid !== lastSaleUuid && !unlocked()) {
      return { ok: false, locked: true, message: "Bitte zuerst die PIN eingeben." };
    }

    const sale = store.sale(uuid);

    if (!sale) {
      throw new StoreError("Diesen Verkauf gibt es nicht.");
    }

    return await printer.receipt(sale, printContext(store.event(sale.event)));
  });

  /* Kartenzahlung über den Vereinsserver (SumUp) */

  // Fehler der Verbindung als Ergebnis, nicht als Ausnahme: Die Oberfläche
  // entscheidet, ob es von Hand weitergeht.
  const card = async (fn) => {
    try {
      return await fn();
    }
    catch(e) {
      logger.warn(`Kartenzahlung: ${e.message}`);

      return { ok: false, reason: e.art === "netz" ? "netz" : "server", message: e.art === "netz" ? "Der Vereinsserver ist nicht erreichbar." : e.message };
    }
  };

  handle("checkout:card-start", async ({ amount, description }) => {
    const result = await card(() => api.cardStart({ amount, description }));

    if (result.ok) {
      logger.info(`Kartenzahlung angestoßen: ${(amount / 100).toFixed(2)} € an ${result.terminal} (${result.payment.id}).`);
    }

    return { result };
  });

  handle("checkout:card-status", async (id) => ({ result: await card(() => api.cardStatus(id)) }));

  handle("checkout:card-cancel", async (id) => {
    const result = await card(() => api.cardCancel(id));

    logger.info(`Kartenzahlung ${id} abgebrochen: ${result.ok ? result.payment.status : result.message}`);

    return { result };
  });

  /* PIN */

  handle("checkout:unlock", (pin) => {
    const result = pinGuard.check(String(pin || ""), store.settings().pin || "");

    if (!result.ok) {
      throw new StoreError(result.message);
    }

    unlockedUntil = Date.now() + UNLOCK_MS;

    return { unprotected: Boolean(result.unprotected) };
  });

  handle("checkout:lock", () => {
    unlockedUntil = 0;

    return {};
  });

  /* Hinter der PIN */

  const locked = { locked: true };

  handle("checkout:set-event", (uuid) => {
    store.setActiveEvent(uuid);
    logger.info(`Veranstaltung gewechselt: ${store.event(uuid).name}`);
    broadcast("checkout:data", {});

    return {};
  }, locked);

  handle("checkout:save-category", (data) => {
    const uuid = store.saveCategory({ ...data, event: store.activeEvent().uuid });

    changed();

    return { uuid };
  }, locked);

  handle("checkout:delete-category", (uuid) => {
    store.deleteCategory(uuid);
    changed();

    return {};
  }, locked);

  handle("checkout:save-article", (data) => {
    const uuid = store.saveArticle({ ...data, event: store.activeEvent().uuid });

    changed();

    return { uuid };
  }, locked);

  handle("checkout:delete-article", (uuid) => {
    store.deleteArticle(uuid);
    changed();

    return {};
  }, locked);

  handle("checkout:sold-out", (uuid, soldOut) => {
    store.setSoldOut(uuid, soldOut);
    changed();

    return {};
  }, locked);

  handle("checkout:save-layout", (layout) => {
    const count = store.saveLayout(store.activeEvent().uuid, layout);

    if (count) {
      changed();
    }

    return { changed: count };
  }, locked);

  handle("checkout:recent-sales", () => {
    const event = store.activeEvent();

    return { sales: event ? store.recentSales(event.uuid) : [] };
  }, locked);

  handle("checkout:cancel-sale", (uuid, reason) => {
    const sale = store.cancelSale(uuid, reason);

    logger.info(`Verkauf ${sale.number} storniert: ${reason || "ohne Grund"}`);
    changed();

    return { sale };
  }, locked);

  handle("checkout:add-cash", ({ kind, amount, note }) => {
    const entry = store.addCash({ event: store.activeEvent() && store.activeEvent().uuid, kind, amount, note });

    logger.info(`Kassenbewegung ${kind}: ${(amount / 100).toFixed(2)} €`);
    changed();

    return { entry };
  }, locked);

  handle("checkout:summary", (day = null) => {
    const event = store.activeEvent();

    if (!event) {
      throw new StoreError("Es ist keine Veranstaltung gewählt.");
    }

    const days = store.businessDays(event.uuid),
          chosen = day || days[0] || require("./utils/store").businessDay(require("./utils/store").localDateTime(), event.day_change);

    return { days, summary: store.daySummary(event.uuid, chosen) };
  }, locked);

  handle("checkout:print-summary", async (day) => {
    const event = store.activeEvent();

    return await printer.summary(store.daySummary(event.uuid, day), printContext(event));
  }, locked);

  /* Einstellungen: Drucker */

  handle("checkout:printers", async () => ({ printers: await printer.list(mainWindow ? mainWindow.webContents : BrowserWindow.getAllWindows()[0].webContents) }));
  handle("checkout:print-test", async () => await printer.test(printContext(store.activeEvent())));
}

/* --------------------------------------------------------------- Start */

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  // Während des Starts gibt es kurz kein Fenster (Ladebildschirm zu,
  // Kasse noch nicht offen). Beendet wird erst, wenn die Kasse lief.
  if (mainWindow === null && store) {
    app.quit();
  }
});

app.on("will-quit", () => {
  if (sync) {
    sync.stop();
  }

  if (store) {
    try {
      store.close();
    }
    catch(e) {
      // Beim Beenden ist das egal.
    }
  }
});

function exitFromSplash(text) {
  splashStatus(text);
  setTimeout(() => {
    closeSplash();
    app.exit(0);
  }, 900);
}

app.whenReady().then(async () => {
  createSplash();
  buildMenu();

  logger.info(`${PRODUCT} ${app.getVersion()} startet. Datenverzeichnis: ${paths.dataDir}`);

  if (!await ensureSerial()) {
    exitFromSplash("Die Kasse wird beendet.");

    return;
  }

  if (await checkForUpdate()) {
    logger.info("Programmdateien aktualisiert, Neustart.");
    closeSplash();
    app.relaunch();
    app.exit(0);

    return;
  }

  device = deviceStore.load();
  api = new Api({
    baseUrl: config.server,
    token: device ? device.token : null,
    version: app.getVersion(),
    timeoutMs: config.sync.timeoutMs
  });

  if (!device && !await ensurePaired()) {
    exitFromSplash("Die Kasse wird beendet.");

    return;
  }

  try {
    store = new Store(paths.database);
  }
  catch(e) {
    closeSplash();
    dialog.showErrorBox(`${PRODUCT} konnte nicht starten`, `Die lokale Datenbank lässt sich nicht öffnen: ${e.message}

${paths.database}`);
    app.exit(1);

    return;
  }

  sync = new Sync({ store, api, logger, intervalSeconds: config.sync.intervalSeconds, timeoutMs: config.sync.timeoutMs });

  if (!await initialSync()) {
    exitFromSplash("Die Kasse wird beendet.");

    return;
  }

  printer = new Printer({ logger, getConfig: () => config, dataDir: paths.dataDir });

  registerIpc();
  sync.start();

  splashStatus("Kasse wird geöffnet…");
  createMainWindow();
});
