// Die Kasse: Artikel antippen, Bon, Gegeben/Rückgeld, bar oder Karte.
//
// Aufbau wie im alten Programm, weil es sich bewährt hat: alle Kategorien
// gleichzeitig als Blöcke (kein Umschalten zwischen Reitern), rechts Bon,
// Summe und Ziffernblock für "Gegeben". Neu: Pfandrückgabe, Kartenzahlung,
// Beleg auf Wunsch, und dass die Kasse ohne Netz weiterläuft.
//
// Verwaltung, Bearbeiten und alles hinter der PIN steht in manage.js.

"use strict";

const kasse = {
  state: null,
  // Ein Eintrag je Stück, in der Reihenfolge des Antippens.
  bon: [],
  // Eingabe "Gegeben" wie am Ziffernblock getippt, z. B. "20" oder "12,5".
  given: "",
  busy: false,
  editing: false
};

/* ------------------------------------------------------------ Laden */

async function loadState() {
  const result = await window.checkout.state();

  if (!result.ok) {
    toast(result.message, "error");

    return;
  }

  kasse.state = result;

  // Artikel, die es nicht mehr gibt (gelöscht, andere Veranstaltung),
  // fallen vom offenen Bon.
  const known = new Set(result.layout.articles.map((a) => a.uuid));

  kasse.bon = kasse.bon.filter((line) => known.has(line.article));

  $("event-name").textContent = result.event ? result.event.name : "Kasse";
  $("club").textContent = result.organizer ? result.organizer.name : (result.clubName || "");
  $("deposit-return").hidden = !(result.event && result.event.deposit_return);
  $("open-manage").innerHTML = `<i class="fas ${result.unlocked || !result.pinSet ? "fa-lock-open" : "fa-lock"}"></i>`;

  renderProducts();
  renderBon();
}

function article(uuid) {
  return kasse.state.layout.articles.find((a) => a.uuid === uuid);
}

/* --------------------------------------------------------- Artikel */

function renderProducts() {
  const box = $("product-grid"),
        { event, layout } = kasse.state;

  box.innerHTML = "";

  if (!event) {
    box.innerHTML = `<div class="empty-state"><img src="img/tv-fridingen.png" alt=""><h2>Keine Veranstaltung</h2><p>Im Adminbereich unter Kasse eine Veranstaltung anlegen. Nach dem nächsten Abgleich ist sie hier.</p></div>`;

    return;
  }

  if (!layout.categories.length && !kasse.editing) {
    box.innerHTML = `<div class="empty-state"><img src="img/tv-fridingen.png" alt=""><h2>Noch keine Artikel</h2><p>Artikel im Adminbereich anlegen oder hier über das Schloss oben rechts → Bearbeiten.</p></div>`;

    return;
  }

  for (const category of layout.categories) {
    const block = document.createElement("section"),
          tiles = document.createElement("div");

    block.className = "block";
    block.dataset.uuid = category.uuid;
    block.style.setProperty("--cat", category.color);
    block.innerHTML = `<header><span class="handle"><i class="fas fa-grip-vertical"></i></span><span class="name">${escapeHtml(category.name)}</span><button type="button" class="edit-category" title="Kategorie bearbeiten"><i class="fas fa-pen"></i></button></header>`;
    tiles.className = "tiles";

    for (const a of layout.articles.filter((x) => x.category === category.uuid)) {
      const tile = document.createElement("button");

      tile.type = "button";
      tile.className = `tile${a.sold_out ? " sold-out" : ""}${a.deposit ? " deposit" : ""}`;
      tile.dataset.uuid = a.uuid;
      tile.innerHTML = `<span class="name">${escapeHtml(a.name)}</span><span class="price">${euro(a.price)}</span>${a.sold_out ? '<span class="badge-kasse">ausverkauft</span>' : (a.deposit ? '<span class="badge-kasse">Pfand</span>' : "")}<span class="count" hidden></span>`;
      tiles.appendChild(tile);
    }

    block.appendChild(tiles);

    const add = document.createElement("button");

    add.type = "button";
    add.className = "add-article";
    add.innerHTML = '<i class="fas fa-plus"></i> Artikel';
    block.appendChild(add);

    box.appendChild(block);
  }

  if (kasse.editing) {
    bindSortables();
  }
}

