// Se carga con `node --require` antes de server.js: corre el reloj del servidor según un
// archivo ({ "desfase_ms": N }) que la prueba puede cambiar mientras el servidor corre.
const fs = require('fs');
const RealDate = Date;
const archivo = process.env.RELOJ_FALSO;
let cache = { t: 0, desfase: 0 };
function desfase() {
  const ahora = RealDate.now();
  if (ahora - cache.t > 30) {
    try { cache = { t: ahora, desfase: JSON.parse(fs.readFileSync(archivo, 'utf8')).desfase_ms || 0 }; } catch (e) { cache.t = ahora; }
  }
  return cache.desfase;
}
class FalsoDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() + desfase()); else super(...args); }
  static now() { return RealDate.now() + desfase(); }
}
global.Date = FalsoDate;
