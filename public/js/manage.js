// Verwaltung an der Kasse, hinter der PIN aus dem Adminbereich.
//
// Gepflegt wird eigentlich im Adminbereich von tv-fridingen.de. Hier steht,
// was man auf dem Fest selbst braucht, auch ohne Netz: Tasten anordnen,
// Preis ändern, "ausverkauft", einen Artikel nachlegen; dazu Storno,
// Kassenbestand, Tagesabschluss und der Wechsel der Veranstaltung.
//
// Die PIN prüft der Hauptprozess, und er prüft sie bei jeder geschützten
// Aktion erneut — die Oberfläche zeigt nur, was ohnehin durchginge.

"use strict";

/* ------------------------------------------------------------- PIN */

async function ensureUnlocked() {
  const state = kasse.state;

  if (!state.pinSet || state.unlocked) {
    return true;
  }

  const pin = await padDialog({
    title: "PIN",
    text: "Für Verwaltung, Storno und Auswertung.",
    mode: "pin",
    confirm: "Entsperren",
    check: async (value) => {
      const result = await window.checkout.unlock(value);

      return result.ok ? null : result.message;
    }
  });

  if (pin === null) {
    return false;
  }

  state.unlocked = true;
  $("open-manage").innerHTML = '<i class="fas fa-lock-open"></i>';

  return true;
}

// Eine geschützte Aktion; ist die Sperre inzwischen wieder zu (fünf Minuten
// ohne Verwaltung), einmal neu fragen.
async function guarded(call) {
  let result = await call();

  if (!result.ok && result.locked) {
    kasse.state.unlocked = false;

    if (!await ensureUnlocked()) {
      return result;
    }

    result = await call();
  }

  if (!result.ok) {
    toast(result.message, "error");
  }

  return result;
}

// Einstellungen: aus dem Menü, mit Strg+, oder aus dem Hinweis "gesperrt".
async function openSettingsGuarded() {
  if (!await ensureUnlocked()) {
    return;
  }

  const result = await window.checkout.openSettings();

  if (result && result.locked) {
    kasse.state.unlocked = false;

    if (await ensureUnlocked()) {
      window.checkout.openSettings();
    }
  }
}

window.checkout.onAskSettings(() => openSettingsGuarded());

/* ------------------------------------------------------------ Menü */

$("open-manage").addEventListener("click", async () => {
  if (!await ensureUnlocked()) {
    return;
  }

  const warning = kasse.state.pinSet ? "" : "Im Adminbereich ist noch keine PIN gesetzt – die Verwaltung ist für jeden offen.";

  const choice = await menuDialog({
    title: "Verwaltung",
    text: warning,
    items: [
      { value: "edit", icon: "fa-pen-to-square", label: "Bearbeiten", hint: "Tasten, Preise, ausverkauft", disabled: !kasse.state.event },
      { value: "sales", icon: "fa-rotate-left", label: "Storno & Belege", hint: "Letzte Verkäufe", disabled: !kasse.state.event },
      { value: "cash", icon: "fa-coins", label: "Kassenbestand", hint: "Wechselgeld, Entnahme, Zählung", disabled: !kasse.state.event },
      { value: "summary", icon: "fa-chart-simple", label: "Auswertung", hint: "Tagesabschluss dieser Kasse", disabled: !kasse.state.event },
      { value: "event", icon: "fa-calendar-days", label: "Veranstaltung", hint: kasse.state.event ? kasse.state.event.name : "keine gewählt" },
      { value: "settings", icon: "fa-cog", label: "Einstellungen", hint: "Drucker, Server, Kopplung" }
    ],
    lock: kasse.state.pinSet
  });

  if (choice === "edit") {
    startEditing();
  }
  else if (choice === "sales") {
    openSales();
  }
  else if (choice === "cash") {
    openCash();
  }
  else if (choice === "summary") {
    openSummary();
  }
  else if (choice === "event") {
    chooseEvent();
  }
  else if (choice === "settings") {
    openSettingsGuarded();
  }
  else if (choice === "lock") {
    await window.checkout.lock();
    kasse.state.unlocked = false;
    $("open-manage").innerHTML = '<i class="fas fa-lock"></i>';
  }
});

