// Einstellungen dieser Installation, config.json im Datenverzeichnis.
//
// Ein Geheimnis steht darin: die Seriennummer in update.manifestUrl, wie bei
// Zero1 arena. Das Kassentoken dagegen steht verschlüsselt in device.json
// (utils/device.js).
//
// Fehlt die Datei, gelten die Vorgaben und sie wird angelegt. Ist sie kaputt,
// bricht der Start ab, statt sie zu überschreiben — sonst wären mühsam
// gesetzte Einstellungen weg, und niemand wüsste, warum.

const fs = require("fs"),
      paths = require("./paths");

const DEFAULTS = {
  // Kopplung und Abgleich: der Vereinsserver. Das Kassentoken steht nicht
  // hier, sondern verschlüsselt in device.json.
  server: "https://tv-fridingen.de/checkout/",
  // Aktualisierung wie bei Zero1 arena: Die Seriennummer steckt als token in
  // der Adresse und wird beim ersten Start abgefragt. Ohne sie gibt es keine
  // Aktualisierungen.
  update: {
    enabled: true,
    manifestUrl: "https://checkout.null1.media?token=",
    timeoutMs: 10000
  },
  sync: {
    // Regelmäßiger Abgleich, solange das Programm offen ist. Nach jeder
    // Änderung an der Kasse wird zusätzlich sofort abgeglichen.
    intervalSeconds: 60,
    timeoutMs: 15000,
    // Beim Start: Wie lange wird auf den Server gewartet, bevor die Kasse
    // mit dem lokalen Stand öffnet? Auf einem Fest ohne Netz soll niemand
    // eine Viertelminute vor dem Ladebildschirm stehen.
    startTimeoutMs: 6000
  },
  debug: false
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Gespeicherte Werte über die Vorgaben legen. Neue Schlüssel einer neueren
// Fassung kommen so automatisch dazu, ohne dass jemand die Datei anfasst.
function merge(base, over) {
  const out = { ...base };

  for (const [key, value] of Object.entries(over || {})) {
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }

  return out;
}

let current = null;

function load() {
  let stored = {};

  if (fs.existsSync(paths.configFile)) {
    try {
      stored = JSON.parse(fs.readFileSync(paths.configFile, "utf8"));
    }
    catch(e) {
      throw new Error(`Die Konfiguration ist beschädigt und wurde nicht überschrieben: ${paths.configFile} (${e.message})`);
    }
  }

  current = merge(DEFAULTS, stored);

  if (!fs.existsSync(paths.configFile)) {
    write(current);
  }

  return current;
}

function write(data) {
  const tmp = `${paths.configFile}.neu`;

  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, paths.configFile);
}

function get() {
  return current || load();
}

// Nur bekannte Schlüssel. Die Einstellungsseite schickt, was im Formular
// steht; was dort nicht hingehört, landet nicht in der Datei.
function save(patch) {
  const next = merge(get(), pick(DEFAULTS, patch));

  write(next);
  current = next;

  return current;
}

function pick(shape, patch) {
  const out = {};

  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in shape)) {
      continue;
    }

    if (isObject(shape[key])) {
      if (isObject(value)) {
        out[key] = pick(shape[key], value);
      }
    }
    else if (typeof value === typeof shape[key]) {
      out[key] = value;
    }
  }

  return out;
}

module.exports = { DEFAULTS, load, get, save };
