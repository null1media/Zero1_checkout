// Druck auf dem Bondrucker.
//
// An den Kassen ist der Bondrucker (SEWOO SLK-TL202, USB, 80 mm) als
// Standarddrucker eingerichtet, der Zettelschnitt im Treiber. Gedruckt wird
// still über Chromium: public/print.html in einem unsichtbaren Fenster, je
// Zettel ein eigener Druckauftrag. So schneidet der Drucker nach jedem Bon,
// ob der Treiber nun je Seite oder je Auftrag schneidet.
//
// Die Seitenlänge ergibt sich aus dem Inhalt; die Breite ist fest 80 mm.
//
// config.printer:
//   deviceName  leer = Standarddrucker
//   preview     statt zu drucken PDFs nach <Datenverzeichnis>/bons —
//               für den Probelauf ohne Drucker
//   enabled     false: gar nicht drucken (die Kasse bucht trotzdem)
//
// Aufträge laufen nacheinander. Ein zweiter Verkauf, während der erste noch
// druckt, stellt sich hinten an.

const { BrowserWindow } = require("electron"),
      fs = require("fs"),
      path = require("path");

const WIDTH_MICRONS = 80000,
      // Chromium rechnet mit 96 dpi.
      MICRONS_PER_PX = 25400 / 96,
      MIN_HEIGHT_MICRONS = 30000,
      // Luft unter dem Inhalt: Der Druck setzt Zeilen minimal anders als die
      // Messung im Fenster, ohne Zugabe rutschte die letzte Zeile auf eine
      // zweite Seite (und damit auf einen zweiten, fast leeren Zettel).
      SLACK_MICRONS = 6000;

class Printer {
  constructor({ logger, getConfig, dataDir }) {
    this.logger = logger;
    this.getConfig = getConfig;
    this.dataDir = dataDir;
    this.window = null;
    this.ready = null;
    this.queue = Promise.resolve();
  }

  settings() {
    return { enabled: true, deviceName: "", preview: false, ...(this.getConfig().printer || {}) };
  }

  // Das Druckfenster, einmal angelegt und wiederverwendet.
  page() {
    if (this.window && !this.window.isDestroyed()) {
      return this.ready;
    }

    this.window = new BrowserWindow({
      show: false,
      // Breiter als der Zettel (80 mm = 302 px): Eine Scrollleiste im
      // Fenster verschöbe sonst die Umbrüche gegenüber dem Druck.
      width: 420,
      height: 300,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    });

    this.ready = this.window.loadFile(path.join(__dirname, "..", "public", "print.html"));

    return this.ready;
  }

  // Einen Zettel drucken. Rückgabe erst, wenn der Auftrag beim Spooler ist.
  async printOne(doc, label) {
    const cfg = this.settings();

    await this.page();

    const heightPx = await this.window.webContents.executeJavaScript(`renderPrint(${JSON.stringify(doc)})`),
          height = Math.max(MIN_HEIGHT_MICRONS, Math.ceil(heightPx * MICRONS_PER_PX) + SLACK_MICRONS);

    if (cfg.preview) {
      const dir = path.join(this.dataDir, "bons"),
            pdf = await this.window.webContents.printToPDF({
              printBackground: false,
              margins: { top: 0, bottom: 0, left: 0, right: 0 },
              pageSize: { width: WIDTH_MICRONS / 25400, height: height / 25400 }
            });

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}-${label}.pdf`), pdf);

      return;
    }

    await new Promise((resolve, reject) => {
      this.window.webContents.print({
        silent: true,
        printBackground: false,
        deviceName: cfg.deviceName || "",
        margins: { marginType: "none" },
        pageSize: { width: WIDTH_MICRONS, height }
      }, (success, reason) => (success ? resolve() : reject(new Error(reason || "Druck fehlgeschlagen"))));
    });
  }

  // Mehrere Zettel nacheinander, hinter allem, was schon wartet.
  enqueue(docs, label) {
    const cfg = this.settings();

    if (!cfg.enabled || !docs.length) {
      return Promise.resolve({ ok: true, printed: 0 });
    }

    const job = this.queue.then(async () => {
      let printed = 0;

      for (const [i, doc] of docs.entries()) {
        await this.printOne(doc, `${label}-${i + 1}`);
        printed++;
      }

      return { ok: true, printed };
    }).catch((e) => {
      this.logger.error(`Druck fehlgeschlagen (${label}): ${e.message}`);

      return { ok: false, message: `Der Drucker meldet einen Fehler: ${e.message}` };
    });

    this.queue = job;

    return job;
  }

  /*
    Die Bons eines Verkaufs: je verkauftem Stück einer, Getränke, Essen und
    Pfand gleichermaßen. Eine Pfandrückgabe bekommt keinen — dort wird Geld
    ausgezahlt, nichts ausgegeben.
  */
  bons(sale, context) {
    const pieces = sale.items.filter((i) => i.kind !== "pfandrueckgabe");

    return this.enqueue(pieces.map((item, i) => ({
      type: "bon",
      ...context,
      name: item.name,
      price: item.price,
      deposit: Boolean(item.deposit),
      number: sale.number,
      index: i + 1,
      count: pieces.length,
      created_at: sale.created_at
    })), `bon${sale.number}`);
  }

  receipt(sale, context) {
    // Der Kontext zuletzt: sale.event ist die uuid, gedruckt wird der Name.
    return this.enqueue([{ type: "receipt", ...sale, ...context }], `beleg${sale.number}`);
  }

  summary(summary, context) {
    return this.enqueue([{ type: "summary", ...context, summary }], `abschluss-${summary.day}`);
  }

  test(context) {
    return this.enqueue([{ type: "test", ...context }], "test");
  }

  // Für die Auswahl in den Einstellungen.
  async list(webContents) {
    try {
      return (await webContents.getPrintersAsync()).map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: Boolean(p.isDefault) }));
    }
    catch(e) {
      return [];
    }
  }

  close() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
  }
}

module.exports = { Printer };
