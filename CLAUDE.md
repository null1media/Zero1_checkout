# Zero1 checkout

Kassenprogramm für Feste des TV 05 Fridingen. Ersetzt das bisherige
Access/VBA-Programm auf den Kassenlaptops, dessen Kassen nicht zusammenarbeiteten:
Jede Kasse arbeitet offline weiter und gleicht mit dem Verein ab, sobald Netz da ist.

Ein **Null1-media-Produkt** wie Zero1 arena: Installer, Programmsymbol und
Ladebildschirm im Null1-Design, erst die Kasse selbst trägt Logo und Farben des
Vereins.

## Stand

| Schritt | Inhalt | |
|---|---|---|
| 1 | Gerüst: Ladebildschirm, Seriennummer, Updater, Kopplung, SQLite, Abgleich, Einstellungen | fertig, Ende-zu-Ende erprobt am 19.09.2026 |
| 2 | Fachlichkeit nach Vorlage des alten Access-Programms: Artikel, Kategorien, Veranstaltungen, Verkauf, Bons, Auswertungen | offen |

## Zwei Gegenstellen

| Wofür | Wohin | Vorbild |
|---|---|---|
| Seriennummer, Aktualisierung | `checkout.null1.media` (Repo `null1.media`) | Zero1 arena, **exakt dasselbe Verfahren** |
| Kopplung, Abgleich der Daten | `tv-fridingen.de/checkout/` (Repo `tv-fridingen.de`) | HSG Kartenkasse |

Die Seriennummer gehört zum Produkt, das Kassentoken zum Verein. Beide sind
unabhängig: Eine Kasse kann ihre Seriennummer behalten und im Adminbereich
gesperrt und neu gekoppelt werden.

## Stack

Electron 44 (Node 24). **Eine** Laufzeitabhängigkeit, `unzipper`, weil der
Updater der von Zero1 arena ist. Kein Framework, kein Build-Schritt, keine
Bündel — die Oberfläche lädt ihre Dateien so, wie sie im Repo liegen.

| | |
|---|---|
| `main.js` | Hülle: Startreihenfolge, Fenster, Menü, IPC |
| `preload.js` | die **einzige** Brücke zur Oberfläche, `window.checkout` |
| `utils/updater.js`, `utils/fileIndex.js` | Aktualisierung, übernommen von Zero1 arena |
| `utils/api.js` | HTTP gegen tv-fridingen.de, Fehlerarten |
| `utils/store.js` | lokale Datenbank (`node:sqlite`) |
| `utils/sync.js` | wann und wie abgeglichen wird |
| `utils/device.js` | Kassentoken, verschlüsselt über `safeStorage` |
| `utils/config.js` | `config.json`, Vorgaben |
| `utils/splash.js` | Ladebildschirm samt Abfragen, Design von Zero1 arena |
| `utils/paths.js`, `utils/logger.js` | Datenverzeichnis, Protokoll je Tag |
| `public/` | `index.html` (Kasse), `settings.html`, CSS, JS, Schriften, Bilder |
| `build/` | `start.js`, `release.js`, Symbole von Zero1 arena |
| `test/` | direkt mit Electron-Node, kein Framework |

| Skript | |
|---|---|
| `npm start` | die Kasse aus dem Quelltext |
| `npm test` | alle Tests, in Electrons Node |
| `npm run dist` | NSIS-Installer nach `dist/` |
| `npm run release` | Tests, Version heben, committen, taggen, pushen |

Wer eine Funktion in die Oberfläche bringt, trägt sie in `preload.js` **und**
`registerIpc()` in `main.js` ein.

## Der Start

`main.js`, in dieser Reihenfolge — sie ist nicht beliebig:

1. Datenverzeichnis, `config.json`. Ist sie kaputt: Abbruch mit Meldung, **nicht** überschreiben.
2. Ladebildschirm.
3. **Seriennummer**, nur wenn in `update.manifestUrl` kein `token` steht und nur
   im gepackten Programm. Geprüft gegen `checkout.null1.media`: HTML heißt
   abgelehnt, keine Antwort heißt kein Netz. Eine hinterlegte wird beim Start
   **nicht** geprüft (Fest ohne Internet).
4. **Aktualisierung** über `checkout.null1.media`. Vor allem anderen, damit schon
   der neue Code koppelt und abgleicht. Programmdateien geändert → Neustart.
5. **Kopplung**, falls kein Kassentoken da ist.
6. **Abgleich.** Beim allerersten Start Pflicht, mit „Erneut versuchen / Beenden".
   Danach höchstens `sync.startTimeoutMs` warten. Antwortet der Server 401:
   Token weg, neu koppeln.
7. Kassenfenster. Der Ladebildschirm schließt bei `ready-to-show`.

## Datenverzeichnis

`%APPDATA%\zero1-checkout`, fest benannt. Im Quelltextbetrieb legt
`ZERO1_CHECKOUT_DATA_DIR` es woanders hin; `APPDATA` umzubiegen hilft **nicht**.
Das gepackte Programm nimmt immer `%APPDATA%` — ein Probelauf mit dem Build legt
dort also echte Daten an.

