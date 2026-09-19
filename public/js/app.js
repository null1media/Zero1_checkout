// Die Kasse.
//
// Im Gerüst: Kopfleiste mit Vereinsname und Kassenname, Abgleichsanzeige,
// Hinweis bei gesperrter Kasse, Fußzeile. Die Arbeitsfläche folgt mit der
// Fachlichkeit (Artikel, Veranstaltungen, Verkauf, Bons).

"use strict";

function renderStatus(status) {
  const pill = $("sync-pill");

  pill.dataset.state = status.state;
  $("sync-text").textContent = SYNC_TEXT[status.state] || status.state;
  $("sync-pending").hidden = !status.pending;
  $("sync-pending").textContent = status.pending || "";
  pill.title = [status.message, "Jetzt abgleichen (F9)"].filter(Boolean).join("\n");
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

  if (info.settings && info.settings.club_name) {
    $("club").textContent = info.settings.club_name;
  }

  if (info.device) {
    $("device").hidden = false;
    $("device").textContent = info.device.name;
  }

  $("footer-version").textContent = `Zero1 checkout ${info.version}${info.packaged ? "" : " (Quelltext)"}`;
  renderStatus(info.sync);
}

$("sync-pill").addEventListener("click", async () => {
  const result = await window.checkout.sync();

  if (!result.ok) {
    toast(result.message || "Der Abgleich ist fehlgeschlagen.", "info");
  }
});

$("open-settings").addEventListener("click", () => window.checkout.openSettings());
$("banner-action").addEventListener("click", () => window.checkout.openSettings());

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === ",") {
    e.preventDefault();
    window.checkout.openSettings();
  }
});

window.checkout.onStatus(renderStatus);
window.checkout.onNotices((notices) => {
  for (const n of notices.filter((x) => x.level === "error")) {
    toast(`Vom Server abgelehnt: ${n.message}`, "error");
  }
});

// Die Zeitangabe "vor 3 Minuten" altert auch ohne Abgleich.
setInterval(async () => renderStatus((await window.checkout.info()).sync), 30000);

load();
