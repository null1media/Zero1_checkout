// Die Schnittstelle zum Vereinsserver.
//
// Gegenseite: httpdocs/checkout/ im Repo tv-fridingen.de, Logik in
// lib/checkout.php, Beschreibung in .claude/checkout.md.
//
//   POST index.php?action=pair   Kopplungscode gegen Token
//   POST index.php?action=sync   Änderungen einspielen, Bestand holen
//
// Aktualisierungen laufen nicht hierüber, sondern wie bei Zero1 arena über
// checkout.null1.media (utils/updater.js).
//
// Das Token geht nur als Authorization-Kopf, nie in der Adresse — dort stünde
// es im Zugriffsprotokoll des Servers.
//
// Fehler tragen eine Art, weil die Kasse auf jede anders reagiert:
//
//   netz         kein Server erreichbar       -> offline weiterarbeiten
//   abgelehnt    Kopplungscode falsch         -> anderen Code eingeben
//   gesperrt     Token ungültig (401)         -> neu koppeln
//   zuviel       zu viele Versuche (429)      -> warten
//   server       alles andere                 -> später erneut

class ApiError extends Error {
  constructor(art, message, status = null) {
    super(message);
    this.art = art;
    this.status = status;
  }
}

class Api {
  constructor({ baseUrl, token = null, version = "0.0.0", timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || "").replace(/\/?$/, "/");
    this.token = token;
    this.version = version;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  setToken(token) {
    this.token = token;
  }

  url(relative) {
    return new URL(relative, this.baseUrl).toString();
  }

  async request(relative, { method = "GET", body, timeoutMs = this.timeoutMs, auth = true, raw = false } = {}) {
    const headers = { "Accept": raw ? "*/*" : "application/json", "X-App-Version": this.version };

    if (auth && this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response;

    try {
      response = await this.fetch(this.url(relative), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    }
    catch(e) {
      const grund = e && e.name === "TimeoutError" ? "Zeitüberschreitung" : (e && e.cause && e.cause.code) || (e && e.message) || "unbekannt";

      throw new ApiError("netz", `Der Server ist nicht erreichbar (${grund}).`);
    }

    if (raw && response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    }
    catch(e) {
      // Eine HTML-Seite statt JSON: falsche Serveradresse, Wartungsseite,
      // WLAN-Anmeldeseite im Festzelt. Für die Kasse ist das "kein Server".
      throw new ApiError(response.ok ? "netz" : "server", `Der Server antwortet nicht wie erwartet (HTTP ${response.status}).`, response.status);
    }

    if (response.ok) {
      return data;
    }

    const message = (data && data.error) || `HTTP ${response.status}`;

    if (response.status === 401) {
      throw new ApiError("gesperrt", message, 401);
    }

    if (response.status === 403) {
      throw new ApiError("abgelehnt", message, 403);
    }

    if (response.status === 429) {
      throw new ApiError("zuviel", message, 429);
    }

    throw new ApiError("server", message, response.status);
  }

  pair(code) {
    return this.request("index.php?action=pair", { method: "POST", body: { code }, auth: false });
  }

  sync({ since, changes }, timeoutMs) {
    return this.request("index.php?action=sync", { method: "POST", body: { since, changes }, timeoutMs });
  }
}

module.exports = { Api, ApiError };