| Datei | Inhalt |
|---|---|
| `config.json` | Server, Takt, **Seriennummer** in `update.manifestUrl` |
| `device.json` | Kasse und Token, Token über DPAPI verschlüsselt |
| `zero1-checkout.sqlite` | lokaler Bestand |
| `.fileindex.json` | Hash-Index des Updaters |
| `assets/` | Assets aus `public/assets/**` (derzeit keine) |
| `logs/JJJJ-MM-TT.log` | Protokoll, 30 Tage |

## Die lokale Datenbank

`utils/store.js`. Im Gerüst nur `meta`. Schema in `PRAGMA user_version`, umgestellt
Schritt für Schritt in `migrate()` — wer das Schema ändert, **hängt einen Schritt
an**, statt einen vorhandenen zu ändern.

Für alles, was die Kasse anlegt (Verkäufe), gilt das Verfahren der HSG
Kartenkasse: `uuid` an der Kasse vergeben, offen ist `rev > synced_rev`, ein
Abgleich hakt nur ab, wenn `rev` beim Eintreffen der Antwort noch derselbe ist,
Server-Stand überschreibt keine offene Zeile. **Erst den Server ausrollen, dann
die Kasse**: Unbekannte Änderungen lehnt der Server ab, sie bleiben offen.

## Der Updater

Von Zero1 arena übernommen: Manifest → Dateiliste mit SHA-256 → nur Abweichendes
als ZIP über `files.php`, oder das Gesamtpaket, wenn mehr als die Hälfte fehlt.
Jede Datei gegen ihren Hash prüfen, daneben schreiben, umbenennen.

**Die Liste der ausgelieferten Pfade steht zweimal:** `AUSGELIEFERT` in
`utils/updater.js` und `wird_ausgeliefert()` in `checkout.null1.media/lib/cron.php`.
Sie **müssen** übereinstimmen, sonst löscht die Kasse bei jedem Start, was der
Server nie liefert.

**Eine Abweichung von Zero1 arena:** Nach einem Gesamtpaket hält `unzipper` die
ZIP-Datei unter Electrons Node offen, das Leeren von `.stage` scheitert unter
Windows mit `ENOTEMPTY`. In Zero1 arena wirft `run()` dann, obwohl alles
eingespielt ist, und der Neustart bleibt aus — die Arena-Tests laufen in reinem
Node und sehen es nicht. Hier ist das Leeren abgefangen und wird beim nächsten
Lauf nachgeholt.

**Ein Neustart direkt nach der Installation ist normal**: electron-builder kürzt
die `package.json` im Paket, der Updater ersetzt sie beim ersten Start.
Abhängigkeiten kann der Updater nicht ersetzen — ändern sie sich, braucht es
einen neuen Installer.

## Eine Version herausgeben

```
npm run release            0.1.0 -> 0.1.1
npm run release -- minor   0.1.0 -> 0.2.0
```

Plesk rollt auf `checkout.null1.media` nach `lib/app/zero1-checkout` aus, der
Cron `lib/cron.php` baut die Auslieferung **nur bei steigender Version**.

## Design

- **Null1 media**: Ladebildschirm (`utils/splash.js`, Verlauf und Aufbau von
  Zero1 arena), Programmsymbol `build/icon.png`, Installer `build/icon-dark.ico`,
  Fenster `public/img/favicon.ico` — alle von Zero1 arena übernommen.
  Schriftzug `public/img/zero1-checkout.png`: Symbol aus dem Arena-Logo,
  „checkout" in Montserrat Bold wie „arena", nachgebaut am 19.09.2026, keine
  Originaldatei.
- **TV Fridingen**, nur in der Kasse: Logo `public/img/tv-fridingen.png`,
  Anthrazit `#2b292a` / `#363537`, Rot `#c32229`, Rubik — die Farben des
  Adminbereichs von tv-fridingen.de.
- **Nicht `.placeholder`**: Die Klasse gehört Bootstrap (grauer Lade-Platzhalter).

## Entwicklungsrechner

Wie bei der HSG Kartenkasse: Node 24 LTS, Electron lädt sein Binary erst bei der
ersten Benutzung, `ELECTRON_RUN_AS_NODE` aus VS Code räumt `build/start.js` weg,
Tests laufen in Electrons Node.

**Probeläufe des gepackten Programms** — Seriennummer und Updater laufen nur dort:

1. `npx electron-builder --win --dir` baut `dist/win-unpacked`.
2. `checkout.null1.media` lokal: Ebene kopieren, `composer install`,
   `config.env` mit `CHECKOUT_TOKEN`, in der **Kopie** `$basis` in
   `httpdocs/index.php` auf `http://127.0.0.1:<port>` setzen, das Programm mit
   gehobener Version nach `lib/app/zero1-checkout`, `php lib/cron.php`,
   `php -S`.
3. tv-fridingen.de lokal mit `sql/2026-09-19-checkout.sql`, Kopplungscode über
   `/admin/kasse/`.
4. `%APPDATA%\zero1-checkout\config.json` mit `server` und `update.manifestUrl`
   (ohne `token`) auf die lokalen Server.
5. Programm mit `--remote-debugging-port` starten und die Fenster über
   puppeteer-core steuern; es überlebt den Neustart nach dem Update.
6. Danach `%APPDATA%\zero1-checkout` wieder entfernen.
