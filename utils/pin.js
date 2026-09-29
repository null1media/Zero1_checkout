// Die PIN der Kassen.
//
// Gesetzt im Adminbereich (/admin/kasse/), beim Abgleich als Hash in
// settings.pin mitgeliefert und hier ohne Netz geprüft. Format wie
// coHashPin() in lib/checkout.php von tv-fridingen.de:
//
//   pbkdf2-sha256$<Iterationen>$<Salz>$<Hash, hex>
//
// Das Salz geht als Zeichenkette in die Rechnung, genau wie bei PHPs
// hash_pbkdf2(). Ohne gesetzte PIN ist die Kasse ungeschützt — das sagt die
// Oberfläche dann auch.
//
// Gegen Durchprobieren: nach fünf Fehlversuchen eine halbe Minute Pause.

const crypto = require("crypto");

const MAX_TRIES = 5,
      LOCK_MS = 30000;

function parse(stored) {
  const m = /^pbkdf2-sha256\$(\d+)\$([^$]+)\$([0-9a-f]+)$/i.exec(String(stored || ""));

  return m ? { iterations: Number(m[1]), salt: m[2], hash: m[3].toLowerCase() } : null;
}

function matches(pin, stored) {
  const p = parse(stored);

  if (!p || p.iterations < 1 || p.iterations > 10000000) {
    return false;
  }

  const actual = crypto.pbkdf2Sync(String(pin), p.salt, p.iterations, p.hash.length / 2, "sha256");

  return crypto.timingSafeEqual(actual, Buffer.from(p.hash, "hex"));
}

class PinGuard {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.failures = 0;
    this.lockedUntil = 0;
  }

  // Rückgabe: { ok } oder { ok: false, message, wait }
  check(pin, stored) {
    if (!parse(stored)) {
      return { ok: true, unprotected: true };
    }

    const wait = this.lockedUntil - this.now();

    if (wait > 0) {
      return { ok: false, wait: Math.ceil(wait / 1000), message: `Zu viele Fehlversuche. Bitte ${Math.ceil(wait / 1000)} Sekunden warten.` };
    }

    if (matches(pin, stored)) {
      this.failures = 0;

      return { ok: true };
    }

    this.failures++;

    if (this.failures >= MAX_TRIES) {
      this.failures = 0;
      this.lockedUntil = this.now() + LOCK_MS;

      return { ok: false, wait: LOCK_MS / 1000, message: `Falsche PIN. Nach ${MAX_TRIES} Fehlversuchen ist die Eingabe eine halbe Minute gesperrt.` };
    }

    return { ok: false, message: "Falsche PIN." };
  }
}

module.exports = { PinGuard, matches, parse };
