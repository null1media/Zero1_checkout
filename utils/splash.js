// Der Ladebildschirm.
//
// Steht vom ersten Moment bis die Kasse fertig gezeichnet ist: Kopplung,
// Suche nach Aktualisierungen, Abgleich. Übernommen von Zero1 arena, also im
// Design von Null1 media: Farbverlauf von null1.media, gleiche Kurve, gleiche
// Dauer, darauf der Schriftzug "Zero1 checkout". Das Vereinslogo steht erst in
// der Kasse selbst.
//
// Die Seite hängt an nichts, wird als data-URL geladen, das Logo steckt als
// Base64 darin.
//
// Vier Zustände, immer nur einer sichtbar:
//
//   status        Meldung und Fortschrittsbalken
//   seriennummer  Abfrage der Seriennummer (erster Start, wie bei Zero1 arena)
//   code          Abfrage des Kopplungscodes aus dem Adminbereich des Vereins
//                 (erster Start nach der Seriennummer, oder Kasse gesperrt)
//   frage         Meldung mit zwei Knöpfen — etwa "Erneut versuchen" /
//                 "Beenden", wenn beim allerersten Start kein Server
//                 erreichbar ist
//
// Rückkanal ohne Preload: Der Hauptprozess wartet auf ein Promise, das die
// Seite auflöst. Ein Preload läuft auf einer data-URL nicht zuverlässig, und
// mehr als eine Zeichenkette zurück braucht es nicht.

