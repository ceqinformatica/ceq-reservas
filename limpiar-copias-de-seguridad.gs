/**
 * Limpiar copias de seguridad: manda a la papelera los correos con la copia mensual de las
 * reservas que tienen más de 6 meses, como dice la Política de Privacidad (art. de conservación:
 * "las copias de seguridad se conservan por el mismo plazo máximo de seis meses").
 *
 * Va en un proyecto de Apps Script APARTE (no en el de la planilla), en la cuenta que recibe las
 * copias (ceq.informatica@gmail.com): script.google.com > Nuevo proyecto > pegar este código.
 * Después, elegir la función "activarLimpiezaDiaria" y tocar Ejecutar (la primera vez Google pide
 * permiso para leer y mover correos de la cuenta; hay que autorizarlo en Chrome, no en otra app).
 *
 * Solo toca los correos que manda el sistema (remitente reservas@ceq-una.com y asunto "Copia de
 * seguridad de las reservas"). Gmail borra definitivamente la papelera a los 30 días.
 */

const BUSQUEDA_COPIAS = 'from:reservas@ceq-una.com subject:"Copia de seguridad de las reservas" older_than:6m';

function limpiarCopiasViejas() {
  let total = 0;
  // De a 100 hilos, que es el máximo que acepta Gmail por vez
  for (let vuelta = 0; vuelta < 20; vuelta++) {
    const hilos = GmailApp.search(BUSQUEDA_COPIAS, 0, 100);
    if (hilos.length === 0) break;
    GmailApp.moveThreadsToTrash(hilos);
    total += hilos.length;
  }
  console.log(total ? `Se mandaron a la papelera ${total} copia(s) de más de 6 meses` : 'No había copias de más de 6 meses');
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
