// Eine Version herausgeben.
//
// Der Cron auf checkout.null1.media (lib/cron.php) baut die Auslieferung
// nur, wenn die Version in package.json steigt. Wer eine Änderung pusht, ohne
// sie anzuheben, erreicht damit keine einzige Kasse — und nichts sagt es.
// Dieses Skript führt deshalb die ganze Kette in einem Befehl: Tests,
// Version heben, committen, taggen, pushen.
//
// Aufruf: npm run release            (Patch:  0.1.0 -> 0.1.1)
//         npm run release -- minor   (Minor:  0.1.0 -> 0.2.0)
//         npm run release -- major
//         npm run release -- 1.0.0   (genau diese Version)

const { execFileSync } = require("child_process"),
      fs = require("fs"),
      path = require("path"),
      ROOT = path.join(__dirname, ".."),
      PKG = path.join(ROOT, "package.json"),
      LOCK = path.join(ROOT, "package-lock.json");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
}

function abort(text) {
  console.error(`\nAbbruch: ${text}\n`);
  process.exit(1);
}

function nextVersion(current, wish) {
  if (/^\d+\.\d+\.\d+$/.test(wish)) {
    return wish;
  }

  const [major, minor, patch] = current.split(".").map(Number);

  if (wish === "major") {
    return `${major + 1}.0.0`;
  }

  if (wish === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  if (wish === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }

  abort(`Unbekannte Angabe "${wish}". Erlaubt: patch, minor, major oder eine Version wie 1.0.0.`);
}

const wish = (process.argv[2] || "patch").trim();

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
  abort("Herausgegeben wird von main.");
}

if (git("status", "--porcelain")) {
  abort("Es liegen uncommittete Änderungen vor. Erst die eigene Arbeit committen, dann herausgeben.");
}

console.log("\n> Tests\n");

try {
  run("npm", ["test"]);
}
catch(e) {
  abort("Die Tests sind nicht durchgelaufen. Es wird nichts herausgegeben.");
}

const text = fs.readFileSync(PKG, "utf8"),
      current = JSON.parse(text).version,
      next = nextVersion(current, wish);

if (!/^\d+\.\d+\.\d+$/.test(next) || next === current) {
  abort(`Die neue Version ${next} ist keine Erhöhung von ${current}.`);
}

// Gezielt ersetzen statt neu schreiben: JSON.stringify setzte Reihenfolge und
// Einrückung nach eigenem Gutdünken, und der Diff wäre unlesbar.
let updated = text.replace(`"version": "${current}"`, `"version": "${next}"`);

if (updated === text) {
  abort(`Die Version ${current} ließ sich in package.json nicht ersetzen.`);
}

// Das Copyright-Jahr steht nur hier und wandert von dort in den Installer und
// den Ladebildschirm. Einmal im Jahr wäre es falsch, wenn es niemand anfasst.
updated = updated.replace(/("copyright": "[^"]*?Copyright © )(\d{4})/, `$1${new Date().getFullYear()}`);

// package-lock.json trägt die Version zweimal im Kopf. Bleibt sie stehen,
// schreibt das nächste npm install sie nach — und die nächste Herausgabe
// bricht an den uncommitteten Änderungen ab. Nur der Kopf bis zum ersten
// Paket: Weiter unten kann eine Abhängigkeit zufällig dieselbe Nummer tragen.
const lockText = fs.readFileSync(LOCK, "utf8"),
      lockHead = lockText.indexOf('"node_modules/'),
      head = lockHead < 0 ? lockText : lockText.slice(0, lockHead),
      newHead = head.split(`"version": "${current}"`).join(`"version": "${next}"`);

if (newHead === head) {
  abort(`Die Version ${current} ließ sich in package-lock.json nicht ersetzen.`);
}

fs.writeFileSync(PKG, updated, "utf8");
fs.writeFileSync(LOCK, newHead + lockText.slice(head.length), "utf8");
console.log(`\n> Version ${current} -> ${next}\n`);

git("add", "package.json", "package-lock.json");
git("commit", "-m", `Version ${next}`);

// Mit Nachricht: Steht tag.gpgsign auf true, ist ein Tag immer annotiert, und
// ohne -m bricht git ab, nachdem der Commit schon steht (siehe Zero1 arena).
git("tag", "-m", `Version ${next}`, `v${next}`);

console.log("> Push\n");
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", `v${next}`]);

console.log(`\nVersion ${next} ist auf GitHub.`);
console.log("Plesk rollt sie nach lib/app/zero1-checkout auf checkout.null1.media aus, der Cron baut die Auslieferung beim nächsten Lauf.\n");