// Wie oft ein Artikel schon auf dem offenen Bon steht: als Zahl auf der Taste.
function renderCounts() {
  const counts = {};

  for (const line of kasse.bon) {
    if (line.kind === "verkauf") {
      counts[line.article] = (counts[line.article] || 0) + 1;
    }
  }

  document.querySelectorAll("#products .tile").forEach((tile) => {
    const badge = tile.querySelector(".count"),
          n = counts[tile.dataset.uuid] || 0;

    badge.hidden = !n;
    badge.textContent = n;
  });
}

$("products").addEventListener("click", (e) => {
  if (kasse.editing) {
    return;
  }

  const tile = e.target.closest(".tile");

  if (!tile || tile.classList.contains("sold-out")) {
    return;
  }

  kasse.bon.push({ article: tile.dataset.uuid, kind: "verkauf" });
  tile.classList.remove("tapped");
  void tile.offsetWidth;
  tile.classList.add("tapped");
  renderBon();
});

/* -------------------------------------------------------------- Bon */

function bonLines() {
  const lines = new Map();

  for (const entry of kasse.bon) {
    const a = article(entry.article);

    if (!a) {
      continue;
    }

    const key = `${entry.kind}:${entry.article}`,
          line = lines.get(key) || { key, article: a, kind: entry.kind, count: 0 };

    line.count++;
    lines.set(key, line);
  }

  return [...lines.values()];
}

function total() {
  return kasse.bon.reduce((sum, entry) => {
    const a = article(entry.article);

    return sum + (a ? (entry.kind === "pfandrueckgabe" ? -a.price : a.price) : 0);
  }, 0);
}

function renderBon() {
  const list = $("bon"),
        lines = bonLines(),
        sum = total(),
        given = parseCents(kasse.given);

  list.innerHTML = lines.map((l) => {
    const price = l.kind === "pfandrueckgabe" ? -l.article.price : l.article.price;

    return `
      <li data-key="${escapeHtml(l.key)}" class="${l.kind === "pfandrueckgabe" ? "return" : ""}">
        <span class="qty">${l.count}×</span>
        <span class="name">${escapeHtml(l.article.name)}${l.kind === "pfandrueckgabe" ? " <small>Rückgabe</small>" : ""}</span>
        <span class="sum">${euro(price * l.count)}</span>
        <button type="button" class="minus" title="Eins weniger"><i class="fas fa-minus"></i></button>
      </li>`;
  }).join("");

  if (!lines.length) {
    list.innerHTML = '<li class="empty">Artikel antippen, um sie auf den Bon zu nehmen.</li>';
  }

  list.scrollTop = list.scrollHeight;

  $("total").textContent = euro(sum);
  $("total").classList.toggle("negative", sum < 0);
  $("given").textContent = kasse.given ? euro(given) : "–";
  $("change").textContent = kasse.given && given !== null && given >= sum ? euro(given - sum) : "–";
  $("change").classList.toggle("short", Boolean(kasse.given) && given !== null && given < sum);
  $("pay-cash-label").textContent = sum < 0 ? `${euro(-sum)} auszahlen` : "Bar";
  $("pay-card").disabled = sum <= 0;
  $("pay-cash").disabled = !kasse.bon.length;
  $("last-sale").hidden = Boolean(kasse.bon.length) || !kasse.state || !kasse.state.lastSale;

  renderCounts();
}

$("bon").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-key]");

  if (!li) {
    return;
  }

  const [kind, uuid] = li.dataset.key.split(":"),
        index = kasse.bon.map((x) => `${x.kind}:${x.article}`).lastIndexOf(`${kind}:${uuid}`);

  if (index >= 0) {
    kasse.bon.splice(index, 1);
  }

  renderBon();
});

function clearBon() {
  kasse.bon = [];
  kasse.given = "";
  renderBon();
}

$("clear").addEventListener("click", clearBon);
$("clear-given").addEventListener("click", () => {
  kasse.given = "";
  renderBon();
});

/* ----------------------------------------------------- Ziffernblock */

function keyInput(key) {
  if (key === ",") {
    if (!kasse.given.includes(",")) {
      kasse.given = (kasse.given || "0") + ",";
    }
  }
  else if (!/,\d\d$/.test(kasse.given) && kasse.given.replace(",", "").length < 6) {
    kasse.given += key;
  }

  renderBon();
}

