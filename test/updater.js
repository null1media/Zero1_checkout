// Der Delta-Abgleich, gegen einen echten Server.
//
// Diese Maschinerie laeuft unbeaufsichtigt, vor dem Spiel, auf einem Rechner
// ohne Zuschauer. Wenn sie danebengreift, faellt das entweder gar nicht auf
// oder zur denkbar schlechtesten Zeit. Deshalb wird hier nicht die Absicht
// geprueft, sondern der Ablauf: ein kleiner HTTP-Server spielt
// checkout.null1.media, der Updater laeuft echt dagegen, und danach wird
// nachgesehen, was auf der Platte liegt.
//
// Das ZIP baut dieser Test selbst (unzipper kann nur lesen). Dass das Format
// stimmt, beweist der Updater, indem er es auspackt - ein kaputtes Archiv
// wuerde den Test scheitern lassen, nicht bestehen.

const assert = require("assert"),
      crypto = require("crypto"),
      fs = require("fs"),
      http = require("http"),
      os = require("os"),
      path = require("path"),
      zlib = require("zlib");

let bestanden = 0;

function ok(label, ist, soll) {
  assert.deepStrictEqual(ist, soll, `${label}\n  erwartet: ${JSON.stringify(soll)}\n  erhalten: ${JSON.stringify(ist)}`);
  console.log(`OK   ${label}`);
  bestanden++;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ------------------------------------------------------------ ZIP schreiben

// Nur die "stored"-Variante: kein Deflate, keine Data Descriptors. Mehr
// braucht es nicht, und weniger laesst sich schlecht falsch machen.
function zipVon(eintraege) {
  const lokale = [],
        zentrale = [];

  let offset = 0;

  for (const [name, inhalt] of eintraege) {
    const nameBuf = Buffer.from(name, "utf8"),
          crc = zlib.crc32(inhalt),
          lokal = Buffer.alloc(30);

    lokal.writeUInt32LE(0x04034b50, 0);
    lokal.writeUInt16LE(20, 4);
    lokal.writeUInt16LE(0, 6);
    lokal.writeUInt16LE(0, 8);
    lokal.writeUInt16LE(0, 10);
    lokal.writeUInt16LE(0, 12);
    lokal.writeUInt32LE(crc, 14);
    lokal.writeUInt32LE(inhalt.length, 18);
    lokal.writeUInt32LE(inhalt.length, 22);
    lokal.writeUInt16LE(nameBuf.length, 26);
    lokal.writeUInt16LE(0, 28);

    lokale.push(lokal, nameBuf, inhalt);

    const zentral = Buffer.alloc(46);

    zentral.writeUInt32LE(0x02014b50, 0);
    zentral.writeUInt16LE(20, 4);
    zentral.writeUInt16LE(20, 6);
    zentral.writeUInt16LE(0, 8);
    zentral.writeUInt16LE(0, 10);
    zentral.writeUInt16LE(0, 12);
    zentral.writeUInt16LE(0, 14);
    zentral.writeUInt32LE(crc, 16);
    zentral.writeUInt32LE(inhalt.length, 20);
    zentral.writeUInt32LE(inhalt.length, 24);
    zentral.writeUInt16LE(nameBuf.length, 28);
    zentral.writeUInt16LE(0, 30);
    zentral.writeUInt16LE(0, 32);
    zentral.writeUInt16LE(0, 34);
    zentral.writeUInt16LE(0, 36);
    zentral.writeUInt32LE(0, 38);
    zentral.writeUInt32LE(offset, 42);

    zentrale.push(zentral, nameBuf);
    offset += lokal.length + nameBuf.length + inhalt.length;
  }

  const zentralBuf = Buffer.concat(zentrale),
        ende = Buffer.alloc(22);

  ende.writeUInt32LE(0x06054b50, 0);
  ende.writeUInt16LE(0, 4);
  ende.writeUInt16LE(0, 6);
  ende.writeUInt16LE(eintraege.length, 8);
  ende.writeUInt16LE(eintraege.length, 10);
  ende.writeUInt32LE(zentralBuf.length, 12);
  ende.writeUInt32LE(offset, 16);
  ende.writeUInt16LE(0, 20);

  return Buffer.concat([...lokale, zentralBuf, ende]);
}

// --------------------------------------------------------------- Hilfsmittel

const stille = { info() {}, warn() {}, error() {}, success() {} };

function schreibe(wurzel, rel, inhalt) {
  const voll = path.join(wurzel, rel);

  fs.mkdirSync(path.dirname(voll), { recursive: true });
  fs.writeFileSync(voll, inhalt);
}

function lies(wurzel, rel) {
  return fs.readFileSync(path.join(wurzel, rel), "utf8");
}

function existiert(wurzel, rel) {
  return fs.existsSync(path.join(wurzel, rel));
}

// Der gespielte Server. Er kennt genau die drei Antworten, die auch
// checkout.null1.media gibt.
function starteServer(bestand, version) {
  const files = {};

  for (const [pfad, inhalt] of Object.entries(bestand)) {
    files[pfad] = { sha256: sha256(Buffer.from(inhalt)), size: Buffer.byteLength(inhalt) };
  }

  const angefragt = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/manifest") {
      const basis = `http://127.0.0.1:${server.address().port}`;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        version,
        zipUrl: `${basis}/zip`,
        sha256: sha256(zipVon(Object.entries(bestand).map(([p, i]) => [p, Buffer.from(i)]))),
        filesUrl: `${basis}/files`,
        deltaUrl: `${basis}/files`
      }));

      return;
    }

    if (url.pathname === "/files" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version, dependencies: { express: "^4.18.2" }, files }));

      return;
    }

    if (url.pathname === "/files" && req.method === "POST") {
      let rumpf = "";

      req.on("data", (c) => (rumpf += c));
      req.on("end", () => {
        const pfade = JSON.parse(rumpf).paths;

        angefragt.push(...pfade);

        const eintraege = pfade.map((p) => [p, Buffer.from(bestand[p])]);

        res.writeHead(200, { "Content-Type": "application/zip" });
        res.end(zipVon(eintraege));
      });

      return;
    }

    if (url.pathname === "/zip") {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(zipVon(Object.entries(bestand).map(([p, i]) => [p, Buffer.from(i)])));

      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, angefragt, port: server.address().port }));
  });
}

