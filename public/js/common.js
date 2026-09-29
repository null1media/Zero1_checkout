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

/* ------------------------------------------------------------ Beträge */

// Cent -> "2,50 €"
function euro(cents) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format((Number(cents) || 0) / 100);
}

// "2,5" / "2.50" / "20" -> Cent, sonst null
function parseCents(text) {
  const value = String(text ?? "").replace(/[€\s]/g, "").replace(",", ".");

  if (!/^\d{1,6}(\.\d{0,2})?$/.test(value)) {
    return null;
  }

  return Math.round(parseFloat(value) * 100);
}

/*
  Ein Formular als Dialog, Antwort als Promise: { value, data } mit data als
  Objekt der Feldwerte.

    formDialog({ title, text, fields: [
      { name, label, type: "text" | "money" | "select" | "toggle" | "color", value, options, hint }
    ], buttons: [{ label, value, kind }], validate: (data) => "Fehlertext" | null })

  Wie dialog(): Enter wählt den ersten Knopf, Esc den letzten. Geprüft wird
  nur vor dem ersten Knopf, der Hauptaktion.
*/
const COLORS = ["#c32229", "#e07b00", "#c9a100", "#2e8b57", "#138086", "#1f6fb2", "#5b4fa0", "#a0407b", "#8d5b3a", "#6c757d"];

function formDialog({ title, text = "", fields, buttons, validate = null }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");

    const fieldHtml = (f) => {
      const id = `f-${f.name}`;

      if (f.type === "toggle") {
        return `<label class="toggle"><input type="checkbox" name="${f.name}"${f.value ? " checked" : ""}><span class="knob"></span><span>${escapeHtml(f.label)}${f.hint ? `<small>${escapeHtml(f.hint)}</small>` : ""}</span></label>`;
      }

      if (f.type === "select") {
        return `<div class="field"><label for="${id}">${escapeHtml(f.label)}</label><select id="${id}" name="${f.name}">${f.options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === f.value ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select></div>`;
      }

      if (f.type === "color") {
        return `<div class="field"><label>${escapeHtml(f.label)}</label><div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch${c === f.value ? " active" : ""}" data-color="${c}" title="${c}"></button>`).join("")}</div><input type="hidden" name="${f.name}" value="${escapeHtml(f.value || COLORS[0])}"></div>`;
      }

      return `<div class="field"><label for="${id}">${escapeHtml(f.label)}</label><input id="${id}" name="${f.name}" type="text" spellcheck="false" autocomplete="off"${f.type === "money" ? ' inputmode="decimal"' : ""} value="${escapeHtml(f.value ?? "")}">${f.hint ? `<small>${escapeHtml(f.hint)}</small>` : ""}</div>`;
    };

    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <form class="dialog-kasse" role="dialog" aria-modal="true" novalidate>
        <h3>${escapeHtml(title)}</h3>
        ${text ? `<p>${escapeHtml(text)}</p>` : ""}
        ${fields.map(fieldHtml).join("")}
        <div class="message error" hidden></div>
        <div class="buttons">
          ${buttons.map((b, i) => `<button type="button" class="btn-kasse ${b.kind || ""}" data-i="${i}">${escapeHtml(b.label)}</button>`).join("")}
        </div>
      </form>`;

    // Farben ohne style-Attribut: Die CSP erlaubt keine Inline-Stile im
    // Markup, gesetzt über das DOM geht.
    backdrop.querySelectorAll(".swatch").forEach((s) => s.style.setProperty("--swatch", s.dataset.color));

    const form = backdrop.querySelector("form"),
          message = backdrop.querySelector(".message");

    const read = () => Object.fromEntries(fields.map((f) => {
      const el = form.elements[f.name];

      return [f.name, f.type === "toggle" ? el.checked : el.value];
    }));

    const finish = (index) => {
      if (index === 0 && validate) {
        const problem = validate(read());

        if (problem) {
          message.hidden = false;
          message.textContent = problem;

          return;
        }
      }

      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve({ value: buttons[index].value, data: read() });
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(buttons.length - 1);
      }
      else if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
        e.preventDefault();
        e.stopPropagation();
        finish(0);
      }
    };

    backdrop.addEventListener("click", (e) => {
      const swatch = e.target.closest(".swatch"),
            button = e.target.closest("button[data-i]");

      if (swatch) {
        backdrop.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s === swatch));
        swatch.closest(".field").querySelector("input").value = swatch.dataset.color;
      }
      else if (button) {
        finish(Number(button.dataset.i));
      }
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);

    const first = form.querySelector("input[type=text], select");

    if (first) {
      first.focus();

      if (first.select) {
        first.select();
      }
    }
  });
}

