// Prueba limpiar-copias-de-seguridad.gs (Apps Script de Gmail) contra un Gmail simulado: guarda solo
// las 2 copias más nuevas, manda a la papelera los demás correos del sistema de más de 6 meses y
// no toca lo que la Secretaría mandó desde la cuenta ni otros remitentes.
// Uso: node probar_limpieza_gmail.js <limpiar-copias-de-seguridad.gs>
const fs = require('fs');
const vm = require('vm');

const [archivo] = process.argv.slice(2);
const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });

const HOY = new Date('2026-11-16T12:00:00Z');
const haceDias = d => new Date(HOY.getTime() - d * 86400000);
let n = 0;
// Cada correo: { id, de, asunto, fecha, enviado (está en "Enviados"), hilo, papelera }
const correos = [];
const correo = (hilo, de, asunto, dias, enviado = false) => { const c = { id: 'm' + (++n), hilo, de, asunto, fecha: haceDias(dias), enviado, papelera: false }; correos.push(c); return c; };

const SISTEMA = 'CEQ Reservas <reservas@ceq-una.com>';
const copias = [10, 40, 70, 100, 200].map((d, i) => correo('copia' + i, SISTEMA, `Copia de seguridad de las reservas: mes ${i} (5 reservas)`, d));
const avisoViejo = correo('aviso1', SISTEMA, '📌 Nueva Reserva (Frente) - CEQ #10', 200);
// La Secretaría le respondió a la persona desde esta cuenta (como reservas@), en la misma conversación
const respuestaVieja = correo('aviso1', 'Reservas CEQ <reservas@ceq-una.com>', 'Re: 📌 Nueva Reserva (Frente) - CEQ #10', 199, true);
const avisoNuevo = correo('aviso2', SISTEMA, '📌 Nueva Reserva (Altillo) - CEQ #500', 30);
const alertaVieja = correo('alerta', SISTEMA, '⚠️ Alerta del sistema de reservas: 1 error(es)', 190);
const ajeno = correo('otro', 'Alguien <alguien@gmail.com>', 'Consulta sobre reservas', 300);
const enviadoViejo = correo('pedido', 'Reservas CEQ <reservas@ceq-una.com>', 'Respuesta a tu pedido de datos', 250, true);
const copiaPapelera = correo('copia9', SISTEMA, 'Copia de seguridad de las reservas: vieja', 5);
copiaPapelera.papelera = true;

// ---- Gmail simulado: lo que usa el script ----
// Gmail le pone "Delivered-To" a lo que recibe la cuenta; lo que manda no lo tiene
const mensaje = c => ({
  getId: () => c.id, getFrom: () => c.de, getSubject: () => c.asunto, getDate: () => c.fecha,
  getHeader: nombre => (nombre === 'Delivered-To' && !c.enviado ? 'ceq.informatica@gmail.com' : ''),
  isInTrash: () => c.papelera, moveToTrash: () => { c.papelera = true; }
});
function buscar(q) {
  const de = (q.match(/from:(\S+)/) || [])[1];
  const asunto = (q.match(/subject:"([^"]+)"/) || [])[1];
  const meses = Number((q.match(/older_than:(\d+)m/) || [])[1] || 0);
  const soloEnviados = q.includes('in:sent');
  const limite = new Date(HOY); limite.setMonth(limite.getMonth() - meses);
  const cumple = c => !c.papelera && (!de || c.de.toLowerCase().includes(de)) && (!asunto || c.asunto.includes(asunto)) &&
    (!meses || c.fecha < limite) && (!soloEnviados || c.enviado);
  // Gmail devuelve conversaciones enteras: con un correo que cumple, viene todo el hilo
  return [...new Set(correos.filter(cumple).map(c => c.hilo))];
}
const contexto = {
  console: { log: () => {} },
  Date: class extends Date { constructor(...a) { super(...(a.length ? a : [HOY.getTime()])); } static now() { return HOY.getTime(); } },
  GmailApp: {
    search: (q, desde, cuantos) => buscar(q).slice(desde, desde + cuantos),
    getMessagesForThreads: hilos => hilos.map(h => correos.filter(c => c.hilo === h).map(mensaje))
  },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }) }) }) }
};
vm.createContext(contexto);
vm.runInContext(fs.readFileSync(archivo, 'utf8'), contexto);
contexto.limpiarCopiasViejas();

anotar('Quedan solo las 2 copias más nuevas (10 y 40 días); las otras 3 van a la papelera',
  !copias[0].papelera && !copias[1].papelera && copias.slice(2).every(c => c.papelera), copias.map(c => c.papelera).join());
anotar('Un aviso interno de más de 6 meses va a la papelera', avisoViejo.papelera);
anotar('...pero la respuesta de la Secretaría en la misma conversación no se toca', !respuestaVieja.papelera);
anotar('Un aviso de hace un mes no se toca', !avisoNuevo.papelera);
anotar('Una alerta de más de 6 meses va a la papelera', alertaVieja.papelera);
anotar('Los correos de otros remitentes no se tocan', !ajeno.papelera);
anotar('Lo que se mandó desde la cuenta (Enviados), aunque sea viejo, no se toca', !enviadoViejo.papelera);
contexto.limpiarCopiasViejas();
anotar('Correrlo otra vez no borra nada más (siguen las 2 copias)', !copias[0].papelera && !copias[1].papelera && !avisoNuevo.papelera);
let errorActivar = null;
try { contexto.activarLimpiezaDiaria(); } catch (e) { errorActivar = e; }
anotar('activarLimpiezaDiaria corre sin errores', !errorActivar, errorActivar && errorActivar.message);

let ok = 0;
for (const x of resultados) { console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`); if (x.ok) ok++; }
console.log(`\n${ok}/${resultados.length} pruebas correctas`);
process.exit(ok === resultados.length ? 0 : 1);
