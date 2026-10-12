// Se carga con `node --require` antes de server.js: los pedidos a Brevo no salen a internet,
// se anotan en un archivo (BREVO_LOG) y se responde como si Brevo los hubiera aceptado.
// Si el destinatario contiene "falla-brevo@", se responde con error (para probar reintentos).
const fs = require('fs');
const fetchOriginal = globalThis.fetch;
// precarga: Node carga fetch/Response recién la primera vez que se usan; se fuerza al arrancar
new Response('');
globalThis.fetch = async (url, opciones = {}) => {
  if (String(url).startsWith('https://api.brevo.com')) {
    if (String(opciones.body).includes('falla-brevo@')) {
      return new Response(JSON.stringify({ message: 'falla simulada' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    fs.appendFileSync(process.env.BREVO_LOG, opciones.body + '\n');
    return new Response(JSON.stringify({ messageId: 'prueba' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  return fetchOriginal(url, opciones);
};
