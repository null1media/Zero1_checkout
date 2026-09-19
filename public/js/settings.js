// Einstellungen.

"use strict";

function showMessage(id, text, level) {
  const el = $(id);

  el.hidden = !text;
  el.textContent = text || "";
  el.className = `message ${level || ""}`;
}

function renderStatus(status) {
  $("status").textContent = [SYNC_TEXT[status.state] || status.state, status.message].filter(Boolean).join(" — ");
  $("last-sync").textContent = formatRelative(status.lastSyncAt);
  $("pending").textContent = status.pending ? `${status.pending} Änderung(en)` : "nichts";

  if (status.device) {
    $("device").textContent = status.device.name;
  }
}

async function load() {
  const info = await window.checkout.info();

  $("device").textContent = info.device ? info.device.name : "nicht gekoppelt";
  $("club").textContent = (info.settings && info.settings.club_name) || "–";
  $("server").textContent = info.server;
  $("version").textContent = `${info.version}${info.packaged ? "" : " (Quelltext)"}`;
  $("schema").textContent = `Schema ${info.schema}`;
  $("serial").textContent = info.serial ? "hinterlegt" : (info.packaged ? "fehlt" : "im Quelltextbetrieb nicht nötig");
  $("update-server").textContent = info.updateServer || "–";
  $("data-dir").textContent = info.dataDir;
  renderStatus(info.sync);
}

$("sync-now").addEventListener("click", async (e) => {
  const button = e.currentTarget;

  button.disabled = true;
  showMessage("sync-message", "");

  const result = await window.checkout.sync();

  button.disabled = false;
  showMessage("sync-message", result.ok ? "Abgeglichen." : result.message, result.ok ? "ok" : "error");
  load();
});

$("code").addEventListener("input", (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

  e.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
});

$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const code = $("code").value.replace(/[^A-Z0-9]/g, "");

  if (code.length !== 8) {
    showMessage("pair-message", "Der Kopplungscode hat acht Zeichen.", "error");

    return;
  }

  const button = e.target.querySelector("button");

  button.disabled = true;
  showMessage("pair-message", "Wird gekoppelt…");

  const result = await window.checkout.pair(code);

  button.disabled = false;

  if (result.ok) {
    $("code").value = "";
    showMessage("pair-message", `Gekoppelt als "${result.device.name}".${result.synced ? "" : " Der Abgleich folgt, sobald der Vereinsserver erreichbar ist."}`, "ok");
  }
  else {
    showMessage("pair-message", result.message, "error");
  }

  load();
});

$("open-data").addEventListener("click", () => window.checkout.openPath("data"));
$("open-logs").addEventListener("click", () => window.checkout.openPath("logs"));

window.checkout.onStatus(renderStatus);
load();