$("keypad").addEventListener("click", (e) => {
  const button = e.target.closest("button");

  if (!button) {
    return;
  }

  if (button.dataset.quick) {
    kasse.given = String(Number(button.dataset.quick) / 100);
    renderBon();

    return;
  }

  keyInput(button.dataset.key);
});

/* ---------------------------------------------------------- Pfand */

$("deposit-return").addEventListener("click", async () => {
  const deposits = kasse.state.layout.articles.filter((a) => a.deposit);

  if (!deposits.length) {
    toast("Für diese Veranstaltung ist kein Pfandartikel angelegt.", "info");

    return;
  }

  const choice = await dialog({
    title: "Pfandrückgabe",
    text: "Was wird zurückgegeben? Jedes Antippen nimmt ein Stück als Rückgabe auf den Bon.",
    buttons: [...deposits.map((a) => ({ label: `${a.name} (${euro(a.price)})`, value: a.uuid })), { label: "Fertig", value: null, kind: "quiet" }]
  });

  if (choice) {
    kasse.bon.push({ article: choice, kind: "pfandrueckgabe" });
    renderBon();
    $("deposit-return").click();
  }
});

/* -------------------------------------------------------- Kassieren */

async function sell(payment, extra = {}) {
  if (kasse.busy || !kasse.bon.length) {
    return;
  }

  const sum = total(),
        given = payment === "bar" && kasse.given ? parseCents(kasse.given) : null;

  if (payment === "bar" && kasse.given && (given === null || given < sum)) {
    toast("Der gegebene Betrag reicht nicht.", "error");

    return;
  }

  kasse.busy = true;

  try {
    const result = await window.checkout.sell({ items: kasse.bon, payment, given, ...extra });

    if (!result.ok) {
      toast(result.message, "error");

      return;
    }

    kasse.state.lastSale = result.sale;
    kasse.bon = [];
    kasse.given = "";
    renderLastSale();
    renderBon();
  }
  finally {
    kasse.busy = false;
  }
}

$("pay-cash").addEventListener("click", () => sell("bar"));

/* ----------------------------------------------------- Kartenzahlung */

// Von Hand: Der Betrag wird ins Terminal getippt, gebucht wird erst nach
// "Zahlung erfolgreich". Ohne zugewiesenes Terminal, ohne Netz, oder wenn
// SumUp nicht mitspielt.
async function payByHand(sum) {
  const ok = await dialog({
    title: "Kartenzahlung von Hand",
    text: "Betrag am SumUp-Terminal eingeben und die Karte vorhalten lassen. Erst bestätigen, wenn das Terminal „Zahlung erfolgreich“ zeigt.",
    highlight: euro(sum),
    buttons: [{ label: "Bezahlt", value: true }, { label: "Abbrechen", value: false, kind: "quiet" }]
  });

  if (ok) {
    sell("karte");
  }
}

