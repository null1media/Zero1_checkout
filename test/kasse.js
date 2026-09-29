// Fachlichkeit der lokalen Datenbank: Bestand einspielen, verkaufen,
// übertragen, Konflikte, Kassenbewegungen, Auswertung, Bearbeiten.

const path = require("path"),
      { Store, StoreError, businessDay } = require("../utils/store"),
      { check, equal, tempDir, done } = require("./helpers");

const store = new Store(path.join(tempDir("kasse"), "k.sqlite"));

const EV = "11111111-1111-4111-8111-111111111111",
      ORG = "22222222-2222-4222-8222-222222222222",
      CAT_DRINK = "33333333-3333-4333-8333-333333333333",
      CAT_FOOD = "44444444-4444-4444-8444-444444444444",
      BEER = "55555555-5555-4555-8555-555555555555",
      WURST = "66666666-6666-4666-8666-666666666666",
      PFAND = "77777777-7777-4777-8777-777777777777",
      HELFER = "88888888-8888-4888-8888-888888888888";

// ---------------------------------------------------------- Geschäftstag

equal("Geschäftstag am Abend", businessDay("2026-07-11 23:30:00", "06:00"), "2026-07-11");
equal("Geschäftstag nachts", businessDay("2026-07-12 01:30:00", "06:00"), "2026-07-11");
equal("Geschäftstag ab Wechsel", businessDay("2026-07-12 06:00:00", "06:00"), "2026-07-12");
equal("Monatswechsel", businessDay("2026-08-01 02:00:00", "06:00"), "2026-07-31");

// ------------------------------------------------------ Bestand einspielen

const fullExport = {
  full: true,
  settings: { club_name: "TV", pin: "" },
  organizers: [{ uuid: ORG, name: "Förderverein", address: "Hauptstr. 1", tax_number: "123", deleted: false }],
  events: [{ uuid: EV, organizer: ORG, name: "Hammerwerk Open", starts_on: "2026-07-10", ends_on: "2026-07-12", day_change: "06:00", deposit_return: true, receipt_footer: "Danke", deleted: false }],
  categories: [
    { uuid: CAT_DRINK, event: EV, name: "Getränke", color: "#1f6fb2", position: 0, version: 1, deleted: false },
    { uuid: CAT_FOOD, event: EV, name: "Essen", color: "#c32229", position: 1, version: 1, deleted: false }
  ],
  articles: [
    { uuid: BEER, event: EV, category: CAT_DRINK, name: "Pils 0,5l", price: 400, deposit: false, sold_out: false, position: 0, version: 1, deleted: false },
    { uuid: PFAND, event: EV, category: CAT_DRINK, name: "Pfand Glas", price: 200, deposit: true, sold_out: false, position: 1, version: 1, deleted: false },
    { uuid: WURST, event: EV, category: CAT_FOOD, name: "Currywurst", price: 450, deposit: false, sold_out: false, position: 0, version: 3, deleted: false },
    { uuid: HELFER, event: EV, category: CAT_FOOD, name: "Helferessen", price: 0, deposit: false, sold_out: false, position: 1, version: 1, deleted: false }
  ]
};

store.applyExport(fullExport);

equal("eine Veranstaltung", store.events().length, 1);
equal("aktive Veranstaltung ohne Wahl: die laufende", store.activeEvent("2026-07-11").uuid, EV);

let layout = store.layout(EV);

equal("zwei Kategorien", layout.categories.map((c) => c.name), ["Getränke", "Essen"]);
equal("Artikel je Kategorie in Reihenfolge", layout.articles.filter((a) => a.category === CAT_DRINK).map((a) => a.name), ["Pils 0,5l", "Pfand Glas"]);
equal("Pfand als Wahrheitswert", layout.articles.find((a) => a.uuid === PFAND).deposit, true);
equal("nichts offen nach dem Einspielen", store.pendingCount(), 0);

// ---------------------------------------------------------------- Verkauf

const now = new Date(2026, 6, 12, 1, 30, 0);

let sale = store.createSale({
  event: EV,
  items: [{ article: BEER }, { article: BEER }, { article: PFAND }, { article: PFAND }, { article: WURST }],
  payment: "bar",
  given: 2000,
  now
});

equal("Summe", sale.total, 400 + 400 + 200 + 200 + 450);
equal("Bonnummer", sale.number, 1);
equal("Geschäftstag des Verkaufs", sale.business_day, "2026-07-11");
equal("eine Position je Stück", sale.items.length, 5);
equal("Bezeichnung festgeschrieben", sale.items[4].name, "Currywurst");
equal("Kategorie festgeschrieben", sale.items[4].category_name, "Essen");
equal("offen", store.pendingCount(), 1);