// Große Kacheln statt einer Knopfreihe: Das Menü wird mit dem Finger bedient.
function menuDialog({ title, text, items, lock }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");

    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-kasse menu-dialog" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        ${text ? `<p class="warning-text">${escapeHtml(text)}</p>` : ""}
        <div class="menu-grid">
          ${items.map((i) => `<button type="button" class="menu-item" data-value="${i.value}"${i.disabled ? " disabled" : ""}><i class="fas ${i.icon}"></i><b>${escapeHtml(i.label)}</b><small>${escapeHtml(i.hint || "")}</small></button>`).join("")}
        </div>
        <div class="buttons">
          ${lock ? '<button type="button" class="btn-kasse quiet" data-value="lock"><i class="fas fa-lock"></i>Sperren</button>' : ""}
          <button type="button" class="btn-kasse quiet" data-value="">Schließen</button>
        </div>
      </div>`;

    const close = (value) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value || null);
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    };

    backdrop.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-value]");

      if (button && !button.disabled) {
        close(button.dataset.value);
      }
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
  });
}

/* ------------------------------------------------------- Bearbeiten */

let sortables = [];

function startEditing() {
  kasse.editing = true;
  document.body.classList.add("editing");
  $("edit-bar").hidden = false;
  renderProducts();
}

function stopEditing() {
  kasse.editing = false;
  document.body.classList.remove("editing");
  $("edit-bar").hidden = true;
  sortables.forEach((s) => s.destroy());
  sortables = [];
  renderProducts();
  renderBon();
}

$("edit-done").addEventListener("click", stopEditing);

function currentLayout() {
  return [...document.querySelectorAll("#products .block")].map((block) => ({
    uuid: block.dataset.uuid,
    articles: [...block.querySelectorAll(".tile")].map((t) => t.dataset.uuid)
  }));
}

async function saveLayout() {
  const result = await guarded(() => window.checkout.saveLayout(currentLayout()));

  if (!result.ok) {
    loadState();
  }
}

function bindSortables() {
  sortables.forEach((s) => s.destroy());
  sortables = [];

  // Auf dem Touchgerät erst nach kurzem Halten ziehen, damit Scrollen und
  // Antippen weiter gehen.
  const touch = { delay: 180, delayOnTouchOnly: true, touchStartThreshold: 5, animation: 150 };

  sortables.push(Sortable.create($("product-grid"), { ...touch, handle: ".handle", draggable: ".block", onEnd: saveLayout }));

  document.querySelectorAll("#products .tiles").forEach((tiles) => {
    sortables.push(Sortable.create(tiles, {
      ...touch,
      group: "articles",
      draggable: ".tile",
      onEnd: (e) => {
        if (e.from !== e.to || e.oldIndex !== e.newIndex) {
          saveLayout();
        }
      }
    }));
  });
}

async function editArticle(uuid, categoryUuid = null) {
  const a = uuid ? article(uuid) : null,
        buttons = [{ label: "Speichern", value: "save" }];

  if (a) {
    buttons.push({ label: "Löschen", value: "delete", kind: "danger" });
  }

  buttons.push({ label: "Abbrechen", value: null, kind: "quiet" });

  const { value, data } = await formDialog({
    title: a ? "Artikel bearbeiten" : "Artikel anlegen",
    fields: [
      { name: "name", label: "Bezeichnung", type: "text", value: a ? a.name : "" },
      { name: "price", label: "Preis in €", type: "money", value: a ? (a.price / 100).toFixed(2).replace(".", ",") : "", hint: "Helferartikel kosten 0." },
      { name: "category", label: "Kategorie", type: "select", value: a ? a.category : categoryUuid, options: kasse.state.layout.categories.map((c) => ({ value: c.uuid, label: c.name })) },
      { name: "sold_out", label: "Ausverkauft", type: "toggle", value: a ? a.sold_out : false, hint: "Taste bleibt sichtbar, ist aber gesperrt." },
      { name: "deposit", label: "Pfandartikel", type: "toggle", value: a ? a.deposit : false, hint: "Zählt nicht zum Umsatz, kann zurückgegeben werden." }
    ],
    buttons,
    validate: (d) => (!d.name.trim() ? "Bitte gib eine Bezeichnung ein." : (parseCents(d.price) === null ? "Bitte gib einen gültigen Preis ein, z. B. 2,50." : null))
  });

  if (value === "save") {
    await guarded(() => window.checkout.saveArticle({ uuid: a ? a.uuid : null, name: data.name, price: parseCents(data.price), category: data.category, sold_out: data.sold_out, deposit: data.deposit }));
  }
  else if (value === "delete") {
    const sure = await dialog({ title: "Artikel löschen", text: `„${a.name}“ von allen Kassen dieser Veranstaltung löschen? Bereits Verkauftes bleibt in der Auswertung.`, buttons: [{ label: "Löschen", value: true, kind: "danger" }, { label: "Abbrechen", value: false, kind: "quiet" }] });

    if (sure) {
      await guarded(() => window.checkout.deleteArticle(a.uuid));
    }
  }
}

async function editCategory(uuid) {
  const c = uuid ? kasse.state.layout.categories.find((x) => x.uuid === uuid) : null,
        buttons = [{ label: "Speichern", value: "save" }];

  if (c) {
    buttons.push({ label: "Löschen", value: "delete", kind: "danger" });
  }

  buttons.push({ label: "Abbrechen", value: null, kind: "quiet" });

  const { value, data } = await formDialog({
    title: c ? "Kategorie bearbeiten" : "Kategorie anlegen",
    fields: [
      { name: "name", label: "Name", type: "text", value: c ? c.name : "" },
      { name: "color", label: "Farbe", type: "color", value: c ? c.color : COLORS[kasse.state.layout.categories.length % COLORS.length] }
    ],
    buttons,
    validate: (d) => (!d.name.trim() ? "Bitte gib der Kategorie einen Namen." : null)
  });

  if (value === "save") {
    await guarded(() => window.checkout.saveCategory({ uuid: c ? c.uuid : null, name: data.name, color: data.color }));
  }
  else if (value === "delete") {
    const count = kasse.state.layout.articles.filter((a) => a.category === c.uuid).length,
          sure = await dialog({ title: "Kategorie löschen", text: `„${c.name}“${count ? ` mit ihren ${count} Artikeln` : ""} löschen?`, buttons: [{ label: "Löschen", value: true, kind: "danger" }, { label: "Abbrechen", value: false, kind: "quiet" }] });

    if (sure) {
      await guarded(() => window.checkout.deleteCategory(c.uuid));
    }
  }
}

$("products").addEventListener("click", (e) => {
  if (!kasse.editing) {
    return;
  }

  const tile = e.target.closest(".tile"),
        add = e.target.closest(".add-article"),
        cat = e.target.closest(".edit-category");

  if (tile) {
    editArticle(tile.dataset.uuid);
  }
  else if (add) {
    editArticle(null, add.closest(".block").dataset.uuid);
  }
  else if (cat) {
    editCategory(cat.closest(".block").dataset.uuid);
  }
});

$("add-category").addEventListener("click", () => editCategory(null));

/* ------------------------------------------------------ Overlays */

// Eine Seite über der Kasse (Storno, Auswertung). Schließen führt zurück.
function openOverlay(title, body, actions = "") {
  closeOverlay();

  const el = document.createElement("div");

  el.className = "overlay";
  el.id = "overlay";
  el.innerHTML = `
    <div class="overlay-head">
      <h2>${escapeHtml(title)}</h2>
      <span class="spacer"></span>
      ${actions}
      <button type="button" class="btn-kasse quiet" data-close><i class="fas fa-xmark"></i>Schließen</button>
    </div>
    <div class="overlay-body">${body}</div>`;

  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) {
      closeOverlay();
    }
  });

  document.body.appendChild(el);

  return el;
}

function closeOverlay() {
  const el = $("overlay");

  if (el) {
    el.remove();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("overlay") && !document.querySelector(".dialog-backdrop")) {
    closeOverlay();
  }
});

/* ---------------------------------------------- Storno und Belege */

function time(value) {
  return String(value || "").slice(11, 16);
}

async function openSales() {
  const result = await guarded(() => window.checkout.recentSales());

  if (!result.ok) {
    return;
  }

  const rows = result.sales.map((s) => `
    <tr class="${s.cancelled_at ? "cancelled" : ""}">
      <td class="num">${s.number}</td>
      <td>${formatDateTime(s.created_at)}</td>
      <td>${s.items.map((i) => escapeHtml(i.name)).join(", ")}</td>
      <td>${s.payment === "karte" ? "Karte" : "bar"}</td>
      <td class="num">${euro(s.total)}</td>
      <td class="actions-cell">
        ${!s.cancelled_at && s.items.some((i) => i.kind !== "pfandrueckgabe") ? `<button type="button" class="btn-kasse quiet" data-bons="${s.uuid}" data-number="${s.number}"><i class="fas fa-ticket"></i>Bons</button>` : ""}
        <button type="button" class="btn-kasse quiet" data-receipt="${s.uuid}"><i class="fas fa-receipt"></i>Beleg</button>
        ${s.cancelled_at ? `<span class="tag">storniert ${time(s.cancelled_at)}</span>` : `<button type="button" class="btn-kasse danger" data-cancel="${s.uuid}" data-number="${s.number}"><i class="fas fa-rotate-left"></i>Storno</button>`}
      </td>
    </tr>`).join("");

  const el = openOverlay("Storno & Belege", result.sales.length
    ? `<p class="lead-text">Die letzten Verkäufe dieser Kasse. „Bons“ druckt die Bons eines Verkaufs noch einmal, gekennzeichnet als Nachdruck. Ein Storno nimmt den ganzen Verkauf aus der Auswertung; das Geld geht bar zurück, bei Karte über das SumUp-Terminal.</p>
       <table class="table-kasse"><thead><tr><th class="num">Bon</th><th>Zeit</th><th>Artikel</th><th>Zahlung</th><th class="num">Summe</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="lead-text">An dieser Kasse wurde für diese Veranstaltung noch nichts verkauft.</p>');

  el.addEventListener("click", async (e) => {
    const receipt = e.target.closest("[data-receipt]"),
          bons = e.target.closest("[data-bons]"),
          cancel = e.target.closest("[data-cancel]");

    if (bons) {
      const ok = await dialog({
        title: `Bons zu Bon ${bons.dataset.number} nachdrucken`,
        text: "Nur, wenn die Bons nicht herausgekommen sind (Drucker, Absturz). Jeder nachgedruckte Bon trägt „Nachdruck“.",
        buttons: [{ label: "Nachdrucken", value: true }, { label: "Abbrechen", value: false, kind: "quiet" }]
      });

      if (ok) {
        const r = await guarded(() => window.checkout.reprintBons(bons.dataset.bons));

        if (r.ok) {
          toast("Die Bons werden gedruckt.", "ok");
        }
      }
    }
    else if (receipt) {
      const r = await guarded(() => window.checkout.receipt(receipt.dataset.receipt));

      if (r.ok) {
        toast("Der Beleg wird gedruckt.", "ok");
      }
    }
    else if (cancel) {
      const { value, data } = await formDialog({
        title: `Bon ${cancel.dataset.number} stornieren`,
        text: "Der ganze Verkauf wird storniert. Das Geld zurückgeben und die Bons einsammeln.",
        fields: [{ name: "reason", label: "Grund", type: "text", value: "", hint: "z. B. falsch getippt" }],
        buttons: [{ label: "Stornieren", value: true, kind: "danger" }, { label: "Abbrechen", value: false, kind: "quiet" }]
      });

      if (value) {
        const r = await guarded(() => window.checkout.cancelSale(cancel.dataset.cancel, data.reason));

        if (r.ok) {
          toast(`Bon ${r.sale.number} ist storniert.`, "ok");
          openSales();
        }
      }
    }
  });
}

