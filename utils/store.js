// Die lokale Datenbank.
//
// Eine Kopie des Bestands vom Vereinsserver, dazu alles, was an dieser Kasse
// erfasst und noch nicht übertragen wurde. Die Kasse arbeitet ausschließlich
// hierauf — ob gerade Netz da ist, merkt man ihr nur an der Statusanzeige an.
//
// node:sqlite statt better-sqlite3: Electron bringt es mit, es gibt also kein
// natives Modul, das gegen Electron gebaut werden müsste (siehe HSG
// Kartenkasse und Zero1 arena: node-gyp scheitert am Leerzeichen in
// "Null1 dev"). Außerdem kann der Updater so wirklich jede Datei ersetzen.
//
// Stand des Gerüsts: nur die Meta-Tabelle. Artikel, Kategorien,
// Veranstaltungen und Verkäufe kommen als eigene Schritte in migrate(), sobald
// die Fachlichkeit steht. Für alles, was die Kasse selbst anlegt, gilt dann
// dasselbe Verfahren wie in der HSG Kartenkasse:
//
//   - Jede Zeile trägt eine uuid, vergeben an der Kasse. Doppelt eingespielt
//     ist beim Server dasselbe wie einmal.
//   - Offen ist, was rev > synced_rev hat. Jede lokale Änderung zählt rev
//     hoch; beim Abgleich merkt sich die Kasse den geschickten rev und hakt
//     die Zeile nur ab, wenn er beim Eintreffen der Antwort noch derselbe ist.
//     Wer während des Abgleichs weiterkassiert, verliert so nichts.
//   - Server-Stand überschreibt keine offene lokale Zeile.

const { DatabaseSync } = require("node:sqlite");

// 1: Grundstock (meta).
const SCHEMA_VERSION = 1;

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  // Schritt für Schritt: Eine Kasse im Feld bekommt nur die Schritte, die ihr
  // fehlen. Wer das Schema ändert, hängt einen Schritt an, statt einen
  // vorhandenen zu ändern.
  migrate() {
    const version = this.db.prepare("PRAGMA user_version").get().user_version;

    if (version >= SCHEMA_VERSION) {
      return;
    }

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
    }

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  schemaVersion() {
    return this.db.prepare("PRAGMA user_version").get().user_version;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec("BEGIN");

    try {
      const result = fn();

      this.db.exec("COMMIT");

      return result;
    }
    catch(e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /* ---------------------------------------------------------------- Meta */

  getMeta(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);

    return row ? JSON.parse(row.value) : fallback;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  /* ------------------------------------------------- Stand vom Server */

  // Antwort des Servers einspielen. Bislang nur die Vereinsangaben, die der
  // Server in "settings" mitschickt (Name, Steuersätze).
  applyExport(data) {
    this.transaction(() => {
      if (data.settings && typeof data.settings === "object") {
        this.setMeta("settings", data.settings);
      }
    });
  }

  settings() {
    return this.getMeta("settings", {});
  }

  /* ------------------------------------------------ Abgleich: senden */

  // Was noch zum Server muss, und je Schlüssel der geschickte Stand — für
  // applyResults(). Im Gerüst legt die Kasse noch nichts an.
  pendingChanges() {
    return { changes: [], sent: {} };
  }

  pendingCount() {
    return 0;
  }

  // Ergebnisse des Servers je Änderung. Rückgabe: Hinweise für Protokoll und
  // Oberfläche, [{ uuid, level: "info" | "error", message }].
  applyResults(results) {
    return (Array.isArray(results) ? results : [])
      .filter((r) => r && r.status === "error")
      .map((r) => ({ uuid: r.uuid || "", level: "error", message: r.error || "abgelehnt" }));
  }
}

module.exports = { Store, SCHEMA_VERSION };
