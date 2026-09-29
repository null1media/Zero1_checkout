// Die lokale Datenbank.
//
// Eine Kopie des Bestands vom Vereinsserver, dazu alles, was an dieser Kasse
// erfasst und noch nicht übertragen wurde. Die Kasse arbeitet ausschließlich
// hierauf — ob gerade Netz da ist, merkt man ihr nur an der Statusanzeige an.
//
// node:sqlite statt better-sqlite3: Electron bringt es mit, es gibt also kein
// natives Modul, das gegen Electron gebaut werden müsste (siehe HSG
// Kartenkasse und Zero1 arena: node-gyp scheitert am Leerzeichen in
// "Null1 dev"). Außerdem kann der Updater so wirklich jede Datei ersetzen.
//
// Was die Kasse selbst anlegt oder ändert (Verkäufe, Kassenbewegungen und
// im Bearbeitungsmodus Kategorien und Artikel), folgt dem Verfahren der HSG
// Kartenkasse:
//
//   - Jede Zeile trägt eine uuid, vergeben dort, wo sie entsteht. Doppelt
//     eingespielt ist beim Server dasselbe wie einmal.
//   - Offen ist, was rev > synced_rev hat. Jede lokale Änderung zählt rev
//     hoch; beim Abgleich merkt sich die Kasse den geschickten rev und hakt
//     die Zeile nur ab, wenn er beim Eintreffen der Antwort noch derselbe ist.
//     Wer während des Abgleichs weiterkassiert, verliert so nichts.
//   - Server-Stand überschreibt keine offene lokale Zeile.
//
// Kategorien und Artikel ändern auch der Adminbereich und andere Kassen. Sie
// tragen deshalb die version des Servers; die Kasse schickt sie als
// base_version mit. Passt sie drüben nicht mehr, gewinnt der Server
// ("conflict"), und die Kasse übernimmt seinen Stand.
//
// Gegenseite: lib/checkout.php im Repo tv-fridingen.de, Beschreibung in
// dessen .claude/checkout.md. Beträge in Cent.

const { DatabaseSync } = require("node:sqlite"),
      crypto = require("crypto");

// 1: Grundstock (meta).
// 2: Fachlichkeit: Veranstalter, Veranstaltungen, Kategorien, Artikel,
//    Verkäufe, Positionen, Kassenbewegungen.
const SCHEMA_VERSION = 2;

// Höchstens so viele Änderungen je Abgleich; der Server nimmt bis 2000.
const MAX_CHANGES = 500;

// Tabellen, deren Zeilen an der Kasse entstehen oder geändert werden, in der
// Reihenfolge, in der sie hinübergehen: Kategorien vor Artikeln (ein neuer
// Artikel braucht seine Kategorie), Verkäufe vor Kassenbewegungen.
const SYNCED = ["categories", "articles", "sales", "cash"];
const TYPE_OF = { categories: "category", articles: "article", sales: "sale", cash: "cash" };
const TABLE_OF = { category: "categories", article: "articles", sale: "sales", cash: "cash" };

function pad(n) {
  return String(n).padStart(2, "0");
}

// Ortszeit als "JJJJ-MM-TT hh:mm:ss", so wie der Server sie erwartet.
function localDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Der Geschäftstag: Was vor dem Tageswechsel verkauft wird, gehört zum
// Vortag. Dieselbe Rechnung wie coBusinessDay() auf dem Server.
function businessDay(dateTime, dayChange = "06:00") {
  const [h, m] = String(dayChange || "06:00").split(":").map(Number),
        [d, t] = String(dateTime).split(" "),
        [Y, M, D] = d.split("-").map(Number),
        [hh, mm, ss] = t.split(":").map(Number),
        shifted = new Date(Y, M - 1, D, hh - (h || 0), mm - (m || 0), ss || 0);

  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
}

