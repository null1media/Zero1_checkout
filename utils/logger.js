// Protokoll. Schreibt auf die Konsole und in eine Datei je Tag im
// Datenverzeichnis — dieselbe Form wie bei Zero1 arena, nur ohne chalk: Zero1
// checkout hat keine Laufzeitabhängigkeiten, und farbige Konsolenausgabe
// sieht bei einem Programm mit Fenster ohnehin niemand.

const fs = require("fs"),
      path = require("path"),
      paths = require("./paths"),
      KEEP_DAYS = 30;

let stream = null,
    streamDay = null,
    fileError = false,
    quiet = false;

function pad(n) {
  return String(n).padStart(2, "0");
}

function today() {
  const now = new Date();

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function timestamp() {
  const now = new Date();

  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function join(args) {
  return args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
}

// Protokolle älter als KEEP_DAYS entfernen. Ein Festtag erzeugt wenige
// Kilobyte, aber ohne Grenze wächst das Verzeichnis über Jahre.
function prune() {
  try {
    const limit = Date.now() - KEEP_DAYS * 86400000;

    for (const name of fs.readdirSync(paths.logs)) {
      if (/^\d{4}-\d{2}-\d{2}\.log$/.test(name) && fs.statSync(path.join(paths.logs, name)).mtimeMs < limit) {
        fs.unlinkSync(path.join(paths.logs, name));
      }
    }
  }
  catch(e) {
    // Aufräumen ist Kür.
  }
}

function ensureStream() {
  const day = today();

  if (stream && streamDay === day) {
    return stream;
  }

  if (fileError) {
    return null;
  }

  try {
    if (stream) {
      stream.end();
    }

    fs.mkdirSync(paths.logs, { recursive: true });
    stream = fs.createWriteStream(path.join(paths.logs, `${day}.log`), { flags: "a" });
    streamDay = day;
    stream.on("error", () => {
      fileError = true;
      stream = null;
    });
    prune();

    return stream;
  }
  catch(e) {
    // Kein Protokoll ist ärgerlich, aber kein Grund, den Verkauf abzubrechen.
    fileError = true;

    return null;
  }
}

function make(level, consoleFn) {
  return (...args) => {
    const text = join(args);

    if (!quiet) {
      consoleFn(`[${level}] ${text}`);
    }

    const target = ensureStream();

    if (target) {
      target.write(`[${timestamp()}] [${level}] ${text}\n`);
    }
  };
}

module.exports = {
  info: make("INFO", console.log),
  success: make("ERFOLG", console.log),
  warn: make("WARNUNG", console.warn),
  error: make("FEHLER", console.error),

  // Für die Tests: kein Konsolenrauschen zwischen den Prüfungen.
  setQuiet(value) {
    quiet = Boolean(value);
  },

  getLogDir() {
    return paths.logs;
  },

  getLogFile() {
    return path.join(paths.logs, `${today()}.log`);
  }
};
