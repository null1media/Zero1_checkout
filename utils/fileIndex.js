// Welche Dateien liegen hier, und sind es dieselben wie auf dem Server?
//
// Der Updater hat bis 09/2026 bei jeder neuen Version das komplette Paket
// geladen und den gesamten Bestand zweimal umkopiert — bei 1,1 GB Assets rund
// 2,2 GB Kopiererei fuer eine geaenderte Zeile in backend.js. Damit nur noch
// das Geaenderte uebertragen wird, braucht es einen Vergleich Datei fuer
// Datei, und dafuer einen SHA-256 je Datei.
//
// Alles bei jedem Start zu hashen dauert bei 1,1 GB deutlich zu lang. Deshalb
// ein Zwischenspeicher im Datenverzeichnis: Groesse und Zeitstempel je Datei.
// Stimmen beide noch, gilt der gespeicherte Hash; sonst wird neu gelesen. Der
// erste Lauf zahlt den vollen Preis, jeder weitere fast nichts.

const crypto = require("crypto"),
      fs = require("fs"),
      path = require("path");

// Der Praefix, unter dem die Assets im Manifest stehen. Lokal liegen sie
// woanders — im Datenverzeichnis, nicht beim Programm —, im Manifest aber
// unter ihrem Pfad im Repo. Hier wird zwischen beiden Welten uebersetzt.
const ASSET_PREFIX = "public/assets/";

// Was nie synchronisiert wird. node_modules steht bewusst dabei: Die Pakete
// liegen nicht im Repo, kommen also auch nicht im Manifest vor. Aendern sich
// Abhaengigkeiten, hilft nur ein neuer Installer — der Updater sagt das dann
// auch (siehe utils/updater.js).
const NEVER = new Set(["node_modules", ".git", ".stage", ".backup", ".pending", ".data", "logs"]);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256"),
          stream = fs.createReadStream(file);

    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Rekursiv auflisten. Rueckgabe sind Pfade relativ zur Wurzel, immer mit
// Schraegstrich — das Manifest kommt von einem Linux-Server, Windows-
// Backslashes wuerden dort nie passen.
function walk(root, relative = "") {
  const out = [];

  let entries;

  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  }
  catch(e) {
    return out;
  }

  for (const entry of entries) {
    if (NEVER.has(entry.name)) {
      continue;
    }

    const rel = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...walk(root, rel));
    }
    else if (entry.isFile()) {
      out.push(rel);
    }
  }

  return out;
}

function readCache(cacheFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

    return raw && typeof raw === "object" && raw.files ? raw.files : {};
  }
  catch(e) {
    return {};
  }
}

function writeCache(cacheFile, files) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, files }, null, 0), "utf8");
  }
  catch(e) {
    // Ein fehlender Zwischenspeicher kostet Zeit, nicht Richtigkeit.
  }
}

// Der lokale Bestand in der Sprache des Manifests.
//
// Zwei Wurzeln, ein Namensraum: Was unter assetsDir liegt, bekommt den
// Praefix public/assets/ vorangestellt, alles aus appDir behaelt seinen Pfad.
// Danach laesst sich Eintrag fuer Eintrag mit dem Manifest vergleichen.
async function build({ appDir, assetsDir, cacheFile, include }) {
  const cache = readCache(cacheFile),
        fresh = {},
        result = {};

  const quellen = [
    { root: appDir, prefix: "" },
    { root: assetsDir, prefix: ASSET_PREFIX }
  ];

  for (const { root, prefix } of quellen) {
    if (!root || !fs.existsSync(root)) {
      continue;
    }

    for (const rel of walk(root)) {
      const key = prefix + rel;

      // Der Assetnamensraum gehoert ausschliesslich dem Datenverzeichnis. Im
      // Quelltextbetrieb liegt unter appDir zusaetzlich public/assets; ohne
      // diese Zeile stuenden dieselben Schluessel zweimal im Index, einmal je
      // Wurzel, und der Vergleich mit dem Manifest liefe ins Leere.
      if (!prefix && key.startsWith(ASSET_PREFIX)) {
        continue;
      }

      // Nur, was auch ausgeliefert wird. Ohne diesen Filter zaehlte im
      // Quelltextbetrieb auch build/, test/ und CLAUDE.md mit und gaelte
      // anschliessend als "zu viel" und damit als loeschbar.
      if (include && !include(key)) {
        continue;
      }

      const full = path.join(root, rel);

      let stat;

      try {
        stat = fs.statSync(full);
      }
      catch(e) {
        continue;
      }

      const bekannt = cache[key];

      let sha;

      if (bekannt && bekannt.size === stat.size && bekannt.mtimeMs === stat.mtimeMs && bekannt.sha256) {
        sha = bekannt.sha256;
      }
      else {
        sha = await sha256File(full);
      }

      const eintrag = { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha };

      fresh[key] = eintrag;
      result[key] = { size: stat.size, sha256: sha, file: full };
    }
  }

  writeCache(cacheFile, fresh);

  return result;
}

// Wo landet ein Manifestpfad auf dieser Installation?
function resolveTarget(manifestPath, { appDir, assetsDir }) {
  if (manifestPath.startsWith(ASSET_PREFIX)) {
    return path.join(assetsDir, manifestPath.slice(ASSET_PREFIX.length));
  }

  return path.join(appDir, manifestPath);
}

// Kein Pfad darf aus seiner Wurzel herausfuehren. Das Manifest kommt zwar vom
// eigenen Server, aber ein "../.." darin wuerde beliebige Dateien auf dem
// Kassenlaptop ueberschreiben — das prueft man, statt es zu glauben.
function isSafePath(manifestPath) {
  if (typeof manifestPath !== "string" || !manifestPath.length || manifestPath.length > 1024) {
    return false;
  }

  if (manifestPath.startsWith("/") || manifestPath.includes("\\") || manifestPath.includes("\0")) {
    return false;
  }

  return !manifestPath.split("/").some((teil) => teil === "" || teil === "." || teil === "..");
}

module.exports = { ASSET_PREFIX, build, isSafePath, resolveTarget, sha256File, walk };
