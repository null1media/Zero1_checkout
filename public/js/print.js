// Druckvorlage: füllt print.html mit einem Zettel.
//
// Aufgerufen von utils/printer.js über executeJavaScript:
//
//   renderPrint({ type: "bon" | "receipt" | "summary" | "test", ... })
//
// Rückgabe: Höhe des Zettels in Pixeln, sobald Schrift und Logo geladen sind
// — daraus berechnet der Drucker die Seitenlänge.

"use strict";

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

function euro(cents) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format((Number(cents) || 0) / 100);
}

// "2026-07-11 18:03:12" -> "11.07.2026 18:03"
function when(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);

  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : String(value || "");
}

function day(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);

  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value || "");
}

function head(doc) {
  return `
    <div class="head">
      <img src="img/tv-fridingen.png" alt="">
      <div>
        <div class="event">${esc(doc.event || "")}</div>
        <div class="small">${esc(doc.organizer || "")}</div>
      </div>
    </div>`;
}

// Ein Stück, ein Zettel — wie im alten Programm: Die Ausgabe nimmt den Bon
// entgegen und gibt dafür genau diesen Artikel heraus.
function bon(doc) {
  return `
    ${head(doc)}
    <div class="bon-article">${esc(doc.name)}</div>
    <div class="bon-price">${esc(euro(doc.price))}</div>
    ${doc.deposit ? '<span class="bon-tag">Pfand</span>' : ""}
    <div class="meta">Bon ${esc(doc.number)} · ${esc(doc.index)}/${esc(doc.count)} · ${esc(doc.device || "")} · ${esc(when(doc.created_at))}</div>
    ${doc.footer ? `<div class="footer">${esc(doc.footer)}</div>` : ""}`;
}

// Sammelbeleg auf Wunsch, zum Beispiel als Bewirtungsbeleg.
function receipt(doc) {
  const lines = new Map();

  for (const item of doc.items) {
    const key = `${item.name}|${item.price}|${item.kind}`,
          line = lines.get(key) || { ...item, count: 0 };

    line.count++;
    lines.set(key, line);
  }

  const rows = [...lines.values()].map((l) => `
    <tr>
      <td>${l.count} × ${esc(l.name)}${l.kind === "pfandrueckgabe" ? " (Rückgabe)" : ""}</td>
      <td class="num">${esc(euro(l.price * l.count))}</td>
    </tr>`).join("");

  const payment = doc.payment === "karte"
    ? `<tr><td>Kartenzahlung</td><td class="num">${esc(euro(doc.total))}</td></tr>`
    : (doc.given !== null && doc.given !== undefined
      ? `<tr><td>Bar gegeben</td><td class="num">${esc(euro(doc.given))}</td></tr><tr><td>Zurück</td><td class="num">${esc(euro(doc.given - doc.total))}</td></tr>`
      : (doc.total < 0
        ? `<tr><td>Bar ausgezahlt</td><td class="num">${esc(euro(-doc.total))}</td></tr>`
        : `<tr><td>Bar</td><td class="num">${esc(euro(doc.total))}</td></tr>`));

  return `
    ${head(doc)}
    <div class="title">Beleg</div>
    ${doc.cancelled_at ? '<div class="cancelled">Storniert</div>' : ""}
    <table>
      ${rows}
      <tr class="sum"><td>Summe</td><td class="num">${esc(euro(doc.total))}</td></tr>
      ${payment}
    </table>
    <div class="meta">
      ${esc(doc.organizer || "")}${doc.address ? `<br>${esc(doc.address)}` : ""}${doc.tax_number ? `<br>St.-Nr. ${esc(doc.tax_number)}` : ""}
      <br>Bon ${esc(doc.number)} · ${esc(doc.device || "")} · ${esc(when(doc.created_at))}
    </div>
    ${doc.footer ? `<div class="footer">${esc(doc.footer)}</div>` : ""}`;
}

// Tagesabschluss dieser Kasse.
function summary(doc) {
  const s = doc.summary;
  let group = null;

  const rows = s.articles.map((a) => {
    const header = a.category_name !== group ? `<tr class="group"><td colspan="2">${esc(a.category_name || "Ohne Kategorie")}</td></tr>` : "";

    group = a.category_name;

    return `${header}<tr><td>${a.count} × ${esc(a.name)}${a.kind === "pfandrueckgabe" ? " (Rückgabe)" : ""}</td><td class="num">${esc(euro(a.sum))}</td></tr>`;
  }).join("");

  return `
    ${head(doc)}
    <div class="title">Tagesabschluss</div>
    <div class="meta" style="margin-top:0;border:0">${esc(doc.device || "")} · Geschäftstag ${esc(day(s.day))}<br>gedruckt ${esc(when(doc.printed_at))}</div>
    <table>
      ${rows}
      <tr class="sum"><td>Umsatz</td><td class="num">${esc(euro(s.revenue))}</td></tr>
      <tr><td>Pfand ausgegeben</td><td class="num">${esc(euro(s.deposit))}</td></tr>
      <tr><td>Pfand zurückgegeben</td><td class="num">${esc(euro(s.depositReturned))}</td></tr>
      <tr><td>davon bar</td><td class="num">${esc(euro(s.cashTotal))}</td></tr>
      <tr><td>davon Karte</td><td class="num">${esc(euro(s.cardTotal))}</td></tr>
      <tr><td>Verkäufe</td><td class="num">${s.sales}</td></tr>
      <tr><td>Stornos</td><td class="num">${s.cancelled.count} (${esc(euro(s.cancelled.sum))})</td></tr>
      <tr class="group"><td colspan="2">Bargeld</td></tr>
      <tr><td>Anfangsbestand</td><td class="num">${esc(euro(s.cash.start))}</td></tr>
      <tr><td>Einlagen</td><td class="num">${esc(euro(s.cash.deposits))}</td></tr>
      <tr><td>Entnahmen</td><td class="num">${esc(euro(-s.cash.withdrawals))}</td></tr>
      <tr><td>Bar eingenommen</td><td class="num">${esc(euro(s.cashTotal))}</td></tr>
      <tr class="sum"><td>Soll-Bestand</td><td class="num">${esc(euro(s.cash.expected))}</td></tr>
      ${s.cash.counted !== null ? `
        <tr><td>Gezählt (${esc(when(s.cash.countedAt).slice(11))})</td><td class="num">${esc(euro(s.cash.counted))}</td></tr>
        <tr><td>Differenz</td><td class="num">${esc(euro(s.cash.difference))}</td></tr>` : ""}
    </table>
    <div class="signature">Unterschrift</div>`;
}

function test(doc) {
  return `
    ${head(doc)}
    <div class="bon-article">Testbon</div>
    <div class="bon-price">Wenn das hier steht, druckt die Kasse.</div>
    <div class="meta">${esc(doc.device || "")} · ${esc(when(doc.printed_at))}</div>`;
}

window.renderPrint = async function(doc) {
  const paper = document.getElementById("paper"),
        render = { bon, receipt, summary, test }[doc.type];

  paper.innerHTML = render ? render(doc) : "";

  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));

  // Die Unterkante des Inhalts, nicht die Höhe des Dokuments: Die ist nie
  // kleiner als das (unsichtbare) Fenster und brächte leeres Papier.
  return Math.ceil(paper.getBoundingClientRect().bottom);
};