function escape(text) {
  return String(text || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

function html({ logo = "", version = "", copyright = "" } = {}) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:transparent;overflow:hidden;cursor:default;
      font:13px/1.6 "Segoe UI",system-ui,sans-serif;color:#eaf2f9;-webkit-user-select:none}

    /* Muss sein: .fuss und .dialog setzen display:flex, und eine Klassenregel
       schlägt das display:none, das der Browser dem hidden-Attribut mitgibt. */
    [hidden]{display:none !important}

    .karte{position:relative;height:100%;box-sizing:border-box;border-radius:14px;
      overflow:hidden;display:flex;flex-direction:column;align-items:center;
      justify-content:center;
      background:linear-gradient(-45deg,#000,#001a2b,#0a5a94,#001523);
      background-size:400% 400%;
      animation:verlauf 15s cubic-bezier(.65,.05,.36,1) infinite}
    @keyframes verlauf{0%{background-position:0% 50%}50%{background-position:100% 50%}
      100%{background-position:0% 50%}}

    /* Nach außen dunkler, damit die Schrift auf jeder Verlaufsstellung trägt. */
    .karte::after{content:"";position:absolute;inset:0;pointer-events:none;
      background:radial-gradient(115% 85% at 50% 42%,transparent 18%,rgba(0,0,0,.68) 100%)}

    .inhalt{position:relative;z-index:1;display:flex;flex-direction:column;
      align-items:center;gap:34px;width:100%}

    /* Gleiche Symbolgröße wie bei Zero1 arena: dort 250 Punkte für einen
       500 Pixel breiten Schriftzug, hier ist er 765 breit. */
    #logo{width:382px;opacity:0;transform:translateY(10px) scale(.985);
      animation:auftritt .9s cubic-bezier(.16,1,.3,1) .08s forwards;
      filter:drop-shadow(0 4px 16px rgba(0,0,0,.5))}
    @keyframes auftritt{to{opacity:1;transform:none}}

    .fuss{display:flex;flex-direction:column;align-items:center;gap:13px;width:290px;
      opacity:0;animation:auftritt .9s cubic-bezier(.16,1,.3,1) .32s forwards}

    /* Zwei Zeilen sind fest reserviert. Sonst schiebt eine länger gewordene
       Meldung den Fortschrittsbalken nach unten, und der hüpft bei jedem
       Wechsel. */
    #text{margin:0;font-size:12.5px;letter-spacing:.015em;opacity:.92;
      height:3.2em;display:flex;align-items:center;justify-content:center;
      text-align:center;transition:opacity .16s ease}
    #text.stumm{opacity:0}

    .bahn{position:relative;width:100%;height:3px;border-radius:2px;
      background:rgba(255,255,255,.15);overflow:hidden}
    #balken{position:absolute;top:0;bottom:0;left:0;width:0;border-radius:2px;
      background:linear-gradient(90deg,#3f9bd8,#ffffff);
      transition:width .35s cubic-bezier(.22,1,.36,1)}

    /* Unbestimmt: es läuft etwas, aber niemand weiß, wie lange. */
    .bahn.unbestimmt #balken{width:38%;transition:none;
      animation:lauf 1.25s cubic-bezier(.65,.05,.36,1) infinite}
    @keyframes lauf{0%{left:-38%}100%{left:100%}}

    /* Abfragen stehen an derselben Stelle wie sonst Meldung und Balken. */
    .dialog{display:flex;flex-direction:column;align-items:center;gap:11px;width:320px;
      opacity:0;animation:auftritt .5s cubic-bezier(.16,1,.3,1) forwards}
    .dialog label,.dialog .frage{font-size:12.5px;letter-spacing:.015em;opacity:.9;text-align:center;margin:0}
    .dialog input{width:100%;box-sizing:border-box;text-align:center;
      font:inherit;font-size:17px;letter-spacing:.2em;text-transform:uppercase;color:#fff;
      background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.22);
      border-radius:7px;padding:8px 12px;outline:none;
      transition:border-color .18s ease,background .18s ease}
    .dialog input.serie{font-size:14px;letter-spacing:.08em;text-transform:none;padding:9px 12px}
    .dialog input:focus{border-color:rgba(255,255,255,.6);background:rgba(0,0,0,.38)}
    .dialog .fehler{margin:0;font-size:11.5px;color:#ffc9c2;min-height:1.3em;text-align:center}
    .dialog .knoepfe{display:flex;gap:9px;width:100%}
    .dialog button{flex:1;font:inherit;font-size:12.5px;cursor:pointer;
      border-radius:7px;padding:8px 10px;border:1px solid transparent;
      transition:background .18s ease,border-color .18s ease}
    .dialog button.haupt{background:#ffffff;color:#00243c;font-weight:600}
    .dialog button.haupt:hover{background:#dceaf5}
    .dialog button.leise{background:transparent;color:#eaf2f9;
      border-color:rgba(255,255,255,.28)}
    .dialog button.leise:hover{background:rgba(255,255,255,.1)}

    .fusszeile{position:absolute;left:15px;right:15px;bottom:11px;z-index:1;
      display:flex;justify-content:space-between;align-items:baseline;gap:12px;
      font-size:10.5px;letter-spacing:.04em;opacity:.45}
    .fusszeile span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  </style></head><body>
    <div class="karte">
      <div class="inhalt">
        ${logo ? `<img id="logo" src="data:image/png;base64,${logo}" alt="Zero1 checkout">` : ""}
        <div class="fuss" id="fuss">
          <p id="text">Wird gestartet…</p>
          <div class="bahn unbestimmt" id="bahn"><div id="balken"></div></div>
        </div>
        <form class="dialog" id="serie" hidden>
          <label for="seriennummer">Bitte Seriennummer eingeben</label>
          <input id="seriennummer" class="serie" type="text" autocomplete="off" spellcheck="false" autocapitalize="off">
          <p class="fehler" id="seriefehler"></p>
          <div class="knoepfe">
            <button type="submit" class="haupt">Weiter</button>
            <button type="button" class="leise" id="serieabbruch">Beenden</button>
          </div>
        </form>
        <form class="dialog" id="code" hidden>
          <label for="codefeld">Kopplungscode aus dem Adminbereich des Vereins eingeben</label>
          <input id="codefeld" type="text" maxlength="9" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX">
          <p class="fehler" id="codefehler"></p>
          <div class="knoepfe">
            <button type="submit" class="haupt">Koppeln</button>
            <button type="button" class="leise" id="codeabbruch">Beenden</button>
          </div>
        </form>
        <div class="dialog" id="frage" hidden>
          <p class="frage" id="fragetext"></p>
          <div class="knoepfe">
            <button type="button" class="haupt" id="frageja"></button>
            <button type="button" class="leise" id="fragenein"></button>
          </div>
        </div>
      </div>
      <div class="fusszeile">
        <span>${escape(copyright)}</span>
        <span>${version ? `Version ${escape(version)}` : ""}</span>
      </div>
    </div>
  <script>
    const $ = (id) => document.getElementById(id),
          ansichten = ["fuss", "serie", "code", "frage"];

    let letzter = $("text").textContent;

    function zeige(name) {
      for (const a of ansichten) {
        $(a).hidden = a !== name;
      }
    }

    function fertig(wert) {
      if (typeof window.__antwort === "function") {
        const r = window.__antwort;

        window.__antwort = null;
        r(wert);
      }
    }

    // Beim Tippen gleich in die Form XXXX-XXXX bringen.
    $("codefeld").addEventListener("input", (e) => {
      const roh = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

      e.target.value = roh.length > 4 ? roh.slice(0, 4) + "-" + roh.slice(4) : roh;
    });

    $("code").addEventListener("submit", (e) => {
      e.preventDefault();

      const wert = $("codefeld").value.replace(/[^A-Z0-9]/g, "");

      if (wert.length !== 8) {
        $("codefehler").textContent = "Der Code hat acht Zeichen.";
        $("codefeld").focus();

        return;
      }

      fertig(wert);
    });

    $("serie").addEventListener("submit", (e) => {
      e.preventDefault();

      const wert = $("seriennummer").value.trim();

      if (!wert) {
        $("seriennummer").focus();

        return;
      }

      fertig(wert);
    });

    $("serieabbruch").addEventListener("click", () => fertig(null));
    $("codeabbruch").addEventListener("click", () => fertig(null));
    $("frageja").addEventListener("click", () => fertig(true));
    $("fragenein").addEventListener("click", () => fertig(false));

    window.addEventListener("message", (e) => {
      const d = e.data || {};

      if (d.modus === "seriennummer") {
        zeige("serie");
        $("seriefehler").textContent = d.fehler || "";
        $("seriennummer").focus();
        $("seriennummer").select();

        return;
      }

      if (d.modus === "code") {
        zeige("code");
        $("codefehler").textContent = d.fehler || "";
        $("codefeld").focus();
        $("codefeld").select();

        return;
      }

      if (d.modus === "frage") {
        zeige("frage");
        $("fragetext").textContent = d.text || "";
        $("frageja").textContent = d.ja || "OK";
        $("fragenein").textContent = d.nein || "Abbrechen";

        return;
      }

      zeige("fuss");

      // Den Text nur wechseln, wenn er sich wirklich ändert. Sonst blendet die
      // Zeile bei jedem Fortschrittsschritt neu ein und flackert.
      if (typeof d.text === "string" && d.text !== letzter) {
        letzter = d.text;
        $("text").classList.add("stumm");
        setTimeout(() => {
          $("text").textContent = d.text;
          $("text").classList.remove("stumm");
        }, 160);
      }

      if (typeof d.anteil === "number" && isFinite(d.anteil)) {
        $("bahn").classList.remove("unbestimmt");
        $("balken").style.width = Math.max(0, Math.min(100, d.anteil * 100)) + "%";
      }
      else {
        $("bahn").classList.add("unbestimmt");
        $("balken").style.width = "";
      }
    });
  </script></body></html>`;
}

module.exports = { html };