const helper = store.createSale({ event: EV, items: [{ article: HELFER }], payment: "bar", now });

equal("0-€-Artikel ist ein normaler Verkauf", helper.total, 0);
equal("Bonnummer zählt weiter", helper.number, 2);

let error = null;

try {
  store.createSale({ event: EV, items: [{ article: BEER }], payment: "bar", given: 100, now });
}
catch(e) {
  error = e;
}

check("zu wenig gegeben", error instanceof StoreError);

error = null;

try {
  store.createSale({ event: EV, items: [{ article: BEER, kind: "pfandrueckgabe" }], payment: "bar", now });
}
catch(e) {
  error = e;
}

check("Rückgabe nur für Pfand", error instanceof StoreError);

const back = store.createSale({ event: EV, items: [{ article: PFAND, kind: "pfandrueckgabe" }, { article: PFAND, kind: "pfandrueckgabe" }], payment: "bar", now });

equal("Pfandrückgabe negativ", back.total, -400);
equal("Art der Position", back.items[0].kind, "pfandrueckgabe");

const card = store.createSale({ event: EV, items: [{ article: WURST }], payment: "karte", sumup_tx: "TX1", given: 5000, now });

equal("Karte ohne gegeben", card.given, null);
equal("SumUp-Vorgang", card.sumup_tx, "TX1");

// Preisänderung vom Server ändert keinen gebuchten Verkauf
store.applyExport({ articles: [{ ...fullExport.articles[0], price: 450, version: 2 }] });
equal("neuer Preis in der Kasse", store.layout(EV).articles.find((a) => a.uuid === BEER).price, 450);
equal("alter Preis im Verkauf", store.sale(sale.uuid).items[0].price, 400);

// ----------------------------------------------------- Übertragen, abhaken

let { changes, sent } = store.pendingChanges();

equal("vier Verkäufe offen", changes.map((c) => c.type), ["sale", "sale", "sale", "sale"]);
equal("Verkauf mit Positionen", changes[0].items.length, 5);
equal("Positionen tragen das Pfand", changes[0].items[2].deposit, true);
equal("Zeitpunkt in Ortszeit", changes[0].created_at, "2026-07-12 01:30:00");

// Während der Abgleich läuft, wird der erste Verkauf storniert.
store.cancelSale(sale.uuid, "falsch getippt", now);

store.applyResults(changes.map((c) => ({ type: c.type, uuid: c.uuid, status: "ok" })), sent);
equal("Storno bleibt offen, der Rest ist abgehakt", store.pendingCount(), 1);

({ changes, sent } = store.pendingChanges());
equal("Storno geht mit", changes[0].cancelled_at, "2026-07-12 01:30:00");
equal("Grund geht mit", changes[0].cancel_reason, "falsch getippt");
store.applyResults([{ type: "sale", uuid: sale.uuid, status: "ok" }], sent);
equal("alles abgehakt", store.pendingCount(), 0);

let notices = store.applyResults([{ type: "sale", uuid: "x", status: "error", error: "Unbekannte Änderung." }], {});

equal("Fehler wird Hinweis", notices[0].level, "error");

// ------------------------------------------------------- Kassenbewegungen

store.addCash({ event: EV, kind: "anfang", amount: 15000, now: new Date(2026, 6, 11, 16, 0, 0) });
store.addCash({ event: EV, kind: "entnahme", amount: 5000, now: new Date(2026, 6, 11, 22, 0, 0) });
store.addCash({ event: EV, kind: "zaehlung", amount: 10000, now: new Date(2026, 6, 12, 2, 0, 0) });

({ changes } = store.pendingChanges());
equal("Kassenbewegungen offen", changes.map((c) => c.kind), ["anfang", "entnahme", "zaehlung"]);

// ------------------------------------------------------------ Auswertung

const summary = store.daySummary(EV, "2026-07-11");

equal("stornierter Verkauf zählt nicht", summary.sales, 3);
equal("storniert genannt", summary.cancelled, { count: 1, sum: 1650 });
equal("Umsatz ohne Pfand (Helfer 0 €, Karte 4,50 €)", summary.revenue, 0 + 450);
equal("kein Pfand verkauft (storniert)", summary.deposit, 0);
equal("Pfandrückgabe", summary.depositReturned, -400);
equal("bar", summary.cashTotal, 0 - 400);
equal("Karte", summary.cardTotal, 450);
equal("Soll-Bestand", summary.cash.expected, 15000 - 5000 - 400);
equal("Differenz zur Zählung", summary.cash.difference, 10000 - 9600);
equal("Geschäftstage", store.businessDays(EV), ["2026-07-11"]);