/*
  Ziffernblock als Dialog — für die PIN und für Beträge, mit dem Finger
  bedienbar. Rückgabe: die Eingabe als Zeichenkette oder null.

    padDialog({ title, text, mode: "pin" | "amount", confirm, check: async (value) => "Fehler" | null, extra })

  check läuft vor dem Schließen; liefert es einen Text, bleibt der Dialog
  offen und zeigt ihn (falsche PIN, Betrag fehlt). extra ist zusätzliches
  Markup über der Anzeige, etwa eine Auswahl.
*/
function padDialog({ title, text = "", mode = "amount", confirm = "OK", check = null, extra = "" }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    let value = "";

    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-kasse pad-dialog" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        ${text ? `<p>${escapeHtml(text)}</p>` : ""}
        ${extra}
        <div class="pad-display ${mode}"></div>
        <div class="message error" hidden></div>
        <div class="pad-keys">
          ${["7", "8", "9", "4", "5", "6", "1", "2", "3"].map((k) => `<button type="button" data-key="${k}">${k}</button>`).join("")}
          <button type="button" data-key="${mode === "pin" ? "clear" : ","}">${mode === "pin" ? '<i class="fas fa-xmark"></i>' : ","}</button>
          <button type="button" data-key="0">0</button>
          <button type="button" data-key="back"><i class="fas fa-backspace"></i></button>
        </div>
        <div class="buttons">
          <button type="button" class="btn-kasse" data-action="ok">${escapeHtml(confirm)}</button>
          <button type="button" class="btn-kasse quiet" data-action="cancel">Abbrechen</button>
        </div>
      </div>`;

    const display = backdrop.querySelector(".pad-display"),
          message = backdrop.querySelector(".message");

    const draw = () => {
      display.textContent = mode === "pin" ? ("•".repeat(value.length) || " ") : `${value || "0"} €`;
    };

    const press = (key) => {
      message.hidden = true;

      if (key === "back") {
        value = value.slice(0, -1);
      }
      else if (key === "clear") {
        value = "";
      }
      else if (key === ",") {
        if (!value.includes(",")) {
          value = (value || "0") + ",";
        }
      }
      else if (mode === "pin" ? value.length < 8 : !/,\d\d$/.test(value) && value.replace(",", "").length < 7) {
        value += key;
      }

      draw();
    };

    const close = (result) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(result);
    };

    const submit = async () => {
      if (check) {
        const problem = await check(value, backdrop);

        if (problem) {
          message.hidden = false;
          message.textContent = problem;

          if (mode === "pin") {
            value = "";
            draw();
          }

          return;
        }
      }

      close(value);
    };

    const onKey = (e) => {
      if (/^\d$/.test(e.key) || e.key === ",") {
        press(e.key);
      }
      else if (e.key === "Backspace") {
        press("back");
      }
      else if (e.key === "Enter") {
        submit();
      }
      else if (e.key === "Escape") {
        close(null);
      }
      else {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
    };

    backdrop.addEventListener("click", (e) => {
      const key = e.target.closest("[data-key]"),
            action = e.target.closest("[data-action]");

      if (key) {
        press(key.dataset.key);
      }
      else if (action) {
        if (action.dataset.action === "ok") {
          submit();
        }
        else {
          close(null);
        }
      }
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    draw();
  });
}
