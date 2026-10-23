// Se carga con `node --require` antes de server.js: los pedidos a Brevo no salen a internet,
// se anotan en un archivo (BREVO_LOG) y se responde como si Brevo los hubiera aceptado.
// Si el destinatario contiene "falla-brevo@", o si existe el archivo BREVO_CAIDO, se responde con
// error (para probar reintentos). Los adjuntos con una extensión que Brevo no acepta dan 400.
const fs = require('fs');
const fetchOriginal = globalThis.fetch;
// Extensiones de adjuntos que acepta la API de Brevo (si una no está, Brevo rechaza el correo
// entero con 400). Antes el simulador aceptaba cualquiera y las pruebas no vieron que .json.gz no
// sale (N1 de la verificación del 23/10/2026).
const ADJUNTOS_BREVO = ['xlsx', 'xls', 'ods', 'docx', 'docm', 'doc', 'csv', 'pdf', 'txt', 'gif', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'rtf',
  'bmp', 'cgm', 'css', 'shtml', 'html', 'htm', 'zip', 'xml', 'ppt', 'pptx', 'tar', 'ez', 'ics', 'mobi', 'msg', 'pub', 'eps', 'odt', 'mp3',
  'm4a', 'm4v', 'wma', 'ogg', 'flac', 'wav', 'aif', 'aifc', 'aiff', 'mp4', 'mov', 'avi', 'mkv', 'mpeg', 'mpg', 'wmv', 'pkpass', 'xlsm'];
// precarga: Node carga fetch/Response recién la primera vez que se usan; se fuerza al arrancar
new Response('');
globalThis.fetch = async (url, opciones = {}) => {
  if (String(url).startsWith('https://api.brevo.com')) {
    // BREVO_CAIDO: mientras exista ese archivo, Brevo responde error a todo (para probar la cola)
    const caido = process.env.BREVO_CAIDO && fs.existsSync(process.env.BREVO_CAIDO);
    if (caido || String(opciones.body).includes('falla-brevo@')) {
      return new Response(JSON.stringify({ message: 'falla simulada' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    let adjuntos = [];
    try { adjuntos = JSON.parse(opciones.body).attachment || []; } catch (e) { /* sin cuerpo JSON */ }
    // BREVO_RECHAZAR: mientras exista ese archivo, también se rechazan las extensiones que tiene
    // adentro (una por línea), para probar qué pasa si Brevo no acepta un adjunto
    const extraRechazadas = process.env.BREVO_RECHAZAR && fs.existsSync(process.env.BREVO_RECHAZAR)
      ? fs.readFileSync(process.env.BREVO_RECHAZAR, 'utf8').split(/\s+/).filter(Boolean) : [];
    const rechazado = adjuntos.find(a => {
      const extension = String(a.name || '').split('.').pop().toLowerCase();
      return !ADJUNTOS_BREVO.includes(extension) || extraRechazadas.includes(extension);
    });
    if (rechazado) {
      return new Response(JSON.stringify({ code: 'invalid_parameter', message: `Unsupported file format: ${rechazado.name}` }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    fs.appendFileSync(process.env.BREVO_LOG, opciones.body + '\n');
    return new Response(JSON.stringify({ messageId: 'prueba' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  return fetchOriginal(url, opciones);
};
