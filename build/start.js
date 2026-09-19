// Electron starten — ohne ELECTRON_RUN_AS_NODE.
//
// VS Code setzt diese Variable für alles, was aus seinem Terminal oder seinen
// Erweiterungen heraus läuft. Electron startet dann als nacktes Node:
// require("electron") liefert undefined, und das Programm stirbt mit
// "Cannot read properties of undefined (reading 'whenReady')". Mit dem Code
// hat das nichts zu tun, deshalb räumt dieses Skript die Variable weg.
//
// Aufruf: npm start                    (die Kasse)
//         node build/start.js <datei>  (ein anderes Electron-Skript)

const { spawn } = require("child_process"),
      path = require("path"),
      electron = require("electron");

const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);

const child = spawn(electron, args.length ? args : [path.join(__dirname, "..")], {
  stdio: "inherit",
  env,
  windowsHide: false
});

child.on("exit", (code) => process.exit(code ?? 0));
