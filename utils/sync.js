// Der Abgleich mit dem Vereinsserver.
//
// Ein Durchlauf ist ein einziger Aufruf: Änderungen dieser Kasse hinüber,
// Stand des Servers zurück. Auf einem Fest ist das Netz wacklig, und was einmal
// durchgeht, ist vollständig — es gibt keinen halben Abgleich, bei dem die
// Änderungen drüben sind, der neue Stand aber nicht hier.
//
// Wann abgeglichen wird:
//   - beim Start (main.js wartet kurz darauf, siehe sync.startTimeoutMs)
//   - regelmäßig, alle sync.intervalSeconds
//   - kurz nach jeder Änderung an der Kasse (schedule())
//   - auf Knopfdruck
//
// Vollständig (since = null) beim ersten Mal und danach einmal täglich: Nur
// dann räumt die Kasse weg, was der Server nicht mehr liefert.

const { EventEmitter } = require("events");

const FULL_EVERY_MS = 24 * 60 * 60 * 1000,
      SCHEDULE_DELAY_MS = 1500;

class Sync extends EventEmitter {
  constructor({ store, api, logger, intervalSeconds = 60, timeoutMs = 15000 }) {
    super();
    this.store = store;
    this.api = api;
    this.logger = logger;
    this.intervalMs = Math.max(15, intervalSeconds) * 1000;
    this.timeoutMs = timeoutMs;
    this.running = null;
    this.again = false;
    this.timer = null;
    this.scheduled = null;
    this.state = {
      state: this.store.getMeta("server_time") ? "offline" : "neu",
      message: "",
      lastSyncAt: this.store.getMeta("last_sync_at"),
      pending: this.store.pendingCount(),
      device: this.store.getMeta("device")
    };
  }

  hasData() {
    return Boolean(this.store.getMeta("server_time"));
  }

  status() {
    return { ...this.state, pending: this.store.pendingCount() };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("status", this.status());
  }

  /*
    Ein Durchlauf. Läuft schon einer, wird kein zweiter gestartet, sondern
    danach genau einer nachgeholt — eine Änderung, die während des Abgleichs
    passiert, soll nicht bis zum nächsten Takt warten.
  */
  run({ timeoutMs = this.timeoutMs, full = false } = {}) {
    if (this.running) {
      this.again = true;

      return this.running;
    }

    this.running = this.runOnce({ timeoutMs, full }).finally(() => {
      this.running = null;

      if (this.again && this.state.state !== "gesperrt") {
        this.again = false;
        this.run();
      }
    });

    return this.running;
  }

  async runOnce({ timeoutMs, full }) {
    const lastFull = this.store.getMeta("last_full_sync_at", 0),
          wantFull = full || !this.hasData() || Date.now() - lastFull > FULL_EVERY_MS,
          since = wantFull ? null : this.store.getMeta("server_time"),
          { changes, sent } = this.store.pendingChanges();

    this.setState({ state: "läuft", message: "" });

    let response;

    try {
      response = await this.api.sync({ since, changes }, timeoutMs);
    }
    catch(e) {
      if (e.art === "gesperrt") {
        this.logger.warn(`Abgleich abgelehnt: ${e.message}`);
        this.stop();
        this.setState({ state: "gesperrt", message: "Dieses Gerät ist nicht mehr freigeschaltet. Bitte in den Einstellungen neu koppeln." });
      }
      else if (e.art === "netz") {
        this.setState({ state: "offline", message: e.message });
      }
      else {
        this.logger.error(`Abgleich fehlgeschlagen: ${e.message}`);
        this.setState({ state: "fehler", message: e.message });
      }

      return { ok: false, error: e };
    }

    let notices;

    try {
      notices = this.store.applyResults(response.results, sent);
      this.store.applyExport(response);
      this.store.setMeta("server_time", response.server_time);
      this.store.setMeta("last_sync_at", new Date().toISOString());
      this.store.setMeta("device", response.device || null);

      if (response.full) {
        this.store.setMeta("last_full_sync_at", Date.now());
      }
    }
    catch(e) {
      // Die Antwort passt nicht zur lokalen Datenbank. Nichts davon wurde
      // übernommen (Transaktion), der nächste Durchlauf versucht es erneut.
      this.logger.error(`Antwort des Servers konnte nicht übernommen werden: ${e.stack || e.message}`);
      this.setState({ state: "fehler", message: "Die Antwort des Servers konnte nicht übernommen werden." });

      return { ok: false, error: e };
    }

    const errors = notices.filter((n) => n.level === "error");

    if (changes.length) {
      this.logger.info(`Abgleich: ${changes.length} Änderung(en) übertragen${errors.length ? `, ${errors.length} abgelehnt` : ""}.`);
    }

    for (const n of notices) {
      (n.level === "error" ? this.logger.warn : this.logger.info)(`Abgleich, ${n.uuid}: ${n.message}`);
    }

    this.setState({
      state: "verbunden",
      message: errors.length ? `${errors.length} Änderung(en) wurden vom Server abgelehnt.` : "",
      lastSyncAt: this.store.getMeta("last_sync_at"),
      device: response.device || this.state.device
    });

    if (notices.length) {
      this.emit("notices", notices);
    }

    // Der Bestand kann sich geändert haben (Artikel, Preise, PIN): Die
    // Oberfläche zeichnet neu.
    this.emit("synced", { full: Boolean(response.full) });

    return { ok: true, full: Boolean(response.full), notices };
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.run(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
  }

  // Nach einer Änderung an der Kasse: gleich abgleichen, aber nicht bei jedem
  // Tastendruck — mehrere Schritte kurz hintereinander gehen gemeinsam.
  schedule() {
    this.emit("status", this.status());

    if (this.state.state === "gesperrt") {
      return;
    }

    if (this.scheduled) {
      clearTimeout(this.scheduled);
    }

    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.run();
    }, SCHEDULE_DELAY_MS);
  }
}

module.exports = { Sync };
