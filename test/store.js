// Lokale Datenbank und Gerätetoken.

const fs = require("fs"),
      path = require("path"),
      { Store, SCHEMA_VERSION } = require("../utils/store"),
      paths = require("../utils/paths"),
      deviceModule = require("../utils/device"),
      { check, equal, tempDir, done } = require("./helpers");

// ------------------------------------------------------------------ Store

const dir = tempDir("store"),
      file = path.join(dir, "c.sqlite");

let store = new Store(file);

equal("Schema auf aktuellem Stand", store.schemaVersion(), SCHEMA_VERSION);
equal("Meta leer", store.getMeta("server_time"), null);
equal("Meta mit Vorgabe", store.getMeta("fehlt", 42), 42);

store.setMeta("server_time", "2026-09-20 18:00:00.000000");
store.setMeta("server_time", "2026-09-20 18:05:00.000000");
equal("Meta überschreiben", store.getMeta("server_time"), "2026-09-20 18:05:00.000000");

store.applyExport({ settings: { club_name: "TV", tax_rate: 19 } });
equal("Vereinsangaben", store.settings(), { club_name: "TV", tax_rate: 19 });

store.applyExport({});
equal("Antwort ohne settings lässt sie stehen", store.settings().club_name, "TV");

equal("nichts offen", store.pendingCount(), 0);
equal("keine Änderungen", store.pendingChanges().changes, []);

// Transaktion: Fehler rollt zurück
try {
  store.transaction(() => {
    store.setMeta("server_time", "kaputt");
    throw new Error("Absicht");
  });
}
catch(e) {
  // erwartet
}

equal("Rollback", store.getMeta("server_time"), "2026-09-20 18:05:00.000000");

// Zweites Öffnen migriert nicht erneut und behält die Daten
store.close();
store = new Store(file);
equal("Daten nach Neustart", store.settings().club_name, "TV");
store.close();

// ---------------------------------------------------------- Gerätetoken

paths.setDataDir(tempDir("device"));

const plain = deviceModule.create();

equal("ohne Datei kein Gerät", plain.load(), null);

plain.save({ id: 3, name: "Kasse Festzelt", token: "d".repeat(64) });
equal("Token zurück", plain.load(), { id: 3, name: "Kasse Festzelt", token: "d".repeat(64) });

// Mit "Verschlüsselung": gespeichert steht nicht der Klartext
const rot = {
  available: () => true,
  encrypt: (text) => Buffer.from(text.split("").reverse().join(""), "utf8"),
  decrypt: (buffer) => buffer.toString("utf8").split("").reverse().join("")
};
const secret = deviceModule.create(rot),
      token = "0123456789abcdef".repeat(4);

secret.save({ id: 4, name: "Kasse Theke", token });
check("verschlüsselt gespeichert", !fs.readFileSync(paths.deviceFile, "utf8").includes(Buffer.from(token).toString("base64")));
equal("entschlüsselt geladen", secret.load().token, token);

// Nicht entschlüsselbar (anderes Benutzerkonto): neu koppeln statt Absturz
const broken = deviceModule.create({ ...rot, decrypt: () => { throw new Error("DPAPI"); } });

equal("unlesbares Token", broken.load(), null);

secret.clear();
equal("gelöscht", secret.load(), null);

done();