// ------------------------------------------------------------------- Prueflauf

(async () => {
  const fileIndex = require("../utils/fileIndex"),
        updater = require("../utils/updater");

  // ------------------------------------------------------ Pfade und Filter

  ok("Assetpfad landet im Datenverzeichnis",
    fileIndex.resolveTarget("public/assets/audio/tor.mp3", { appDir: "A", assetsDir: "B" }),
    path.join("B", "audio/tor.mp3"));

  ok("Programmpfad landet beim Programm",
    fileIndex.resolveTarget("utils/config.js", { appDir: "A", assetsDir: "B" }),
    path.join("A", "utils/config.js"));

  ok("Ausbruch nach oben wird abgelehnt", fileIndex.isSafePath("../../windows/system32/x.dll"), false);
  ok("Absoluter Pfad wird abgelehnt", fileIndex.isSafePath("/etc/passwd"), false);
  ok("Backslash wird abgelehnt", fileIndex.isSafePath("utils\\config.js"), false);
  ok("Normaler Pfad wird angenommen", fileIndex.isSafePath("public/js/backend.js"), true);

  ok("main.js wird ausgeliefert", updater.wirdAusgeliefert("main.js"), true);
  ok("preload.js wird ausgeliefert", updater.wirdAusgeliefert("preload.js"), true);
  ok("index.js (Arena) wird nicht ausgeliefert", updater.wirdAusgeliefert("index.js"), false);
  ok("Assets werden ausgeliefert", updater.wirdAusgeliefert("public/assets/audio/x.mp3"), true);
  ok("build/ wird nicht ausgeliefert", updater.wirdAusgeliefert("build/bundle.js"), false);
  ok("test/ wird nicht ausgeliefert", updater.wirdAusgeliefert("test/updater.js"), false);
  ok("CLAUDE.md wird nicht ausgeliefert", updater.wirdAusgeliefert("CLAUDE.md"), false);

  // Gross genug, dass die fehlenden Dateien deutlich unter der Haelfte des
  // Gesamtbestands bleiben - sonst greift der Vollpaket-Zweig, und der wird
  // weiter unten eigens geprueft.
  const GROSS = "u".repeat(20000),
        KLANG = "k".repeat(20000);

  // ------------------------------------------------------- Frische Anlage

  // Kein Bestand: Hier soll das Gesamtpaket genommen werden, nicht tausende
  // Einzelanfragen. Das ist der Fall "Laptop frisch aufgesetzt".
  const leer = fs.mkdtempSync(path.join(os.tmpdir(), "zero1-checkout-frisch-")),
        leerApp = path.join(leer, "app"),
        leerAssets = path.join(leer, "daten", "assets");

  fs.mkdirSync(leerApp, { recursive: true });
  fs.mkdirSync(leerAssets, { recursive: true });

  // -------------------------------------------------------- Delta-Abgleich

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zero1-checkout-updater-")),
        appDir = path.join(tmp, "app"),
        assetsDir = path.join(tmp, "daten", "assets"),
        dataDir = path.join(tmp, "daten");

  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  // Lokaler Ausgangszustand: eine Datei stimmt, eine ist veraltet, eine fehlt,
  // eine ist zu viel, und eine gehoert gar nicht zur Auslieferung.
  schreibe(appDir, "package.json", JSON.stringify({ version: "1.0.0", dependencies: { express: "^4.18.2" } }));
  schreibe(appDir, "main.js", GROSS);
  schreibe(appDir, "utils/config.js", "ALT");
  schreibe(appDir, "utils/weg.js", "gehoert nicht mehr dazu");
  schreibe(appDir, "CLAUDE.md", "nicht Teil der Auslieferung");
  schreibe(assetsDir, "audio/bleibt.mp3", KLANG);
  schreibe(assetsDir, "audio/alt.mp3", "wird entfernt");

  const bestand = {
    "package.json": JSON.stringify({ version: "1.1.0", dependencies: { express: "^4.18.2" } }),
    "main.js": GROSS,
    "utils/config.js": "NEU",
    "public/js/backend.js": "frisch dazugekommen",
    "public/assets/audio/bleibt.mp3": KLANG,
    "public/assets/audio/neu.mp3": "neuer klang"
  };

  const { server, angefragt, port } = await starteServer(bestand, "1.1.0");

  const ergebnis = await updater.run({
    appDir,
    assetsDir,
    dataDir,
    logger: stille,
    config: { update: { enabled: true, manifestUrl: `http://127.0.0.1:${port}/manifest`, timeoutMs: 5000 } }
  });

  ok("Es wurde aktualisiert", ergebnis.status, "aktualisiert");
  ok("Die Version ist uebernommen", ergebnis.version, "1.1.0");
  ok("Programmdateien waren betroffen", ergebnis.programChanged, true);

  // Nur das Fehlende wurde angefragt - das ist der ganze Zweck der Uebung.
  ok("Nur Abweichungen wurden geladen", angefragt.sort(), [
    "package.json",
    "public/assets/audio/neu.mp3",
    "public/js/backend.js",
    "utils/config.js"
  ]);

  ok("Geaenderte Datei wurde ersetzt", lies(appDir, "utils/config.js"), "NEU");
  ok("Neue Programmdatei liegt beim Programm", lies(appDir, "public/js/backend.js"), "frisch dazugekommen");
  ok("Unveraenderte Datei blieb liegen", lies(appDir, "main.js"), GROSS);
  ok("Neues Asset liegt im Datenverzeichnis", lies(assetsDir, "audio/neu.mp3"), "neuer klang");
  ok("Asset landete NICHT beim Programm", existiert(appDir, "public/assets/audio/neu.mp3"), false);
  ok("Ueberzaehlige Programmdatei wurde entfernt", existiert(appDir, "utils/weg.js"), false);
  ok("Ueberzaehliges Asset wurde entfernt", existiert(assetsDir, "audio/alt.mp3"), false);
  ok("Was nicht ausgeliefert wird, bleibt unangetastet", existiert(appDir, "CLAUDE.md"), true);

  // Zweiter Lauf: jetzt darf nichts mehr passieren.
  angefragt.length = 0;

  const zweiter = await updater.run({
    appDir,
    assetsDir,
    dataDir,
    logger: stille,
    config: { update: { enabled: true, manifestUrl: `http://127.0.0.1:${port}/manifest`, timeoutMs: 5000 } }
  });

  ok("Zweiter Lauf meldet aktuell", zweiter.status, "aktuell");
  ok("Zweiter Lauf laedt nichts", angefragt.length, 0);

  // Kein Rueckschritt: Der Server ist aelter als der Client.
  const alt = await starteServer(bestand, "0.9.0");

  const rueck = await updater.run({
    appDir,
    assetsDir,
    dataDir,
    logger: stille,
    config: { update: { enabled: true, manifestUrl: `http://127.0.0.1:${alt.port}/manifest`, timeoutMs: 5000 } }
  });

  ok("Aeltere Serverversion wird nicht eingespielt", rueck.status, "aktuell");

  // Frische Anlage gegen denselben Server: nichts da, also Gesamtpaket.
  angefragt.length = 0;

  const frisch = await updater.run({
    appDir: leerApp,
    assetsDir: leerAssets,
    dataDir: path.join(leer, "daten"),
    logger: stille,
    config: { update: { enabled: true, manifestUrl: `http://127.0.0.1:${port}/manifest`, timeoutMs: 5000 } }
  });

  ok("Frische Anlage wird eingerichtet", frisch.status, "aktualisiert");
  ok("Frische Anlage holt das Gesamtpaket statt Einzeldateien", angefragt.length, 0);
  ok("Gesamtpaket verteilt Programmdateien richtig", lies(leerApp, "utils/config.js"), "NEU");
  ok("Gesamtpaket verteilt Assets richtig", lies(leerAssets, "audio/neu.mp3"), "neuer klang");
  ok("Gesamtpaket legt keine Assets beim Programm ab", existiert(leerApp, "public/assets/audio/neu.mp3"), false);

  server.close();
  alt.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  // Unter Electrons Node haelt unzipper das Gesamtpaket bis zum Prozessende
  // offen (siehe utils/updater.js). Das Temp-Verzeichnis bleibt dann liegen.
  try {
    fs.rmSync(leer, { recursive: true, force: true });
  }
  catch(e) {
    // Aufraeumen ist Kuer.
  }

  console.log(`\nAlle Pruefungen bestanden. (${bestanden})`);
})().catch((e) => {
  console.error("\nFEHLGESCHLAGEN:", e && (e.stack || e.message) || e);
  process.exit(1);
});
