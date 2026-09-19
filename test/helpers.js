// Werkzeug für die Tests: kein Framework, nur Prüfungen mit Zähler.

const fs = require("fs"),
      path = require("path");

let passed = 0,
    failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
  }
  else {
    failed++;
    console.error(`  FEHLER: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(label, actual, expected) {
  const a = JSON.stringify(actual),
        e = JSON.stringify(expected);

  check(label, a === e, `erwartet ${e}, erhalten ${a}`);
}

async function rejects(label, fn, predicate = () => true) {
  try {
    await fn();
    check(label, false, "keine Ausnahme");
  }
  catch(e) {
    check(label, predicate(e), e.message);
  }
}

function tempDir(name) {
  const dir = path.join(__dirname, ".tmp", `${name}-${process.pid}-${Date.now()}`);

  fs.mkdirSync(dir, { recursive: true });

  return dir;
}

function done() {
  console.log(`  ${passed} Prüfungen bestanden${failed ? `, ${failed} fehlgeschlagen` : ""}.`);
  process.exit(failed ? 1 : 0);
}

const quietLogger = { info() {}, success() {}, warn() {}, error() {} };

module.exports = { check, equal, rejects, tempDir, done, quietLogger };
