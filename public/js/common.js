// Gemeinsames für Kasse und Einstellungen. Kein Framework, kein Build-Schritt:
// Die Dateien werden so geladen, wie sie hier stehen.

"use strict";

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// "2026-09-20 18:03:12" -> "20.09.2026, 18:03"
function formatDateTime(value) {
  if (!value) {
    return "";
  }

  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);

  return m ? `${m[3]}.${m[2]}.${m[1]}, ${m[4]}:${m[5]}` : String(value);
}

// ISO-Zeitpunkt aus dem Abgleich -> "vor 3 Minuten" / "20.09., 18:03"
function formatRelative(iso) {
  if (!iso) {
    return "noch nie";
  }

  const date = new Date(iso),
        seconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (seconds < 45) {
    return "gerade eben";
  }

  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);

    return `vor ${minutes} ${minutes === 1 ? "Minute" : "Minuten"}`;
  }

  const pad = (n) => String(n).padStart(2, "0");

  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}., ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatEuro(value) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: Number(value) % 1 ? 2 : 0 }).format(Number(value) || 0);
}

const SYNC_TEXT = {
  "neu": "Noch nicht abgeglichen",
  "läuft": "Abgleich läuft…",
  "verbunden": "Verbunden",
  "offline": "Offline",
  "fehler": "Abgleich gestört",
  "gesperrt": "Kasse gesperrt"
};

/*
  Ein Dialog, Antwort als Promise.

    dialog({ title, text, highlight, input: { label, value }, buttons: [{ label, value, kind }] })

  Esc wählt den letzten Knopf (der ist immer "Abbrechen" o. ä.), Enter den
  ersten — der ist die Hauptaktion. Bei einem Eingabefeld kommt { value, input }
  zurück, sonst nur value.
*/
function dialog({ title, text = "", highlight = null, input = null, buttons }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");

    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-kasse" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        ${text ? `<p>${escapeHtml(text)}</p>` : ""}
        ${highlight !== null ? `<div class="highlight">${escapeHtml(highlight)}</div>` : ""}
        ${input ? `<div class="field"><label>${escapeHtml(input.label)}</label><input type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(input.value || "")}"></div>` : ""}
        <div class="buttons">
          ${buttons.map((b, i) => `<button type="button" class="btn-kasse ${b.kind || ""}" data-i="${i}">${escapeHtml(b.label)}</button>`).join("")}
        </div>
      </div>`;

    const field = backdrop.querySelector("input"),
          previousFocus = document.activeElement;

    const finish = (index) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();

      if (previousFocus && previousFocus.focus) {
        previousFocus.focus();
      }

      const value = buttons[index].value;

      resolve(field ? { value, input: field.value } : value);
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(buttons.length - 1);
      }
      else if (e.key === "Enter" && (e.target === field || !e.target.closest || !e.target.closest("button"))) {
        e.preventDefault();
        e.stopPropagation();
        finish(0);
      }
    };

    backdrop.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-i]");

      if (button) {
        finish(Number(button.dataset.i));
      }
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);

    if (field) {
      field.focus();
      field.select();
    }
    else {
      backdrop.querySelector("button").focus();
    }
  });
}

function toast(message, level = "info", ms = 6000) {
  const box = $("toasts");

  if (!box) {
    return;
  }

  const el = document.createElement("div");

  el.className = `toast-kasse ${level}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
