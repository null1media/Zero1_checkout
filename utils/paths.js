// Programmdateien und Daten trennen.
//
// Alles, was sich zur Laufzeit ändert — Konfiguration, Gerätetoken, die lokale
// Datenbank, das Protokoll —, liegt im Datenverzeichnis und nicht beim
// Programm. Das Programmverzeichnis gehört dem Updater: Er ersetzt dort Dateien
// und entfernt, was die neue Fassung nicht mehr mitbringt.
//
// Die Hülle setzt das Datenverzeichnis über setDataDir() auf das Benutzerprofil.
// Ohne Angabe — Tests, Werkzeuge — liegt es unter .data neben dem Quelltext.

const fs = require("fs"),
      path = require("path"),
      APP_DIR = path.join(__dirname, "..");

let dataDir = path.join(APP_DIR, ".data");

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });

  return dir;
}

const paths = {
  get appDir() {
    return APP_DIR;
  },

  get dataDir() {
    return dataDir;
  },

  get configFile() {
    return path.join(dataDir, "config.json");
  },

  // Getrennt von der Konfiguration: Das Token ist verschlüsselt, und wer die
  // Konfiguration zur Fehlersuche herumschickt, soll es nicht mitschicken.
  get deviceFile() {
    return path.join(dataDir, "device.json");
  },

  get database() {
    return path.join(dataDir, "zero1-checkout.sqlite");
  },

  // Assets, die der Updater ausliefert (public/assets/** auf dem Server).
  // Wie bei Zero1 arena im Datenverzeichnis statt beim Programm. Zero1
  // checkout bringt derzeit keine mit; der Pfad muss trotzdem stehen, weil der
  // Updater derselbe ist.
  get assets() {
    return path.join(dataDir, "assets");
  },

  get logs() {
    return path.join(dataDir, "logs");
  },

  // Zwischenablage des Updaters. Wird nach jedem Lauf geleert.
  get stage() {
    return path.join(dataDir, ".stage");
  },

  setDataDir(dir) {
    if (!dir) {
      return;
    }

    dataDir = ensure(dir);
    ensure(paths.logs);
  }
};

module.exports = paths;