// ------------------------------------------------ Bearbeiten an der Kasse

store.applyResults(store.pendingChanges().changes.map((c) => ({ type: c.type, uuid: c.uuid, status: "ok" })), store.pendingChanges().sent);
equal("vor dem Bearbeiten nichts offen", store.pendingCount(), 0);

store.setSoldOut(WURST, true);
check("ausverkauft", store.layout(EV).articles.find((a) => a.uuid === WURST).sold_out);

error = null;

try {
  store.createSale({ event: EV, items: [{ article: WURST }], payment: "bar", now });
}
catch(e) {
  error = e;
}

check("Ausverkauftes lässt sich nicht verkaufen", error instanceof StoreError);

const newCat = store.saveCategory({ event: EV, name: "Kaffee und Kuchen", color: "#8D5B3A" }),
      cake = store.saveArticle({ event: EV, category: newCat, name: "Kuchen", price: 250 });

equal("neue Kategorie am Ende", store.layout(EV).categories.map((c) => c.name), ["Getränke", "Essen", "Kaffee und Kuchen"]);

const moved = store.saveLayout(EV, [
  { uuid: CAT_FOOD, articles: [HELFER, WURST] },
  { uuid: CAT_DRINK, articles: [PFAND, BEER] },
  { uuid: newCat, articles: [cake] }
]);

equal("nur Bewegtes geändert", moved, 6);
layout = store.layout(EV);
equal("neue Reihenfolge", layout.categories.map((c) => c.name), ["Essen", "Getränke", "Kaffee und Kuchen"]);

({ changes, sent } = store.pendingChanges());

const types = changes.map((c) => c.type);

check("Kategorien vor Artikeln", types.lastIndexOf("category") < types.indexOf("article"), types.join(","));
equal("neue Kategorie ohne Basis", changes.find((c) => c.uuid === newCat).base_version, null);
equal("Currywurst mit Basis 3", changes.find((c) => c.uuid === WURST).base_version, 3);

// Server: Kategorie und Kuchen neu (ok, Version 1), Currywurst im Konflikt
// (inzwischen im Adminbereich auf 5 € gesetzt), der Rest ok.
const results = changes.map((c) => {
  if (c.uuid === WURST) {
    return { type: "article", uuid: WURST, status: "conflict", current: { ...fullExport.articles[2], price: 500, version: 4 } };
  }

  return { type: c.type, uuid: c.uuid, status: "ok", version: c.base_version === null ? 1 : c.base_version + 1 };
});

notices = store.applyResults(results, sent);

equal("nichts mehr offen", store.pendingCount(), 0);
equal("Konflikt gemeldet", notices.length, 1);
layout = store.layout(EV);

const wurst = layout.articles.find((a) => a.uuid === WURST);

equal("Server gewinnt: Preis", wurst.price, 500);
equal("Server gewinnt: nicht ausverkauft", wurst.sold_out, false);
equal("Server gewinnt: Kategorie und Platz", [wurst.category, wurst.position], [CAT_FOOD, 0]);
equal("neue Version übernommen", store.get("SELECT version FROM categories WHERE uuid = ?", newCat).version, 1);

// Offene Zeile wird vom Export nicht überschrieben
store.saveArticle({ uuid: BEER, event: EV, category: CAT_DRINK, name: "Pils", price: 450 });
store.applyExport({ articles: [{ ...fullExport.articles[0], name: "Pils vom Server", version: 9 }] });
equal("offene Zeile bleibt", store.layout(EV).articles.find((a) => a.uuid === BEER).name, "Pils");

// Löschen an der Kasse
store.deleteArticle(cake);
equal("gelöschter Artikel fehlt in der Ansicht", store.layout(EV).articles.some((a) => a.uuid === cake), false);
({ changes, sent } = store.pendingChanges());
equal("Löschung geht hinüber", changes.find((c) => c.uuid === cake).deleted, true);
store.applyResults(changes.map((c) => ({ type: c.type, uuid: c.uuid, status: "ok", version: 2 })), sent);
equal("übertragene Löschung ist weg", store.get("SELECT COUNT(*) AS n FROM articles WHERE uuid = ?", cake).n, 0);

// ------------------------------------------ Vollständig: Weggefallenes

store.applyExport({ ...fullExport, events: [], categories: [], articles: [] });
equal("archivierte Veranstaltung verschwindet", store.events().length, 0);
equal("mit ihren Artikeln", store.get("SELECT COUNT(*) AS n FROM articles").n, 0);
equal("Verkäufe bleiben", store.get("SELECT COUNT(*) AS n FROM sales").n, 4);
equal("keine aktive Veranstaltung", store.activeEvent("2026-07-11"), null);

store.close();
done();
