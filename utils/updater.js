// Aktualisierung Datei fuer Datei.
//
// Uebernommen von Zero1 arena, damit Aktualisierung und Seriennummer bei allen
// Zero1-Programmen gleich laufen. Gegenseite ist checkout.null1.media im Repo
// null1.media (httpdocs/index.php, files.php, download.php, lib/cron.php).
//
// Der Client vergleicht seinen Bestand gegen eine Liste mit SHA-256 je Datei
// und laedt nur die Abweichungen - gebuendelt als ZIP ueber files.php, oder
// das Gesamtpaket, wenn der Grossteil fehlt. Zwei Ziele, abgeleitet aus dem
// Pfad:
//
//   public/assets/**  ->  Datenverzeichnis/assets/   (schlaegt die Auslieferung)
//   alles andere      ->  Programmverzeichnis
//
// Zero1 checkout bringt derzeit keine Assets mit; die Trennung bleibt trotzdem
// drin, damit der Code derselbe ist wie bei Zero1 arena.
//
// Was NICHT geht: Abhaengigkeiten. node_modules liegt nicht im Repo, steht also
// in keinem Manifest. Aendert sich package.json an dieser Stelle, sagt der
// Updater es und verweist auf einen neuen Installer.

const crypto = require("crypto"),
      dns = require("dns"),
      fileIndex = require("./fileIndex"),
      fs = require("fs"),
      http = require("http"),
      https = require("https"),
      path = require("path"),
      unzipper = require("unzipper"),
      FALLBACK_DNS = ["8.8.8.8", "1.1.1.1"];

// Ab wann lohnt das Einzelladen nicht mehr. Auf einem frisch aufgesetzten
// Laptop fehlt alles; dann ist das fertige Gesamt-ZIP schneller als tausende
// Dateien in Haeppchen.
const VOLLPAKET_AB_ANTEIL = 0.5;

// Wie viel je Anfrage. Beides begrenzt, damit weder PHP noch der Arbeits-
// speicher hier ins Schwitzen kommt.
const BATCH_DATEIEN = 150,
      BATCH_BYTES = 120 * 1024 * 1024;

// Funktionen
function semverGt(a, b) {
  const pa = String(a).split(".").map(Number),
        pb = String(b).split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const ai = pa[i] || 0, bi = pb[i] || 0;

    if (ai !== bi) {
      return ai > bi;
    }
  }

  return false;
}

function readJson(p, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  catch(e) {
    return fallback;
  }
}

function resolveFallback(hostname) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    for (const server of FALLBACK_DNS) {
      const resolver = new dns.Resolver();

      resolver.setServers([server]);
      resolver.resolve4(hostname, (err, addresses) => {
        if (!resolved && !err && addresses.length) {
          resolved = true;
          resolve(addresses[0]);
        }
      });
    }

    setTimeout(() => {
      if (!resolved) {
        reject(new Error(`DNS-Fallback konnte ${hostname} nicht auflösen.`));
      }
    }, 5000);
  });
}

function request(url, { headers = {}, timeoutMs = 10000, onProgress, body, overrideHost } = {}) {
  return _request(url, { headers, timeoutMs, onProgress, body, overrideHost }).catch(async (err) => {
    if (err.code !== "ENOTFOUND") {
      throw err;
    }

    const parsed = new URL(url),
          ip = await resolveFallback(parsed.hostname);

    return _request(url, { headers, timeoutMs, onProgress, body, overrideHost: ip });
  });
}

// Wie request(), legt die Antwort aber auf die Platte statt in den Speicher.
// Fuer das Gesamtpaket ist das der einzig gangbare Weg: Es ist 1,1 GB gross,
// und die in einen Buffer zu ziehen beendet den Prozess, statt ihn zu starten.
function requestToFile(url, opts, ziel) {
  return _request(url, { ...opts, toFile: ziel });
}

