// HTTP-Client und Abgleich gegen einen lokalen Server, der die Antworten von
// httpdocs/checkout/ im Repo tv-fridingen.de nachstellt.

const http = require("http"),
      path = require("path"),
      { Api } = require("../utils/api"),
      { Store } = require("../utils/store"),
      { Sync } = require("../utils/sync"),
      { check, equal, rejects, tempDir, done, quietLogger } = require("./helpers");

const TOKEN = "a".repeat(64);

let calls = [],
    mode = "ok";

const server = http.createServer((req, res) => {
  let body = "";

  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const url = new URL(req.url, "http://localhost"),
          parsed = body ? JSON.parse(body) : null;

    calls.push({ path: url.pathname, action: url.searchParams.get("action"), auth: req.headers.authorization, version: req.headers["x-app-version"], body: parsed });

    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (mode === "html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>WLAN-Anmeldung</title>");

      return;
    }

    if (mode === "slow") {
      await new Promise((r) => setTimeout(r, 800));
    }

    if (mode === "unknown-change") {
      return json(200, {
        server_time: "2026-09-20 18:05:00.000000",
        device: { id: 3, name: "Kasse Festzelt" },
        full: false,
        results: [{ uuid: "x", status: "error", error: "Unbekannte Änderung." }],
        settings: { club_name: "Turnverein 1905 Fridingen e. V." }
      });
    }

    if (url.searchParams.get("action") === "pair") {
      return parsed.code === "ABCDEFGH"
        ? json(200, { token: TOKEN, device: { id: 3, name: "Kasse Festzelt" } })
        : json(403, { error: "Dieser Kopplungscode ist ungültig oder abgelaufen." });
    }

    if (url.searchParams.get("action") === "sync") {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return json(401, { error: "Diese Kasse ist nicht (mehr) freigeschaltet." });
      }

      return json(200, {
        server_time: "2026-09-20 18:00:00.123456",
        device: { id: 3, name: "Kasse Festzelt" },
        full: parsed.since === null,
        results: [],
        settings: { club_name: "Turnverein 1905 Fridingen e. V.", tax_rate: 19, tax_rate_reduced: 7 }
      });
    }

    json(404, { error: "Unbekannte Aktion." });
  });
});

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}/checkout/`;

  // ---------------------------------------------------------------- Api

  const api = new Api({ baseUrl: base, version: "0.1.0", timeoutMs: 400 });

  await rejects("falscher Kopplungscode", () => api.pair("ZZZZZZZZ"), (e) => e.art === "abgelehnt" && /ungültig/.test(e.message));

  const paired = await api.pair("ABCDEFGH");

  equal("Kopplung liefert Token", paired.token, TOKEN);
  check("Kopplung ohne Authorization", calls[calls.length - 1].auth === undefined);

  await rejects("Abgleich ohne Token", () => api.sync({ since: null, changes: [] }), (e) => e.art === "gesperrt");

  api.setToken(TOKEN);

  const response = await api.sync({ since: null, changes: [] });

  equal("Abgleich mit Token", response.device.name, "Kasse Festzelt");
  equal("Token als Bearer", calls[calls.length - 1].auth, `Bearer ${TOKEN}`);
  equal("Version im Kopf", calls[calls.length - 1].version, "0.1.0");
  equal("Pfad", calls[calls.length - 1].path, "/checkout/index.php");

  mode = "html";
  await rejects("HTML statt JSON gilt als kein Server", () => api.sync({ since: null, changes: [] }), (e) => e.art === "netz");

  mode = "slow";
  await rejects("Zeitüberschreitung gilt als kein Server", () => api.sync({ since: null, changes: [] }), (e) => e.art === "netz");

  await rejects("nicht erreichbar", () => new Api({ baseUrl: "http://127.0.0.1:1/", timeoutMs: 400 }).sync({ since: null, changes: [] }), (e) => e.art === "netz");

  mode = "ok";

  // ---------------------------------------------------------------- Sync

  const store = new Store(path.join(tempDir("sync"), "c.sqlite")),
        sync = new Sync({ store, api, logger: quietLogger, intervalSeconds: 60, timeoutMs: 2000 }),
        states = [];

  sync.on("status", (s) => states.push(s.state));

  check("ohne Daten", !sync.hasData());

  calls = [];

  let result = await sync.run();

  check("erster Abgleich gelingt", result.ok);
  equal("erster Abgleich vollständig", calls[0].body.since, null);
  check("Daten da", sync.hasData());
  equal("Zustand", sync.status().state, "verbunden");
  equal("Vereinsangaben übernommen", store.settings().club_name, "Turnverein 1905 Fridingen e. V.");
  equal("Kasse gemerkt", sync.status().device.name, "Kasse Festzelt");

  calls = [];
  result = await sync.run();
  equal("danach seit letztem Stand", calls[0].body.since, "2026-09-20 18:00:00.123456");
  equal("nichts offen", calls[0].body.changes, []);

  // Zwei Aufrufe gleichzeitig: einer läuft, genau einer wird nachgeholt.
  calls = [];
  await Promise.all([sync.run(), sync.run(), sync.run()]);
  await new Promise((r) => setTimeout(r, 300));
  equal("gleichzeitige Aufrufe gebündelt", calls.length, 2);

  // Abgelehnte Änderungen werden gemeldet, nicht verschluckt
  mode = "unknown-change";

  const notices = [];

  sync.on("notices", (n) => notices.push(...n));
  result = await sync.run();
  check("Abgleich trotz Ablehnung ok", result.ok);
  equal("Ablehnung als Hinweis", notices.map((n) => n.level), ["error"]);
  mode = "ok";

  // Offline
  const offline = new Sync({ store, api: new Api({ baseUrl: "http://127.0.0.1:1/", token: TOKEN, timeoutMs: 300 }), logger: quietLogger });

  result = await offline.run();
  check("offline scheitert", !result.ok);
  equal("offline-Zustand", offline.status().state, "offline");
  check("Daten bleiben", store.settings().club_name === "Turnverein 1905 Fridingen e. V.");

  // Gesperrt
  const locked = new Sync({ store, api: new Api({ baseUrl: base, token: "b".repeat(64), timeoutMs: 1000 }), logger: quietLogger });

  locked.start();
  result = await locked.run();
  equal("gesperrt-Zustand", locked.status().state, "gesperrt");
  check("gesperrt stoppt den Takt", locked.timer === null);

  check("Statuswechsel gemeldet", states.includes("läuft") && states.includes("verbunden"));

  sync.stop();
  store.close();
  server.close();
  done();
});