/* --------------------------------------------------- Kassenbestand */

const CASH_KINDS = [
  { value: "anfang", label: "Anfangsbestand", hint: "Wechselgeld zu Beginn" },
  { value: "einlage", label: "Einlage", hint: "Geld nachgelegt" },
  { value: "entnahme", label: "Entnahme", hint: "Scheine abgeschöpft" },
  { value: "zaehlung", label: "Zählung", hint: "Bestand beim Abschluss" }
];

async function openCash() {
  const extra = `<div class="kind-choice">${CASH_KINDS.map((k, i) => `<label><input type="radio" name="cash-kind" value="${k.value}"${i === 0 ? " checked" : ""}><span><b>${k.label}</b><small>${k.hint}</small></span></label>`).join("")}</div>`;

  let kind = "anfang";

  const value = await padDialog({
    title: "Kassenbestand",
    mode: "amount",
    confirm: "Buchen",
    extra,
    check: async (input, backdrop) => {
      const cents = parseCents(input);

      kind = backdrop.querySelector("input[name=cash-kind]:checked").value;

      if (cents === null || (cents === 0 && kind !== "zaehlung")) {
        return "Bitte einen Betrag eingeben.";
      }

      const result = await guarded(() => window.checkout.addCash({ kind, amount: cents, note: "" }));

      return result.ok ? null : result.message;
    }
  });

  if (value !== null) {
    toast(`${CASH_KINDS.find((k) => k.value === kind).label} ${euro(parseCents(value))} gebucht.`, "ok");

    if (kind === "zaehlung") {
      openSummary();
    }
  }
}