function _request(url, { headers, timeoutMs, onProgress, body, overrideHost, toFile }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url),
          istPost = body !== undefined && body !== null,
          // In der Auslieferung ist das immer https. http gibt es, damit sich
          // der Ablauf gegen einen lokalen Server pruefen laesst - siehe
          // test/updater.js.
          treiber = parsed.protocol === "http:" ? http : https;

    const options = {
      hostname: overrideHost || parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      method: istPost ? "POST" : "GET",
      headers: { ...headers },
      servername: parsed.hostname
    };

    if (overrideHost) {
      options.headers["Host"] = parsed.hostname;
    }

    if (istPost) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = treiber.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} bei ${parsed.pathname}`));
        res.resume();

        return;
      }

      const total = parseInt(res.headers["content-length"] || "0", 10),
            chunks = [];

      let downloaded = 0;

      res.on("error", reject);

      if (toFile) {
        ensureDir(path.dirname(toFile));

        const senke = fs.createWriteStream(toFile);

        res.on("data", (c) => {
          downloaded += c.length;

          if (onProgress) {
            onProgress(downloaded, total);
          }
        });

        senke.on("error", reject);
        senke.on("finish", () => resolve(toFile));
        res.pipe(senke);

        return;
      }

      res.on("data", (c) => {
        chunks.push(c);
        downloaded += c.length;

        if (onProgress) {
          onProgress(downloaded, total);
        }
      });

      res.on("end", () => resolve(Buffer.concat(chunks)));
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Timeout")));

    if (istPost) {
      req.write(body);
    }

    req.end();
  });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Der Arena-Token steckt als Query-Parameter in der Manifestadresse. Nach
// aussen heisst er "Seriennummer" -- fuer den, der das Programm einrichtet, ist
// er genau das: eine Zeichenkette, die einmal eingegeben wird und ohne die
// nichts geht.
function tokenAus(manifestUrl) {
  try {
    return new URL(String(manifestUrl)).searchParams.get("token") || "";
  }
  catch(e) {
    return "";
  }
}

function mitToken(manifestUrl, token) {
  try {
    const url = new URL(String(manifestUrl));

    url.searchParams.set("token", token);

    return url.toString();
  }
  catch(e) {
    return manifestUrl;
  }
}

// Stimmt die Seriennummer?
//
// Unterschieden wird zwischen "abgelehnt" und "nicht erreichbar", weil das zwei
// verschiedene Probleme sind: Das eine loest man mit einer anderen Nummer, das
// andere mit einem Netzwerkkabel. index.php weist einen falschen Token nicht ab,
// sondern liefert die gewoehnliche Webseite -- deshalb gilt HTML hier als
// Ablehnung.
async function pruefeZugang({ manifestUrl, token = "", timeoutMs = 10000 }) {
  let buf;

  try {
    buf = await request(manifestUrl, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
      timeoutMs
    });
  }
  catch(e) {
    if (/HTTP 40[13]/.test(e.message || "")) {
      return { ok: false, grund: "token" };
    }

    return { ok: false, grund: "netz", message: e.message };
  }

  const text = buf.toString("utf8");

  if (text.trimStart().startsWith("<")) {
    return { ok: false, grund: "token" };
  }

  try {
    const manifest = JSON.parse(text);

    if (!manifest || !manifest.version) {
      return { ok: false, grund: "token" };
    }

    return { ok: true, version: String(manifest.version) };
  }
  catch(e) {
    return { ok: false, grund: "token" };
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmRecursiveSafe(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function istAsset(manifestPath) {
  return manifestPath.startsWith(fileIndex.ASSET_PREFIX);
}

// Was ueberhaupt ausgeliefert wird.
//
// Auf dem Server steht der komplette Repo-Inhalt, also auch build/, test/ und
// CLAUDE.md. Die gehoeren nicht auf die Kasse. Dieselbe Liste steht in
// lib/cron.php auf der Serverseite — sie MUESSEN uebereinstimmen, sonst gilt
// hier als "zu viel", was dort schlicht nie mitgeliefert wurde, und der Client
// loescht es bei jedem Start aufs Neue.
const AUSGELIEFERT = [
  /^main\.js$/,
  /^preload\.js$/,
  /^package\.json$/,
  /^utils\//,
  /^public\//
];

function wirdAusgeliefert(manifestPath) {
  return AUSGELIEFERT.some((muster) => muster.test(manifestPath));
}

// Eine Datei an ihren Platz legen. Erst daneben schreiben, dann umbenennen —
// ein Absturz mitten im Schreiben hinterlaesst sonst eine halbe Datei, und
// eine halbe Datei faellt erst auf dem Fest auf.
function platziere(zielPfad, buffer) {
  ensureDir(path.dirname(zielPfad));

  const tmp = `${zielPfad}.neu`;

  fs.writeFileSync(tmp, buffer);
  fs.rmSync(zielPfad, { force: true });
  fs.renameSync(tmp, zielPfad);
}

// Leere Ordner nach dem Aufraeumen entfernen, aber nie die Wurzel selbst.
function raeumeLeereOrdner(start, wurzel) {
  let dir = path.dirname(start);

  while (dir.startsWith(wurzel) && dir !== wurzel) {
    try {
      if (fs.readdirSync(dir).length) {
        return;
      }

      fs.rmdirSync(dir);
    }
    catch(e) {
      return;
    }

    dir = path.dirname(dir);
  }
}

async function ladeDateiliste(url, token, timeoutMs) {
  const buf = await request(url, {
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    timeoutMs
  });

  const daten = JSON.parse(buf.toString("utf8"));

  if (!daten || typeof daten.files !== "object" || !daten.files) {
    throw new Error("Dateiliste unvollständig! Erwartet: files.");
  }

  return daten;
}

// Das Delta holen: eine Anfrage je Bündel, Antwort ist ein ZIP mit genau den
// angefragten Dateien.
async function ladeBuendel(deltaUrl, token, pfade, timeoutMs, onProgress) {
  const buf = await request(deltaUrl, {
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/zip" },
    timeoutMs,
    body: JSON.stringify({ paths: pfade }),
    onProgress
  });

  const eintraege = new Map(),
        directory = await unzipper.Open.buffer(buf);

  for (const eintrag of directory.files) {
    if (eintrag.type === "File") {
      eintraege.set(eintrag.path.replace(/\\/g, "/"), await eintrag.buffer());
    }
  }

  return eintraege;
}

// Das Gesamtpaket. Es wandert auf die Platte, wird von dort geprueft und von
// dort gelesen -- Eintrag fuer Eintrag, nie als Ganzes im Speicher. Bei 1,1 GB
// ist das kein Feinschliff, sondern der Unterschied zwischen Start und Absturz.
//
// Rueckgabe ist kein Map, sondern eine Funktion: Der Inhalt wird erst gelesen,
// wenn er gebraucht wird.
async function ladeVollpaket(zipUrl, token, erwarteteSha, timeoutMs, zipPfad, onProgress) {
  await requestToFile(zipUrl, {
    headers: { "Authorization": `Bearer ${token}` },
    timeoutMs: Math.max(timeoutMs, 600000),
    onProgress
  }, zipPfad);

  if (erwarteteSha) {
    const gotSha = (await fileIndex.sha256File(zipPfad)).toLowerCase();

    if (gotSha !== String(erwarteteSha).toLowerCase()) {
      throw new Error(`SHA-256 des Gesamtpakets ist ungültig! Erwartet: ${erwarteteSha}, Erhalten: ${gotSha}`);
    }
  }

  const directory = await unzipper.Open.file(zipPfad),
        nachPfad = new Map();

  for (const eintrag of directory.files) {
    if (eintrag.type === "File") {
      nachPfad.set(eintrag.path.split("\\").join("/"), eintrag);
    }
  }

  return async (pfad) => {
    const eintrag = nachPfad.get(pfad);

    return eintrag ? await eintrag.buffer() : null;
  };
}

// Haupteinstieg.
//
// Rueckgabe sagt dem Aufrufer genau zwei Dinge: ob etwas passiert ist und ob
// davon Programmdateien betroffen waren. Nur im zweiten Fall muss neu
// gestartet werden — geaenderte Assets liest die Anwendung ohnehin frisch.
async function run({ appDir, assetsDir, dataDir, logger, config, onStatus }) {
  const updateCfg = config.update || {},
        manifestUrl = updateCfg.manifestUrl,
        timeoutMs = updateCfg.timeoutMs || 10000,
        token = updateCfg.token || "",
        localPkg = readJson(path.join(appDir, "package.json"), { version: "0.0.0" }),
        localVersion = String(localPkg.version || "0.0.0");

  const melde = (text, anteil) => {
    if (onStatus) {
      onStatus(text, anteil);
    }
  };

  if (!manifestUrl) {
    logger.info("Keine Adresse für die Aktualisierung hinterlegt, es wird nicht geprüft.");

    return { status: "uebersprungen", version: localVersion, programChanged: false };
  }

  melde("Suche nach Aktualisierungen…", null);

  // Reste eines frueheren Laufs, dessen Zwischenablage sich nicht leeren
  // liess (siehe unten). Jetzt ist die Datei nicht mehr geoeffnet.
  try {
    rmRecursiveSafe(path.join(dataDir, ".stage"));
  }
  catch(e) {
    logger.warn(`Alte Zwischenablage nicht entfernt (${e.code || e.message}).`);
  }

  let manifest;

  try {
    const buf = await request(manifestUrl, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
      timeoutMs
    });

    const text = buf.toString("utf8");

    // Stimmt der Token nicht, weist index.php die Anfrage nicht ab, sondern
    // liefert die gewoehnliche Webseite. Ohne diese Unterscheidung stuende im
    // Protokoll ein Parse-Fehler, der nichts darueber sagt, was zu tun ist --
    // und genau das ist der Zustand einer frischen Installation, in der die
    // Adresse noch aus der Vorlage stammt und auf "token=" endet.
    if (text.trimStart().startsWith("<")) {
      logger.warn("Der Server liefert kein Manifest, sondern eine Webseite. Das heisst fast immer: In update.manifestUrl fehlt der Token oder er stimmt nicht. Die Seriennummer fehlt oder stimmt nicht.");

      return { status: "uebersprungen", version: localVersion, programChanged: false };
    }

    manifest = JSON.parse(text);
  }
  catch(e) {
    logger.warn(`Kein Manifest abrufbar (${e.message}). Start mit lokaler Version ${localVersion}.`);

    return { status: "uebersprungen", version: localVersion, programChanged: false };
  }

  const remoteVersion = String(manifest.version || "");

  if (!remoteVersion) {
    logger.warn("Manifest ohne Version, Aktualisierung wird übersprungen.");

    return { status: "uebersprungen", version: localVersion, programChanged: false };
  }

  // Nie zurueck. Ist der Server aelter als der Client — etwa waehrend eines
  // Rollbacks —, bleibt der Client, wo er ist.
  if (semverGt(localVersion, remoteVersion)) {
    logger.info(`Server hat ${remoteVersion}, lokal liegt ${localVersion}. Kein Rückschritt.`);

    return { status: "aktuell", version: localVersion, programChanged: false };
  }

  if (!manifest.filesUrl || !manifest.deltaUrl) {
    logger.warn("Das Manifest kennt keine Dateiliste. Der Server läuft noch auf der alten Auslieferung.");

    return { status: "uebersprungen", version: localVersion, programChanged: false };
  }

  // Serverbestand holen und lokalen daneben legen.
  melde("Dateiliste wird geladen…", null);

  const ferne = await ladeDateiliste(manifest.filesUrl, token, timeoutMs);

  melde("Bestand wird geprüft…", null);

  const lokal = await fileIndex.build({
    appDir,
    assetsDir,
    cacheFile: path.join(dataDir, ".fileindex.json"),
    include: wirdAusgeliefert
  });

  // Vergleich.
  const noetig = [],
        ueberfluessig = [];

  let noetigeBytes = 0,
      gesamtBytes = 0;

  for (const [pfad, eintrag] of Object.entries(ferne.files)) {
    if (!fileIndex.isSafePath(pfad)) {
      logger.warn(`Manifestpfad abgelehnt: ${pfad}`);

      continue;
    }

    if (!wirdAusgeliefert(pfad)) {
      continue;
    }

    gesamtBytes += Number(eintrag.size) || 0;

    const hier = lokal[pfad];

    if (!hier || hier.sha256 !== String(eintrag.sha256).toLowerCase()) {
      noetig.push({ pfad, size: Number(eintrag.size) || 0, sha256: String(eintrag.sha256).toLowerCase() });
      noetigeBytes += Number(eintrag.size) || 0;
    }
  }

  for (const pfad of Object.keys(lokal)) {
    if (!ferne.files[pfad]) {
      ueberfluessig.push(pfad);
    }
  }

  if (!noetig.length && !ueberfluessig.length) {
    logger.success(`Alles aktuell (Version ${localVersion}).`);

    return { status: "aktuell", version: localVersion, programChanged: false };
  }

  const programmBetroffen = noetig.some((n) => !istAsset(n.pfad)) || ueberfluessig.some((p) => !istAsset(p)),
        // Liegt lokal kein einziges Asset, ist das kein Update, sondern die
        // Erstausstattung: Der Installer bringt die 1,1 GB bewusst nicht mit.
        // Fuer den, der davorsitzt, ist das ein Unterschied -- er wartet nicht
        // auf eine Aktualisierung, sondern auf die Musik.
        ersteEinrichtung = !Object.keys(lokal).some(istAsset),
        titel = ersteEinrichtung ? "Musik, Videos und Bilder werden geladen" : "Aktualisierung wird geladen";

  logger.info(`Aktualisierung auf ${remoteVersion}: ${noetig.length} Datei(en) zu laden (${(noetigeBytes / (1024 * 1024)).toFixed(1)} MB), ${ueberfluessig.length} zu entfernen.`);

  // Abhaengigkeiten koennen nicht mitwandern.
  const ferneDeps = JSON.stringify(ferne.dependencies || {}),
        lokaleDeps = JSON.stringify(localPkg.dependencies || {});

  if (ferne.dependencies && ferneDeps !== lokaleDeps) {
    logger.warn("Die Abhängigkeiten haben sich geändert. node_modules liegt nicht im Paket — für diese Version wird ein neuer Installer benötigt.");
  }

  // Herunterladen. Entweder das Gesamtpaket oder Buendel.
  const vollpaket = gesamtBytes > 0 && (noetigeBytes / gesamtBytes) >= VOLLPAKET_AB_ANTEIL;

  // Beide Wege liefern dasselbe: eine Funktion, die zu einem Pfad den Inhalt
  // gibt. Beim Delta liegt er im Speicher, beim Gesamtpaket auf der Platte.
  const geladen = new Map(),
        zipPfad = path.join(dataDir, ".stage", `app-${remoteVersion}.zip`);

  let hole = async (pfad) => geladen.get(pfad) || null;

  if (vollpaket && manifest.zipUrl) {
    logger.info("Es fehlt der Großteil des Bestands — das Gesamtpaket ist schneller.");
    melde(`${titel}…`, 0);

    hole = await ladeVollpaket(manifest.zipUrl, token, manifest.sha256, timeoutMs, zipPfad, (down, total) => {
      // Geschuetzte Leerzeichen in der Zahlenangabe: Ohne sie bricht die Zeile
      // im Ladebildschirm mitten zwischen "684" und "von 1103 MB" um. So
      // wandert die ganze Angabe geschlossen in die zweite Zeile.
      const mb = (b) => (b / (1024 * 1024)).toFixed(0),
            zahl = total ? `${mb(down)} von ${mb(total)} MB` : `${mb(down)} MB`;

      melde(`${titel}… ${zahl}`, total ? down / total : null);
    });
  }
  else {
    const buendel = [];

    let aktuell = [],
        aktuelleBytes = 0;

    for (const eintrag of noetig) {
      if (aktuell.length >= BATCH_DATEIEN || (aktuelleBytes + eintrag.size) > BATCH_BYTES) {
        if (aktuell.length) {
          buendel.push(aktuell);
        }

        aktuell = [];
        aktuelleBytes = 0;
      }

      aktuell.push(eintrag.pfad);
      aktuelleBytes += eintrag.size;
    }

    if (aktuell.length) {
      buendel.push(aktuell);
    }

    let fertig = 0;

    for (let i = 0; i < buendel.length; i++) {
      melde(`${titel}… (${fertig} von ${noetig.length} Dateien)`, fertig / noetig.length);

      const teil = await ladeBuendel(manifest.deltaUrl, token, buendel[i], Math.max(timeoutMs, 300000));

      for (const [pfad, buffer] of teil) {
        geladen.set(pfad, buffer);
      }

      fertig += buendel[i].length;
    }
  }

  // Pruefen und platzieren.
  const einspielTitel = ersteEinrichtung ? "Wird eingerichtet" : "Wird eingespielt";

  melde(`${einspielTitel}…`, 0);

  let eingespielt = 0;

  for (const eintrag of noetig) {
    // Auspacken und Pruefen von 1,1 GB dauert spuerbar laenger als das
    // Herunterladen selbst. Ohne Rueckmeldung stuende der Balken hier still
    // und saehe aus wie ein Haenger.
    if (eingespielt % 25 === 0) {
      melde(`${einspielTitel}… (${eingespielt} von ${noetig.length} Dateien)`, eingespielt / noetig.length);
    }

    const buffer = await hole(eintrag.pfad);

    if (!buffer) {
      throw new Error(`Der Server hat ${eintrag.pfad} nicht mitgeliefert.`);
    }

    const gotSha = sha256(buffer).toLowerCase();

    if (gotSha !== eintrag.sha256) {
      throw new Error(`SHA-256 von ${eintrag.pfad} stimmt nicht. Erwartet: ${eintrag.sha256}, erhalten: ${gotSha}`);
    }

    platziere(fileIndex.resolveTarget(eintrag.pfad, { appDir, assetsDir }), buffer);
    eingespielt++;
  }

  // Aufraeumen. Nur innerhalb der beiden Wurzeln und nur, was ausgeliefert
  // wuerde — alles andere gehoert der Installation, nicht dem Paket.
  for (const pfad of ueberfluessig) {
    const ziel = fileIndex.resolveTarget(pfad, { appDir, assetsDir });

    try {
      fs.rmSync(ziel, { force: true });
      raeumeLeereOrdner(ziel, istAsset(pfad) ? assetsDir : appDir);
    }
    catch(e) {
      logger.warn(`${pfad} konnte nicht entfernt werden: ${e.message}`);
    }
  }

  // Der Zwischenspeicher beschreibt jetzt einen Bestand, den es nicht mehr
  // gibt. Ihn wegzuwerfen kostet einmal Zeit und ist allemal besser, als mit
  // falschen Hashes weiterzurechnen.
  rmRecursiveSafe(path.join(dataDir, ".fileindex.json"));

  // Das heruntergeladene Gesamtpaket wird nicht aufgehoben. Es ist so gross
  // wie der Bestand selbst, und ein zweites Mal gebraucht wird es nie.
  //
  // Abweichung von Zero1 arena: Unter Electrons Node haelt unzipper die ZIP-
  // Datei noch offen, und Windows verweigert das Loeschen (ENOTEMPTY). Die
  // Dateien sind zu diesem Zeitpunkt laengst eingespielt - ein Fehler hier
  // liesse den Aufrufer glauben, die Aktualisierung sei gescheitert, und der
  // noetige Neustart bliebe aus. Die Reste raeumt der naechste Lauf weg.
  try {
    rmRecursiveSafe(path.join(dataDir, ".stage"));
  }
  catch(e) {
    logger.warn(`Die Zwischenablage liess sich nicht leeren (${e.code || e.message}). Sie wird beim naechsten Lauf entfernt.`);
  }

  logger.success(`Aktualisierung auf Version ${remoteVersion} abgeschlossen (${eingespielt} Datei(en), ${ueberfluessig.length} entfernt).`);

  return {
    status: "aktualisiert",
    version: remoteVersion,
    programChanged: programmBetroffen,
    files: eingespielt,
    removed: ueberfluessig.length
  };
}

module.exports = { run, semverGt, wirdAusgeliefert, pruefeZugang, tokenAus, mitToken, AUSGELIEFERT };
