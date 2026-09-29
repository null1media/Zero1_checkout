// Kartenzahlung über einen Absturz hinweg: bepreisen beim Anstoßen, merken,
// aus dem Gemerkten buchen, nie doppelt. Dazu, was die Datenbank für die
// Haltbarkeit einstellt.

const path = require("path"),
      { Store, StoreError } = require("../utils/store"),
      { check, equal, tempDir, done } = require("./helpers");

const file = path.join(tempDir("karte"), "k.sqlite");

let store = new Store(file);

const EV = "11111111-1111-4111-8111-111111111111",
      ORG = "22222222-2222-4222-8222-222222222222",
      CAT = "33333333-3333-4333-8333-333333333333",
      BEER = "55555555-5555-4555-8555-555555555555",
      PFAND = "77777777-7777-4777-8777-777777777777";

const article = (uuid, name, price, extra = {}) => ({ uuid, event: EV, category: CAT, name, price, deposit: false, sold_out: false, position: 0, version: 1, deleted: false, ...extra });

store.applyExport({
  full: true,
  settings: { club_name: "TV", pin: "" },
  organizers: [{ uuid: ORG, name: "Förderverein", address: "", tax_number: "", deleted: false }],
  events: [{ uuid: EV, organizer: ORG, name: "Fest", starts_on: "2026-07-10", ends_on: "2026-07-12", day_change: "06:00", deposit_return: true, receipt_footer: "", deleted: false }],
  categories: [{ uuid: CAT, event: EV, name: "Getränke", color: "#1f6fb2", position: 0, version: 1, deleted: false }],
  articles: [article(BEER, "Pils", 400), article(PFAND, "Pfand", 200, { deposit: true })]
});

equal("synchronous = FULL", store.get("PRAGMA synchronous").synchronous, 2);

// ---------------------------------------------------------- Bepreisen

const quote = store.quote(EV, [{ article: BEER }, { article: PFAND }]);

equal("Summe beim Anstoßen", quote.total, 600);
equal("Positionen festgeschrieben", quote.lines.map((l) => [l.name, l.price]), [["Pils", 400], ["Pfand", 200]]);
equal("Pfand als Wahrheitswert", quote.lines[1].deposit, true);

let error = null;

try {
  store.quote(EV, []);
}
catch(e) {
  error = e;
}

check("leerer Bon wird nicht bepreist", error instanceof StoreError);

// ------------------------------------------------ Merken und absturzfest

store.setCardPending({ id: "TX1", ...quote, terminal: "Solo 1", started_at: "2026-07-11 20:00:00", status: "pending" });

// Die Kasse stürzt ab: Die Datenbank wird ohne Aufräumen neu geöffnet.
store.close();
store = new Store(file);

equal("gemerkte Zahlung übersteht den Neustart", store.cardPending().id, "TX1");

// Inzwischen ändert der Verein den Preis und das Pils ist aus.
store.applyExport({ articles: [article(BEER, "Pils", 450, { sold_out: true, version: 2 })] });

error = null;

try {
  store.createSale({ event: EV, items: [{ article: BEER }], payment: "karte", sumup_tx: "TX-neu" });
}
catch(e) {
  error = e;
}

check("neu verkaufen ginge nicht mehr", error instanceof StoreError);

// ------------------------------------------ Buchen aus dem Gemerkten

const pending = store.cardPending(),
      sale = store.createSale({ event: pending.event, lines: pending.lines, payment: "karte", sumup_tx: pending.id });

equal("gebucht, was bezahlt ist", sale.total, 600);
equal("zum alten Preis", sale.items[0].price, 400);
equal("mit SumUp-ID", sale.sumup_tx, "TX1");
equal("gemerkte Zahlung ist erledigt", store.cardPending(), null);

const again = store.createSale({ event: pending.event, lines: pending.lines, payment: "karte", sumup_tx: "TX1" });

equal("zweimal gebucht ist einmal", again.uuid, sale.uuid);
equal("nur ein Verkauf", store.get("SELECT COUNT(*) AS n FROM sales").n, 1);
equal("Bonnummer nicht verbraucht", store.getMeta("bon_number"), 1);

// ---------------------------------------------------- nur die gemeinte

store.setCardPending({ id: "TX2", ...quote, status: "pending" });
store.clearCardPending("TX1");
equal("alte ID räumt keine neue weg", store.cardPending().id, "TX2");
store.clearCardPending("TX2");
equal("die eigene schon", store.cardPending(), null);

// Bar trägt keine SumUp-ID, und zwei Barverkäufe sind zwei.
const bar1 = store.createSale({ event: EV, items: [{ article: PFAND }], payment: "bar", sumup_tx: "TX1" }),
      bar2 = store.createSale({ event: EV, items: [{ article: PFAND }], payment: "bar" });

equal("bar ohne SumUp-ID", bar1.sumup_tx, null);
check("zwei Barverkäufe", bar1.uuid !== bar2.uuid && bar1.uuid !== sale.uuid);

store.close();
done();
