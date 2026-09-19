// Alle Tests, jeder in einem eigenen Prozess.
//
// Die Tests laufen nicht im Node des Entwicklungsrechners, sondern in dem von
// Electron (ELECTRON_RUN_AS_NODE=1). Grund: utils/store.js braucht node:sqlite,
// und es soll genau die Fassung geprüft werden, mit der die Kasse läuft — nicht
// irgendeine, die zufällig installiert ist.
//
// Aufruf: npm test

const { spawnSync } = require("child_process"),
      fs = require("fs"),
      path = require("path"),
      electron = require("electron");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".js") && !["run.js", "helpers.js"].includes(f)).sort();

let failed = 0;

for (const file of files) {
  console.log(`\n> ${file}`);

  const result = spawnSync(electron, [path.join(__dirname, file)], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });

  if (result.status !== 0) {
    failed++;
  }
}

fs.rmSync(path.join(__dirname, ".tmp"), { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} von ${files.length} Testdatei(en) fehlgeschlagen.\n`);
  process.exit(1);
}

console.log(`\nAlle ${files.length} Testdateien bestanden.\n`);