/*
  Der Zahlungsdialog: Betrag, ein Stand, der sich ändert, und Knöpfe, die
  je nach Stand wechseln. choose() wartet auf einen Knopf; offer() zeigt
  Knöpfe, ohne zu warten (Abbrechen, während das Terminal arbeitet).
*/
function cardBox(sum, terminal) {
  const backdrop = document.createElement("div");

  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-kasse card-dialog" role="dialog" aria-modal="true">
      <h3>Kartenzahlung</h3>
      <p class="terminal-name"><i class="fas fa-credit-card"></i> ${escapeHtml(terminal)}</p>
      <div class="highlight">${euro(sum)}</div>
      <div class="card-state"><span class="spinner"></span><span class="text"></span></div>
      <div class="buttons"></div>
    </div>`;

  document.body.appendChild(backdrop);

  const state = backdrop.querySelector(".card-state"),
        buttons = backdrop.querySelector(".buttons");

  let pick = null;

  buttons.addEventListener("click", (e) => {
    const button = e.target.closest("button[data-value]");

    if (button && pick) {
      pick(button.dataset.value);
    }
  });

  return {
    status(text, kind = "wait") {
      state.dataset.kind = kind;
      state.querySelector(".text").textContent = text;
    },
    offer(list, onPick) {
      buttons.innerHTML = list.map((b) => `<button type="button" class="btn-kasse ${b.kind || ""}" data-value="${b.value}">${escapeHtml(b.label)}</button>`).join("");
      pick = onPick;
    },
    choose(list) {
      return new Promise((resolve) => this.offer(list, resolve));
    },
    close() {
      backdrop.remove();
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wie lange auf das Terminal gewartet wird, bevor die Kasse fragt, ob
// weiter gewartet werden soll.
const CARD_PATIENCE_MS = 150000;

async function payByTerminal(sum, terminal) {
  const box = cardBox(sum, terminal.name),
        manual = { label: "Von Hand", value: "manual", kind: "quiet" },
        cancel = { label: "Abbrechen", value: "cancel", kind: "quiet" },
        retry = { label: "Erneut senden", value: "retry" };

  const finish = async (id) => {
    box.status("Bezahlt.", "ok");
    await sell("karte", { sumup_tx: id });
    box.close();
  };

  for (;;) {
    box.offer([], null);
    box.status(`Betrag wird an ${terminal.name} geschickt…`);

    const started = (await window.checkout.cardStart({ amount: sum, description: `${kasse.state.event ? kasse.state.event.name : "Kasse"}` })).result;

    if (!started.ok) {
      // Nichts ist beim Terminal angekommen: Von Hand ist ungefährlich.
      box.status(started.message, "error");

      const choice = await box.choose(started.reason === "busy" ? [retry, cancel] : [retry, manual, cancel]);

      if (choice === "retry") {
        continue;
      }

      box.close();

      if (choice === "manual") {
        payByHand(sum);
      }

      return;
    }

    const id = started.payment.id,
          since = Date.now();

    let cancelling = false,
        waitMore = false,
        payment = started.payment;

    box.status("Bitte die Karte am Terminal vorhalten lassen.");
    box.offer([cancel], () => {
      cancelling = true;
    });

    // Nachfragen, bis ein Ergebnis da ist. Kein "Von Hand", solange die
    // Zahlung am Terminal noch laufen könnte — sonst zahlte der Gast doppelt.
    while (payment.status === "pending") {
      if (cancelling) {
        box.offer([], null);
        box.status("Wird abgebrochen…");

        const cancelled = (await window.checkout.cardCancel(id)).result;

        if (cancelled.ok) {
          payment = cancelled.payment;
          break;
        }

        box.status(`${cancelled.message} Abbruch nicht bestätigt – bitte am Terminal nachsehen.`, "error");
        cancelling = false;
        box.offer([cancel], () => {
          cancelling = true;
        });
      }

      await sleep(1000);

      const polled = (await window.checkout.cardStatus(id)).result;

      if (polled.ok) {
        payment = polled.payment;
      }
      else if (polled.reason === "netz") {
        box.status("Verbindung zum Vereinsserver gestört – es wird weiter nachgefragt. Das Terminal zeigt das Ergebnis auch selbst.", "error");
      }

      if (payment.status === "pending" && !waitMore && Date.now() - since > CARD_PATIENCE_MS) {
        box.status("Vom Terminal kommt keine Rückmeldung. Zeigt es „Zahlung erfolgreich“?", "error");
        waitMore = true;
        box.offer([{ label: "Weiter warten", value: "wait" }, cancel], (value) => {
          if (value === "cancel") {
            cancelling = true;
          }
          else {
            box.status("Bitte die Karte am Terminal vorhalten lassen.");
            box.offer([cancel], () => {
              cancelling = true;
            });
          }
        });
      }
    }

    if (payment.status === "successful") {
      await finish(id);

      return;
    }

    // Abgelehnt oder abgebrochen: Am Terminal läuft nichts mehr.
    box.status(payment.message || "Die Zahlung ist nicht zustande gekommen.", "error");

    const choice = await box.choose([retry, { label: "Bar", value: "cash", kind: "quiet" }, manual, cancel]);

    if (choice === "retry") {
      continue;
    }

    box.close();

    if (choice === "manual") {
      payByHand(sum);
    }
    else if (choice === "cash") {
      toast("Bitte bar kassieren: Gegeben eintippen und „Bar“.", "info");
    }

    return;
  }
}

$("pay-card").addEventListener("click", async () => {
  const sum = total();

  if (!kasse.bon.length || sum <= 0 || kasse.busy) {
    return;
  }

  // Ohne zugewiesenes Terminal oder unter einem Euro (SumUp nimmt das nicht
  // an): von Hand.
  if (kasse.state.terminal && sum >= 100) {
    payByTerminal(sum, kasse.state.terminal);
  }
  else {
    payByHand(sum);
  }
});

// Nach dem Verkauf: was zurückzugeben ist, groß, bis der nächste Gast kommt.
function renderLastSale() {
  const box = $("last-sale"),
        sale = kasse.state && kasse.state.lastSale;

  if (!sale) {
    box.hidden = true;

    return;
  }

  const change = sale.payment === "bar" && sale.given !== null ? sale.given - sale.total : null;

  box.innerHTML = `
    <div class="info">
      <span>Bon ${sale.number} · ${sale.payment === "karte" ? "Karte" : "bar"} · ${euro(sale.total)}</span>
      ${change !== null ? `<strong>Zurück ${euro(change)}</strong>` : (sale.total < 0 ? `<strong>Ausgezahlt ${euro(-sale.total)}</strong>` : "")}
    </div>
    <button type="button" id="print-receipt" class="btn-kasse quiet"><i class="fas fa-receipt"></i>Beleg</button>`;
  box.hidden = Boolean(kasse.bon.length);
}

$("last-sale").addEventListener("click", async (e) => {
  if (!e.target.closest("#print-receipt")) {
    return;
  }

  const result = await window.checkout.receipt(kasse.state.lastSale.uuid);

  toast(result.ok ? "Der Beleg wird gedruckt." : result.message, result.ok ? "ok" : "error");
});

/* ------------------------------------------------------- Tastatur */

document.addEventListener("keydown", (e) => {
  if (document.querySelector(".dialog-backdrop, .overlay:not([hidden])") || kasse.editing || e.target.matches("input, select, textarea")) {
    return;
  }

  if (/^\d$/.test(e.key) || e.key === ",") {
    keyInput(e.key);
  }
  else if (e.key === "Backspace") {
    kasse.given = kasse.given.slice(0, -1);
    renderBon();
  }
  else if (e.key === "Enter") {
    sell("bar");
  }
  else if (e.key === "Delete") {
    clearBon();
  }
  else if (e.ctrlKey && e.key === ",") {
    openSettingsGuarded();
  }
  else {
    return;
  }

  e.preventDefault();
});

/* ---------------------------------------------------- Abgleich */

function renderStatus(status) {
  const pill = $("sync-pill");

  pill.dataset.state = status.state;
  $("sync-text").textContent = SYNC_TEXT[status.state] || status.state;
  $("sync-pending").hidden = !status.pending;
  $("sync-pending").textContent = status.pending || "";
  pill.title = [status.message, status.pending ? `${status.pending} Änderung(en) noch nicht beim Verein` : "", "Jetzt abgleichen (F9)"].filter(Boolean).join("\n");
  $("footer-sync").textContent = `Letzter Abgleich: ${formatRelative(status.lastSyncAt)}`;

  if (status.device) {
    $("device").hidden = false;
    $("device").textContent = status.device.name;
  }

  // Gesperrt ist der einzige Zustand, in dem die Kasse selbst nichts mehr
  // ausrichten kann — dann steht es oben, nicht nur in der Statusanzeige.
  $("banner").hidden = status.state !== "gesperrt";
  $("banner-text").textContent = status.message || "";
}

async function load() {
  const info = await window.checkout.info();

  if (info.device) {
    $("device").hidden = false;
    $("device").textContent = info.device.name;
  }

  $("footer-version").textContent = `Zero1 checkout ${info.version}${info.packaged ? "" : " (Quelltext)"}`;
  renderStatus(info.sync);
  await loadState();
  renderLastSale();
}

$("sync-pill").addEventListener("click", async () => {
  const result = await window.checkout.sync();

  if (!result.ok) {
    toast(result.message || "Der Abgleich ist fehlgeschlagen.", "info");
  }
});

$("banner-action").addEventListener("click", () => openSettingsGuarded());

window.checkout.onStatus(renderStatus);
window.checkout.onData(() => loadState());
window.checkout.onNotices((notices) => {
  for (const n of notices) {
    toast(n.level === "error" ? `Nicht übernommen: ${n.message}` : n.message, n.level === "error" ? "error" : "info", 9000);
  }
});

// Die Zeitangabe "vor 3 Minuten" altert auch ohne Abgleich.
setInterval(async () => renderStatus((await window.checkout.info()).sync), 30000);

load();