/* ------------------------------------------------------ Auswertung */

function dayLabel(day) {
  const [y, m, d] = day.split("-").map(Number),
        date = new Date(y, m - 1, d);

  return date.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

async function openSummary(day = null) {
  const result = await guarded(() => window.checkout.summary(day));

  if (!result.ok) {
    return;
  }

  const s = result.summary,
        days = result.days.length ? result.days : [s.day];

  let group = null;

  const rows = s.articles.map((a) => {
    const header = a.category_name !== group ? `<tr class="group"><td colspan="3">${escapeHtml(a.category_name || "Ohne Kategorie")}</td></tr>` : "";

    group = a.category_name;

    return `${header}<tr><td>${escapeHtml(a.name)}${a.kind === "pfandrueckgabe" ? " <small>Rückgabe</small>" : ""}</td><td class="num">${a.count}</td><td class="num">${euro(a.sum)}</td></tr>`;
  }).join("");

  const difference = s.cash.difference;

  const body = `
    <div class="day-chips">${days.map((d) => `<button type="button" class="chip${d === s.day ? " active" : ""}" data-day="${d}">${dayLabel(d)}</button>`).join("")}</div>
    <div class="summary-grid">
      <div class="panel-kasse">
        <h3>Verkauft</h3>
        ${s.articles.length ? `<table class="table-kasse"><thead><tr><th>Artikel</th><th class="num">Anzahl</th><th class="num">Summe</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="lead-text">An diesem Tag nichts verkauft.</p>'}
      </div>
      <div class="panel-kasse">
        <h3>Umsatz</h3>
        <dl class="facts">
          <dt>Umsatz</dt><dd>${euro(s.revenue)}</dd>
          <dt>davon bar</dt><dd>${euro(s.cashTotal)}</dd>
          <dt>davon Karte</dt><dd>${euro(s.cardTotal)}</dd>
          <dt>Pfand ausgegeben</dt><dd>${euro(s.deposit)}</dd>
          <dt>Pfand zurück</dt><dd>${euro(s.depositReturned)}</dd>
          <dt>Verkäufe</dt><dd>${s.sales}</dd>
          <dt>Stornos</dt><dd>${s.cancelled.count}${s.cancelled.count ? ` (${euro(s.cancelled.sum)})` : ""}</dd>
        </dl>
        <h3>Bargeld</h3>
        <dl class="facts">
          <dt>Anfangsbestand</dt><dd>${euro(s.cash.start)}</dd>
          <dt>Einlagen</dt><dd>${euro(s.cash.deposits)}</dd>
          <dt>Entnahmen</dt><dd>${euro(-s.cash.withdrawals)}</dd>
          <dt>Bar eingenommen</dt><dd>${euro(s.cashTotal)}</dd>
          <dt>Soll-Bestand</dt><dd class="big">${euro(s.cash.expected)}</dd>
          ${s.cash.counted !== null ? `<dt>Gezählt ${time(s.cash.countedAt)}</dt><dd>${euro(s.cash.counted)}</dd><dt>Differenz</dt><dd class="${difference === 0 ? "ok" : "off"}">${euro(difference)}</dd>` : ""}
        </dl>
        <p class="hint-text">Nur diese Kasse. Die Auswertung über alle Kassen steht im Adminbereich.</p>
      </div>
    </div>`;

  const el = openOverlay(`Auswertung ${kasse.state.event.name}`, body, '<button type="button" class="btn-kasse quiet" data-print><i class="fas fa-print"></i>Abschluss drucken</button><button type="button" class="btn-kasse quiet" data-count><i class="fas fa-coins"></i>Zählung</button>');

  el.addEventListener("click", async (e) => {
    const chip = e.target.closest("[data-day]");

    if (chip) {
      openSummary(chip.dataset.day);
    }
    else if (e.target.closest("[data-print]")) {
      const r = await guarded(() => window.checkout.printSummary(s.day));

      if (r.ok) {
        toast("Der Tagesabschluss wird gedruckt.", "ok");
      }
    }
    else if (e.target.closest("[data-count]")) {
      openCash();
    }
  });
}

/* ------------------------------------------------- Veranstaltung */

async function chooseEvent() {
  const events = kasse.state.events;

  if (!events.length) {
    toast("Es gibt noch keine Veranstaltung. Sie wird im Adminbereich angelegt.", "info");

    return;
  }

  const period = (e) => (e.starts_on ? ` (${formatDateTime(e.starts_on + " 00:00").slice(0, 10)})` : "");

  const choice = await dialog({
    title: "Veranstaltung",
    text: "An welcher Veranstaltung kassiert diese Kasse?",
    buttons: [...events.map((e) => ({ label: `${e.name}${period(e)}`, value: e.uuid, kind: kasse.state.event && e.uuid === kasse.state.event.uuid ? "" : "quiet" })), { label: "Abbrechen", value: null, kind: "quiet" }]
  });

  if (choice && (!kasse.state.event || choice !== kasse.state.event.uuid)) {
    if (kasse.bon.length) {
      clearBon();
    }

    await guarded(() => window.checkout.setEvent(choice));
  }
}
