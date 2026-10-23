/**
 * Limpiar copias de seguridad y avisos viejos (Política de Privacidad, art. 10: los datos se
 * conservan como máximo 6 meses).
 *
 * Hace dos cosas, una vez por día:
 *  1. Copias mensuales de las reservas (asunto "Copia de seguridad de las reservas"): guarda solo
 *     las COPIAS_A_GUARDAR más nuevas y manda a la papelera las demás, aunque no tengan 6 meses.
 *     Cada copia tiene todas las reservas, así que con las últimas alcanza para recuperar todo.
 *  2. Los demás correos que manda el sistema a esta cuenta (avisos de reservas nuevas y de
 *     cancelaciones, reportes, alertas y pruebas del panel): los que tienen más de 6 meses van a la
 *     papelera. Tienen nombres, celulares y correos de quienes reservaron.
 *
 * Solo toca correos RECIBIDOS desde reservas@ceq-una.com. Las respuestas que la Secretaría manda
 * desde esta cuenta (aunque salgan como reservas@ceq-una.com) no se tocan, aunque estén en la
 * misma conversación. Gmail borra definitivamente la papelera a los 30 días.
 *
 * Los avisos que les llegan a otras cuentas (por ejemplo, el correo personal de quien modera el
 * Frente) no se pueden limpiar desde acá: cada persona los tiene que borrar en su casilla.
 *
 * Va en un proyecto de Apps Script APARTE (no en el de la planilla), en la cuenta que recibe las
 * copias (ceq.informatica@gmail.com): script.google.com > el proyecto "Limpiar copias de
 * seguridad" > reemplazar todo el código por este > Guardar. Después, elegir la función
 * "activarLimpiezaDiaria" y tocar Ejecutar (si Google pide permiso otra vez, autorizarlo en Chrome).
 */

const REMITENTE = 'reservas@ceq-una.com';
const COPIAS_A_GUARDAR = 2;
const ASUNTO_COPIA = 'Copia de seguridad de las reservas';
const MESES_DE_CONSERVACION = 6;

// Correos de una búsqueda, de a 100 conversaciones (el máximo que acepta Gmail por vez)
function mensajesDe(busqueda) {
  const mensajes = [];
  for (let desde = 0; desde < 5000; desde += 100) {
    const hilos = GmailApp.search(busqueda, desde, 100);
    if (hilos.length === 0) break;
    GmailApp.getMessagesForThreads(hilos).forEach(lista => lista.forEach(m => mensajes.push(m)));
    if (hilos.length < 100) break;
  }
  return mensajes;
}

// ¿Lo mandó el sistema (Brevo) a esta cuenta? Gmail le pone "Delivered-To" a cada correo que
// RECIBE; los que manda la Secretaría desde esta misma cuenta (aunque salgan como reservas@) no lo
// tienen, y esos no se tocan. Se mira correo por correo: una búsqueda de Gmail devuelve la
// conversación entera, con las respuestas incluidas.
function esDelSistema(mensaje) {
  return mensaje.getFrom().toLowerCase().indexOf(REMITENTE) !== -1 && !!mensaje.getHeader('Delivered-To') && !mensaje.isInTrash();
}

function limpiarCopiasViejas() {
  // 1. Copias mensuales: quedan las más nuevas
  const copias = mensajesDe('from:' + REMITENTE + ' subject:"' + ASUNTO_COPIA + '"')
    .filter(m => esDelSistema(m) && m.getSubject().indexOf(ASUNTO_COPIA) === 0)
    .sort((a, b) => b.getDate() - a.getDate());
  const copiasViejas = copias.slice(COPIAS_A_GUARDAR);
  copiasViejas.forEach(m => m.moveToTrash());

  // 2. El resto de los correos del sistema con más de 6 meses
  const limite = new Date();
  limite.setMonth(limite.getMonth() - MESES_DE_CONSERVACION);
  const viejos = mensajesDe('from:' + REMITENTE + ' older_than:' + MESES_DE_CONSERVACION + 'm')
    .filter(m => esDelSistema(m) && m.getDate() < limite);
  viejos.forEach(m => m.moveToTrash());

  console.log('Copias: quedan ' + Math.min(copias.length, COPIAS_A_GUARDAR) + ', a la papelera ' + copiasViejas.length +
    '. Otros correos del sistema de más de ' + MESES_DE_CONSERVACION + ' meses a la papelera: ' + viejos.length + '.');
}

// Deja la limpieza programada una vez por día (y la corre ahora). Se puede ejecutar de nuevo sin
// que se dupliquen los activadores.
function activarLimpiezaDiaria() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'limpiarCopiasViejas')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('limpiarCopiasViejas').timeBased().everyDays(1).atHour(4).create();
  limpiarCopiasViejas();
}
