// PIN der Kassen, gegen einen Hash, den PHP (coHashPin() in lib/checkout.php
// von tv-fridingen.de) mit hash_pbkdf2() erzeugt hat.

const { PinGuard, matches } = require("../utils/pin"),
      { check, equal, done } = require("./helpers");

const FROM_PHP = "pbkdf2-sha256$120000$0d1f66d12177400d52a9ba830ea90e70$2562262fa93bf5ba9106bcc627c2b894c47ef50a016cd10527be556f3586e621";

check("richtige PIN", matches("4711", FROM_PHP));
check("falsche PIN", !matches("4712", FROM_PHP));
check("kaputter Hash", !matches("4711", "md5$abc"));

let clock = 0;

const guard = new PinGuard({ now: () => clock });

equal("ohne gesetzte PIN ungeschützt", guard.check("", ""), { ok: true, unprotected: true });

for (let i = 0; i < 4; i++) {
  equal(`Fehlversuch ${i + 1}`, guard.check("0000", FROM_PHP).ok, false);
}

const fifth = guard.check("0000", FROM_PHP);

equal("fünfter Fehlversuch sperrt", fifth.wait, 30);
equal("gesperrt auch mit richtiger PIN", guard.check("4711", FROM_PHP).ok, false);

clock += 31000;
equal("nach der Pause geht es", guard.check("4711", FROM_PHP).ok, true);

done();
