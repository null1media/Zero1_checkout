// Das Gerätetoken.
//
// Entsteht beim Koppeln: Im Adminbereich von tv-fridingen.de wird unter
// "Kasse" eine Kasse angelegt und ein Kopplungscode angezeigt, Zero1 checkout
// tauscht ihn gegen ein Token. Mit dem Token gleicht die Kasse ab und holt
// Aktualisierungen. Jede Kasse hat ihr eigenes — ein verlorener Laptop wird im
// Adminbereich einzeln gesperrt.
//
// Gespeichert mit Electrons safeStorage, unter Windows also über DPAPI an das
// Benutzerkonto gebunden. Wer device.json auf einen anderen Rechner kopiert,
// hat damit kein Token. Die Verschlüsselung wird hereingereicht, damit die
// Tests ohne Electron laufen.

const fs = require("fs"),
      paths = require("./paths");

// Ohne Verschlüsselung: nur für Tests und als Notnagel, wenn safeStorage auf
// einem Rechner nicht verfügbar ist.
const PLAIN = {
  available: () => false,
  encrypt: (text) => Buffer.from(text, "utf8"),
  decrypt: (buffer) => buffer.toString("utf8")
};

function create(cipher = PLAIN, logger = null) {
  function read() {
    try {
      return JSON.parse(fs.readFileSync(paths.deviceFile, "utf8"));
    }
    catch(e) {
      return null;
    }
  }

  return {
    // { id, name, token } oder null
    load() {
      const stored = read();

      if (!stored || !stored.token) {
        return null;
      }

      try {
        const buffer = Buffer.from(stored.token, "base64"),
              token = stored.encrypted ? cipher.decrypt(buffer) : buffer.toString("utf8");

        return /^[0-9a-f]{64}$/.test(token) ? { id: stored.id, name: stored.name, token } : null;
      }
      catch(e) {
        // Anderes Benutzerkonto, anderer Rechner: Das Token ist nicht lesbar,
        // also neu koppeln. Das ist der vorgesehene Weg, kein Fehler.
        if (logger) {
          logger.warn(`Das gespeicherte Gerätetoken ist hier nicht lesbar (${e.message}). Es wird neu gekoppelt.`);
        }

        return null;
      }
    },

    save({ id, name, token }) {
      const encrypted = cipher.available();

      if (!encrypted && logger && cipher !== PLAIN) {
        logger.warn("Die Verschlüsselung des Betriebssystems ist nicht verfügbar. Das Gerätetoken wird unverschlüsselt gespeichert.");
      }

      const data = {
        id,
        name,
        encrypted,
        token: (encrypted ? cipher.encrypt(token) : Buffer.from(token, "utf8")).toString("base64"),
        paired_at: new Date().toISOString()
      };

      fs.mkdirSync(paths.dataDir, { recursive: true });
      fs.writeFileSync(`${paths.deviceFile}.neu`, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(`${paths.deviceFile}.neu`, paths.deviceFile);
    },

    clear() {
      fs.rmSync(paths.deviceFile, { force: true });
    }
  };
}

module.exports = { create, PLAIN };