class StoreError extends Error {}

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  // Schritt für Schritt: Eine Kasse im Feld bekommt nur die Schritte, die ihr
  // fehlen. Wer das Schema ändert, hängt einen Schritt an, statt einen
  // vorhandenen zu ändern.
  migrate() {
    const version = this.db.prepare("PRAGMA user_version").get().user_version;

    if (version >= SCHEMA_VERSION) {
      return;
    }

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
    }

    if (version < 2) {
      this.db.exec(`
        CREATE TABLE organizers (
          uuid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          address TEXT NOT NULL DEFAULT '',
          tax_number TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE events (
          uuid TEXT PRIMARY KEY,
          organizer TEXT NOT NULL,
          name TEXT NOT NULL,
          starts_on TEXT,
          ends_on TEXT,
          day_change TEXT NOT NULL DEFAULT '06:00',
          deposit_return INTEGER NOT NULL DEFAULT 0,
          receipt_footer TEXT NOT NULL DEFAULT ''
        );

        -- version: Stand des Servers, auf dem die Zeile beruht; NULL für eine
        -- an dieser Kasse angelegte, die der Server noch nicht kennt.
        -- deleted: an dieser Kasse gelöscht, noch nicht übertragen.
        CREATE TABLE categories (
          uuid TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#6c757d',
          position INTEGER NOT NULL DEFAULT 0,
          version INTEGER,
          deleted INTEGER NOT NULL DEFAULT 0,
          rev INTEGER NOT NULL DEFAULT 0,
          synced_rev INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX ix_categories_event ON categories (event);

        CREATE TABLE articles (
          uuid TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          category TEXT NOT NULL,
          name TEXT NOT NULL,
          price INTEGER NOT NULL DEFAULT 0,
          deposit INTEGER NOT NULL DEFAULT 0,
          sold_out INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          version INTEGER,
          deleted INTEGER NOT NULL DEFAULT 0,
          rev INTEGER NOT NULL DEFAULT 0,
          synced_rev INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX ix_articles_event ON articles (event);

        CREATE TABLE sales (
          uuid TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          number INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          business_day TEXT NOT NULL,
          payment TEXT NOT NULL,
          total INTEGER NOT NULL,
          given INTEGER,
          sumup_tx TEXT,
          cancelled_at TEXT,
          cancel_reason TEXT,
          rev INTEGER NOT NULL DEFAULT 1,
          synced_rev INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX ix_sales_event_day ON sales (event, business_day);

        CREATE TABLE sale_items (
          sale TEXT NOT NULL,
          position INTEGER NOT NULL,
          article TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          category_name TEXT NOT NULL,
          price INTEGER NOT NULL,
          deposit INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL DEFAULT 'verkauf',
          PRIMARY KEY (sale, position)
        );

        CREATE TABLE cash (
          uuid TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          kind TEXT NOT NULL,
          amount INTEGER NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          business_day TEXT NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1,
          synced_rev INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX ix_cash_event_day ON cash (event, business_day);
      `);
    }

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  schemaVersion() {
    return this.db.prepare("PRAGMA user_version").get().user_version;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec("BEGIN");

    try {
      const result = fn();

      this.db.exec("COMMIT");

      return result;
    }
    catch(e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  /* ---------------------------------------------------------------- Meta */

  getMeta(key, fallback = null) {
    const row = this.get("SELECT value FROM meta WHERE key = ?", key);

    return row ? JSON.parse(row.value) : fallback;
  }

  setMeta(key, value) {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  /* ------------------------------------------------- Stand vom Server */

  /*
    Antwort des Servers einspielen, in einer Transaktion.

    Vollständig (data.full): Was der Server nicht mehr liefert, verschwindet
    hier — außer es ist offen. Seit dem letzten Mal: Zeilen mit deleted
    verschwinden, alle anderen werden übernommen. Eine offene Zeile bleibt
    in beiden Fällen, wie sie ist; über sie entscheidet der Server, wenn sie
    hinübergeht.
  */
  applyExport(data) {
    this.transaction(() => {
      if (data.settings && typeof data.settings === "object") {
        this.setMeta("settings", data.settings);
      }

      const full = Boolean(data.full);

      this.applyRows("organizers", data.organizers, full, (r) => this.run(
        "INSERT INTO organizers (uuid, name, address, tax_number) VALUES (?, ?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, address = excluded.address, tax_number = excluded.tax_number",
        r.uuid, String(r.name || ""), String(r.address || ""), String(r.tax_number || "")
      ));

      this.applyRows("events", data.events, full, (r) => this.run(
        `INSERT INTO events (uuid, organizer, name, starts_on, ends_on, day_change, deposit_return, receipt_footer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET organizer = excluded.organizer, name = excluded.name, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
           day_change = excluded.day_change, deposit_return = excluded.deposit_return, receipt_footer = excluded.receipt_footer`,
        r.uuid, String(r.organizer || ""), String(r.name || ""), r.starts_on || null, r.ends_on || null, String(r.day_change || "06:00"), r.deposit_return ? 1 : 0, String(r.receipt_footer || "")
      ));

      this.applyRows("categories", data.categories, full, (r) => this.upsertCategory(r));
      this.applyRows("articles", data.articles, full, (r) => this.upsertArticle(r));

      // Was zu einer verschwundenen Veranstaltung gehörte, verschwindet mit
      // ihr (archiviert). Offenes bleibt, bis es drüben ist.
      this.run("DELETE FROM categories WHERE event NOT IN (SELECT uuid FROM events) AND rev <= synced_rev");
      this.run("DELETE FROM articles WHERE event NOT IN (SELECT uuid FROM events) AND rev <= synced_rev");
    });
  }

  applyRows(table, rows, full, upsert) {
    rows = Array.isArray(rows) ? rows.filter((r) => r && typeof r.uuid === "string") : [];

    const editable = table === "categories" || table === "articles",
          pending = new Set(editable ? this.all(`SELECT uuid FROM ${table} WHERE rev > synced_rev`).map((r) => r.uuid) : []);

    for (const r of rows) {
      if (pending.has(r.uuid)) {
        continue;
      }

      if (r.deleted) {
        this.run(`DELETE FROM ${table} WHERE uuid = ?`, r.uuid);
      }
      else {
        upsert(r);
      }
    }

    if (full) {
      const keep = new Set(rows.filter((r) => !r.deleted).map((r) => r.uuid));

      for (const { uuid } of this.all(`SELECT uuid FROM ${table}`)) {
        if (!keep.has(uuid) && !pending.has(uuid)) {
          this.run(`DELETE FROM ${table} WHERE uuid = ?`, uuid);
        }
      }
    }
  }

  // Serverstand einer Kategorie übernehmen; die Zeile ist danach nicht offen.
  upsertCategory(r) {
    this.run(
      `INSERT INTO categories (uuid, event, name, color, position, version, deleted, rev, synced_rev) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)
       ON CONFLICT(uuid) DO UPDATE SET event = excluded.event, name = excluded.name, color = excluded.color, position = excluded.position,
         version = excluded.version, deleted = 0, synced_rev = rev`,
      r.uuid, String(r.event || ""), String(r.name || ""), String(r.color || "#6c757d"), Number(r.position) || 0, Number(r.version) || 1
    );
  }

  upsertArticle(r) {
    this.run(
      `INSERT INTO articles (uuid, event, category, name, price, deposit, sold_out, position, version, deleted, rev, synced_rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
       ON CONFLICT(uuid) DO UPDATE SET event = excluded.event, category = excluded.category, name = excluded.name, price = excluded.price,
         deposit = excluded.deposit, sold_out = excluded.sold_out, position = excluded.position, version = excluded.version, deleted = 0, synced_rev = rev`,
      r.uuid, String(r.event || ""), String(r.category || ""), String(r.name || ""), Number(r.price) || 0, r.deposit ? 1 : 0, r.sold_out ? 1 : 0, Number(r.position) || 0, Number(r.version) || 1
    );
  }

  settings() {
    return this.getMeta("settings", {});
  }

  /* ------------------------------------------------ Abgleich: senden */

  // Was noch zum Server muss, und je Schlüssel der geschickte rev — für
  // applyResults().
  pendingChanges() {
    const changes = [],
          sent = {};

    for (const table of SYNCED) {
      const rows = this.all(`SELECT * FROM ${table} WHERE rev > synced_rev ORDER BY ${table === "sales" ? "number" : "rowid"} LIMIT ?`, MAX_CHANGES - changes.length);

      for (const row of rows) {
        const type = TYPE_OF[table];

        changes.push(this.changeFor(type, row));
        sent[`${type}:${row.uuid}`] = row.rev;
      }
    }

    return { changes, sent };
  }

  changeFor(type, row) {
    if (type === "sale") {
      return {
        type, uuid: row.uuid, event: row.event, number: row.number, created_at: row.created_at, payment: row.payment,
        total: row.total, given: row.given ?? undefined, sumup_tx: row.sumup_tx ?? undefined,
        cancelled_at: row.cancelled_at ?? undefined, cancel_reason: row.cancel_reason ?? undefined,
        items: this.all("SELECT * FROM sale_items WHERE sale = ? ORDER BY position", row.uuid).map((i) => ({
          article: i.article, name: i.name, category: i.category, category_name: i.category_name, price: i.price, deposit: Boolean(i.deposit), kind: i.kind
        }))
      };
    }

    if (type === "cash") {
      return { type, uuid: row.uuid, event: row.event, kind: row.kind, amount: row.amount, note: row.note, created_at: row.created_at };
    }

    if (type === "category") {
      return { type, uuid: row.uuid, event: row.event, name: row.name, color: row.color, position: row.position, base_version: row.version, deleted: Boolean(row.deleted) };
    }

    return {
      type, uuid: row.uuid, event: row.event, category: row.category, name: row.name, price: row.price, deposit: Boolean(row.deposit),
      sold_out: Boolean(row.sold_out), position: row.position, base_version: row.version, deleted: Boolean(row.deleted)
    };
  }

  pendingCount() {
    return SYNCED.reduce((sum, table) => sum + this.get(`SELECT COUNT(*) AS n FROM ${table} WHERE rev > synced_rev`).n, 0);
  }

  /*
    Ergebnisse des Servers je Änderung. Rückgabe: Hinweise für Protokoll und
    Oberfläche, [{ uuid, level: "info" | "error", message }].

      ok        abhaken, sofern rev noch der geschickte ist. Die neue version
                gilt in jedem Fall: Auch eine inzwischen weiter bearbeitete
                Zeile beruht jetzt auf ihr.
      conflict  der Server gewinnt: seinen Stand übernehmen, abhaken
      error     offen lassen, beim nächsten Abgleich wieder schicken
  */
  applyResults(results, sent = {}) {
    const notices = [];

    this.transaction(() => {
      for (const r of Array.isArray(results) ? results : []) {
        const table = r && TABLE_OF[r.type];

        if (!table || typeof r.uuid !== "string") {
          if (r && r.status === "error") {
            notices.push({ uuid: r.uuid || "", level: "error", message: r.error || "abgelehnt" });
          }

          continue;
        }

        const rev = sent[`${r.type}:${r.uuid}`];

        if (r.status === "ok") {
          if (Number.isInteger(r.version)) {
            this.run(`UPDATE ${table} SET version = ? WHERE uuid = ?`, r.version, r.uuid);
          }

          if (rev !== undefined) {
            this.run(`UPDATE ${table} SET synced_rev = rev WHERE uuid = ? AND rev = ?`, r.uuid, rev);
          }

          // Eine übertragene Löschung: jetzt wirklich weg.
          if (table === "categories" || table === "articles") {
            this.run(`DELETE FROM ${table} WHERE uuid = ? AND deleted = 1 AND rev <= synced_rev`, r.uuid);
          }
        }
        else if (r.status === "conflict" && (table === "categories" || table === "articles")) {
          const name = (this.get(`SELECT name FROM ${table} WHERE uuid = ?`, r.uuid) || {}).name || "";

          if (r.current && !r.current.deleted) {
            this.run(`UPDATE ${table} SET synced_rev = rev WHERE uuid = ?`, r.uuid);
            (table === "categories" ? this.upsertCategory(r.current) : this.upsertArticle(r.current));
          }
          else {
            this.run(`DELETE FROM ${table} WHERE uuid = ?`, r.uuid);
          }

          notices.push({
            uuid: r.uuid,
            level: "info",
            message: `„${name}" wurde inzwischen im Adminbereich oder an einer anderen Kasse geändert. Die Änderung an dieser Kasse wurde verworfen.`
          });
        }
        else if (r.status === "error") {
          notices.push({ uuid: r.uuid, level: "error", message: r.error || "abgelehnt" });
        }
      }
    });

    return notices;
  }

  /* ------------------------------------------------ Veranstaltungen */

  events() {
    return this.all("SELECT * FROM events ORDER BY COALESCE(starts_on, '9999') DESC, name");
  }

  event(uuid) {
    return uuid ? this.get("SELECT * FROM events WHERE uuid = ?", uuid) || null : null;
  }

  organizer(uuid) {
    return uuid ? this.get("SELECT * FROM organizers WHERE uuid = ?", uuid) || null : null;
  }

  /*
    Die Veranstaltung, an der diese Kasse gerade kassiert. Gewählt wird sie
    hinter der PIN; ist keine gewählt oder die gewählte verschwunden
    (archiviert), nimmt die Kasse die, die heute läuft, sonst die nächste.
  */
  activeEvent(today = localDateTime().slice(0, 10)) {
    const chosen = this.event(this.getMeta("event"));

    if (chosen) {
      return chosen;
    }

    const events = this.events();

    return events.find((e) => e.starts_on && e.starts_on <= today && (e.ends_on || e.starts_on) >= today)
      || events.filter((e) => e.starts_on && e.starts_on >= today).sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0]
      || events[0]
      || null;
  }

  setActiveEvent(uuid) {
    if (!this.event(uuid)) {
      throw new StoreError("Diese Veranstaltung gibt es auf dieser Kasse nicht.");
    }

    this.setMeta("event", uuid);
  }

  // Kategorien und Artikel einer Veranstaltung, wie die Oberfläche sie
  // zeichnet. An dieser Kasse gelöschte, noch nicht übertragene fehlen.
  layout(eventUuid) {
    return {
      categories: this.all("SELECT uuid, name, color, position FROM categories WHERE event = ? AND deleted = 0 ORDER BY position, name", eventUuid),
      articles: this.all("SELECT uuid, category, name, price, deposit, sold_out, position FROM articles WHERE event = ? AND deleted = 0 ORDER BY position, name", eventUuid)
        .map((a) => ({ ...a, deposit: Boolean(a.deposit), sold_out: Boolean(a.sold_out) }))
    };
  }

  /* ------------------------------------------------------ Verkaufen */

  /*
    Einen Verkauf buchen. Die Oberfläche schickt nur, welche Artikel und ob
    Verkauf oder Pfandrückgabe; Bezeichnung, Preis und Kategorie kommen von
    hier, zum Zeitpunkt des Verkaufs festgeschrieben.

      items:   [{ article, kind: "verkauf" | "pfandrueckgabe" }], ein Eintrag je Stück
      payment: "bar" | "karte"
      given:   bei bar, in Cent, optional
  */
  createSale({ event: eventUuid, items, payment, given = null, sumup_tx = null, now = new Date() }) {
    const event = this.event(eventUuid);

    if (!event) {
      throw new StoreError("Es ist keine Veranstaltung gewählt.");
    }

    if (!Array.isArray(items) || !items.length) {
      throw new StoreError("Der Bon ist leer.");
    }

    if (payment !== "bar" && payment !== "karte") {
      throw new StoreError("Unbekannte Zahlart.");
    }

    const lines = items.map((item) => {
      const a = this.get("SELECT a.*, c.name AS category_name FROM articles a LEFT JOIN categories c ON c.uuid = a.category WHERE a.uuid = ? AND a.event = ?", item.article, event.uuid);

      if (!a) {
        throw new StoreError("Ein Artikel auf dem Bon ist nicht mehr da. Bitte den Bon neu aufnehmen.");
      }

      const ret = item.kind === "pfandrueckgabe";

      if (ret && !a.deposit) {
        throw new StoreError(`„${a.name}" ist kein Pfandartikel.`);
      }

      if (!ret && a.sold_out) {
        throw new StoreError(`„${a.name}" ist ausverkauft.`);
      }

      return {
        article: a.uuid, name: a.name, category: a.category, category_name: a.category_name || "",
        price: ret ? -a.price : a.price, deposit: a.deposit, kind: ret ? "pfandrueckgabe" : "verkauf"
      };
    });

    const total = lines.reduce((sum, l) => sum + l.price, 0);

    if (payment === "bar" && given !== null && (!Number.isInteger(given) || given < 0)) {
      throw new StoreError("Der gegebene Betrag ist ungültig.");
    }

    if (payment === "bar" && given !== null && given < total) {
      throw new StoreError("Der gegebene Betrag reicht nicht.");
    }

    const uuid = crypto.randomUUID(),
          createdAt = localDateTime(now);

    this.transaction(() => {
      const number = this.getMeta("bon_number", 0) + 1;

      this.setMeta("bon_number", number);
      this.run(
        "INSERT INTO sales (uuid, event, number, created_at, business_day, payment, total, given, sumup_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        uuid, event.uuid, number, createdAt, businessDay(createdAt, event.day_change), payment, total, payment === "bar" ? given : null, payment === "karte" ? sumup_tx : null
      );

      lines.forEach((l, i) => this.run(
        "INSERT INTO sale_items (sale, position, article, name, category, category_name, price, deposit, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        uuid, i + 1, l.article, l.name, l.category, l.category_name, l.price, l.deposit ? 1 : 0, l.kind
      ));
    });

    return this.sale(uuid);
  }

  sale(uuid) {
    const sale = this.get("SELECT * FROM sales WHERE uuid = ?", uuid);

    if (!sale) {
      return null;
    }

    return { ...sale, items: this.all("SELECT * FROM sale_items WHERE sale = ? ORDER BY position", uuid) };
  }

  // Die letzten Verkäufe einer Veranstaltung, für Storno und Nachdruck.
  recentSales(eventUuid, limit = 30) {
    return this.all("SELECT * FROM sales WHERE event = ? ORDER BY number DESC LIMIT ?", eventUuid, limit).map((s) => ({
      ...s,
      items: this.all("SELECT name, price, kind FROM sale_items WHERE sale = ? ORDER BY position", s.uuid)
    }));
  }

  cancelSale(uuid, reason = "", now = new Date()) {
    const sale = this.get("SELECT * FROM sales WHERE uuid = ?", uuid);

    if (!sale) {
      throw new StoreError("Diesen Verkauf gibt es nicht.");
    }

    if (sale.cancelled_at) {
      throw new StoreError("Dieser Verkauf ist bereits storniert.");
    }

    this.run("UPDATE sales SET cancelled_at = ?, cancel_reason = ?, rev = rev + 1 WHERE uuid = ?", localDateTime(now), String(reason || "").slice(0, 255), uuid);

    return this.sale(uuid);
  }

  /* ------------------------------------------------ Kassenbewegungen */

  addCash({ event: eventUuid, kind, amount, note = "", now = new Date() }) {
    const event = this.event(eventUuid);

    if (!event) {
      throw new StoreError("Es ist keine Veranstaltung gewählt.");
    }

    if (!["anfang", "einlage", "entnahme", "zaehlung"].includes(kind)) {
      throw new StoreError("Unbekannte Kassenbewegung.");
    }

    if (!Number.isInteger(amount) || amount < 0) {
      throw new StoreError("Der Betrag ist ungültig.");
    }

    const uuid = crypto.randomUUID(),
          createdAt = localDateTime(now);

    this.run(
      "INSERT INTO cash (uuid, event, kind, amount, note, created_at, business_day) VALUES (?, ?, ?, ?, ?, ?, ?)",
      uuid, event.uuid, kind, amount, String(note || "").slice(0, 255), createdAt, businessDay(createdAt, event.day_change)
    );

    return this.get("SELECT * FROM cash WHERE uuid = ?", uuid);
  }

  /* ------------------------------------------------------ Auswertung */

  // Geschäftstage einer Veranstaltung, an denen an dieser Kasse etwas war.
  businessDays(eventUuid) {
    return this.all(
      "SELECT business_day FROM sales WHERE event = ? UNION SELECT business_day FROM cash WHERE event = ? ORDER BY business_day DESC",
      eventUuid, eventUuid
    ).map((r) => r.business_day);
  }

  /*
    Tagesauswertung dieser Kasse. Stornierte Verkäufe zählen nicht, werden
    aber genannt. Pfand ist kein Umsatz: Verkauftes Pfand und Rückgaben
    stehen getrennt. Der Soll-Bestand an Bargeld ist Anfangsbestand plus
    Einlagen minus Entnahmen plus alles, was bar über den Tresen ging -
    Pfand und Rückgaben eingeschlossen.
  */
  daySummary(eventUuid, day) {
    const articles = this.all(
      `SELECT i.name, i.category_name, i.price, i.kind, i.deposit, COUNT(*) AS count, SUM(i.price) AS sum
       FROM sale_items i
       JOIN sales s ON s.uuid = i.sale
       LEFT JOIN categories c ON c.uuid = i.category
       LEFT JOIN articles a ON a.uuid = i.article
       WHERE s.event = ? AND s.business_day = ? AND s.cancelled_at IS NULL
       GROUP BY i.article, i.name, i.price, i.kind
       ORDER BY COALESCE(c.position, 999), i.category_name, COALESCE(a.position, 999), i.name, i.kind DESC`,
      eventUuid, day
    );

    const totals = this.get(
      `SELECT COUNT(*) AS sales,
              COALESCE(SUM(CASE WHEN s.payment = 'bar' THEN s.total END), 0) AS cash_total,
              COALESCE(SUM(CASE WHEN s.payment = 'karte' THEN s.total END), 0) AS card_total
       FROM sales s WHERE s.event = ? AND s.business_day = ? AND s.cancelled_at IS NULL`,
      eventUuid, day
    );

    const cancelled = this.get("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS sum FROM sales WHERE event = ? AND business_day = ? AND cancelled_at IS NOT NULL", eventUuid, day);

    const deposit = articles.filter((a) => a.deposit && a.kind === "verkauf").reduce((s, a) => s + a.sum, 0),
          depositReturned = articles.filter((a) => a.kind === "pfandrueckgabe").reduce((s, a) => s + a.sum, 0),
          revenue = articles.filter((a) => !a.deposit).reduce((s, a) => s + a.sum, 0);

    const cash = this.all("SELECT * FROM cash WHERE event = ? AND business_day = ? ORDER BY created_at", eventUuid, day),
          sumOf = (kind) => cash.filter((c) => c.kind === kind).reduce((s, c) => s + c.amount, 0),
          counted = cash.filter((c) => c.kind === "zaehlung").pop() || null,
          expected = sumOf("anfang") + sumOf("einlage") - sumOf("entnahme") + totals.cash_total;

    return {
      day,
      articles,
      sales: totals.sales,
      revenue,
      deposit,
      depositReturned,
      cashTotal: totals.cash_total,
      cardTotal: totals.card_total,
      cancelled: { count: cancelled.n, sum: cancelled.sum },
      cash: {
        start: sumOf("anfang"),
        deposits: sumOf("einlage"),
        withdrawals: sumOf("entnahme"),
        expected,
        counted: counted ? counted.amount : null,
        countedAt: counted ? counted.created_at : null,
        difference: counted ? counted.amount - expected : null
      }
    };
  }

  /* ------------------------------------------- Bearbeiten an der Kasse */

  // Nächste freie Position am Ende einer Kategorie bzw. der Kategorien.
  nextPosition(table, column, value) {
    return (this.get(`SELECT MAX(position) AS p FROM ${table} WHERE ${column} = ? AND deleted = 0`, value).p ?? -1) + 1;
  }

  saveCategory({ uuid = null, event: eventUuid, name, color }) {
    name = String(name || "").trim().slice(0, 60);

    if (!name) {
      throw new StoreError("Bitte gib der Kategorie einen Namen.");
    }

    color = /^#[0-9a-f]{6}$/i.test(color || "") ? color.toLowerCase() : "#6c757d";

    if (uuid) {
      const row = this.get("SELECT * FROM categories WHERE uuid = ? AND deleted = 0", uuid);

      if (!row) {
        throw new StoreError("Diese Kategorie gibt es nicht mehr.");
      }

      this.run("UPDATE categories SET name = ?, color = ?, rev = rev + 1 WHERE uuid = ?", name, color, uuid);

      return uuid;
    }

    if (!this.event(eventUuid)) {
      throw new StoreError("Es ist keine Veranstaltung gewählt.");
    }

    uuid = crypto.randomUUID();
    this.run(
      "INSERT INTO categories (uuid, event, name, color, position, version, rev, synced_rev) VALUES (?, ?, ?, ?, ?, NULL, 1, 0)",
      uuid, eventUuid, name, color, this.nextPosition("categories", "event", eventUuid)
    );

    return uuid;
  }

  // Mit der Kategorie gehen ihre Artikel, wie im Adminbereich.
  deleteCategory(uuid) {
    this.transaction(() => {
      this.run("UPDATE articles SET deleted = 1, rev = rev + 1 WHERE category = ? AND deleted = 0", uuid);
      this.run("UPDATE categories SET deleted = 1, rev = rev + 1 WHERE uuid = ?", uuid);
    });
  }

  saveArticle({ uuid = null, event: eventUuid, category, name, price, deposit = false, sold_out = false }) {
    name = String(name || "").trim().slice(0, 60);

    if (!name) {
      throw new StoreError("Bitte gib eine Bezeichnung ein.");
    }

    if (!Number.isInteger(price) || price < 0 || price > 100000000) {
      throw new StoreError("Bitte gib einen gültigen Preis ein.");
    }

    const cat = this.get("SELECT * FROM categories WHERE uuid = ? AND deleted = 0", category);

    if (!cat) {
      throw new StoreError("Bitte wähle eine Kategorie.");
    }

    if (uuid) {
      const row = this.get("SELECT * FROM articles WHERE uuid = ? AND deleted = 0", uuid);

      if (!row) {
        throw new StoreError("Diesen Artikel gibt es nicht mehr.");
      }

      const position = row.category === category ? row.position : this.nextPosition("articles", "category", category);

      this.run(
        "UPDATE articles SET category = ?, name = ?, price = ?, deposit = ?, sold_out = ?, position = ?, rev = rev + 1 WHERE uuid = ?",
        category, name, price, deposit ? 1 : 0, sold_out ? 1 : 0, position, uuid
      );

      return uuid;
    }

    uuid = crypto.randomUUID();
    this.run(
      "INSERT INTO articles (uuid, event, category, name, price, deposit, sold_out, position, version, rev, synced_rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0)",
      uuid, cat.event, category, name, price, deposit ? 1 : 0, sold_out ? 1 : 0, this.nextPosition("articles", "category", category)
    );

    return uuid;
  }

  setSoldOut(uuid, soldOut) {
    this.run("UPDATE articles SET sold_out = ?, rev = rev + 1 WHERE uuid = ? AND deleted = 0 AND sold_out <> ?", soldOut ? 1 : 0, uuid, soldOut ? 1 : 0);
  }

  deleteArticle(uuid) {
    this.run("UPDATE articles SET deleted = 1, rev = rev + 1 WHERE uuid = ?", uuid);
  }

  /*
    Die Anordnung aus dem Bearbeitungsmodus: [{ uuid, articles: [uuid, …] }]
    in der Reihenfolge der Kategorien. Geändert wird nur, was sich bewegt
    hat — jede geänderte Zeile wird offen und könnte beim Server mit einer
    gleichzeitigen Änderung kollidieren.
  */
  saveLayout(eventUuid, layout) {
    let changed = 0;

    this.transaction(() => {
      (Array.isArray(layout) ? layout : []).forEach((block, i) => {
        const cat = this.get("SELECT * FROM categories WHERE uuid = ? AND event = ? AND deleted = 0", block && block.uuid, eventUuid);

        if (!cat) {
          return;
        }

        if (cat.position !== i) {
          this.run("UPDATE categories SET position = ?, rev = rev + 1 WHERE uuid = ?", i, cat.uuid);
          changed++;
        }

        (Array.isArray(block.articles) ? block.articles : []).forEach((uuid, j) => {
          const art = this.get("SELECT * FROM articles WHERE uuid = ? AND event = ? AND deleted = 0", uuid, eventUuid);

          if (art && (art.position !== j || art.category !== cat.uuid)) {
            this.run("UPDATE articles SET category = ?, position = ?, rev = rev + 1 WHERE uuid = ?", cat.uuid, j, uuid);
            changed++;
          }
        });
      });
    });

    return changed;
  }
}

module.exports = { Store, StoreError, SCHEMA_VERSION, businessDay, localDateTime };
