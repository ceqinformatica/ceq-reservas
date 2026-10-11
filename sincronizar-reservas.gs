/**
 * @OnlyCurrentDoc  (el script solo puede tocar ESTA planilla, ninguna otra de la cuenta)
 *
 * Planilla de reservas del CEQ: se actualiza sola desde el sistema de reservas.
 *
 * Va pegado en la planilla de Google Sheets (Extensiones > Apps Script), en la cuenta
 * ceq.informatica@gmail.com. Pide las reservas a https://api.ceq-una.com con la clave
 * CLAVE_SINCRONIZACION (la misma que está en Render) y arma:
 *   - Reservas: todas las reservas, una por fila (se reescribe en cada actualización).
 *   - Una pestaña por mes ("Octubre 2026", ...), del más nuevo al más viejo, con las reservas
 *     de ese mes (también se reescriben; si un mes se queda sin reservas, su pestaña se borra).
 *   - Resumen: totales y la hora de la última actualización.
 *   - Copia AAAA-MM: en la primera actualización de cada mes se guarda una copia fija de
 *     "Reservas" (copia de seguridad: no se vuelve a tocar). Se conservan las últimas 24.
 *
 * La clave NO se escribe en este código: se guarda con el menú "Reservas CEQ > Guardar clave".
 * La planilla tiene datos personales: compartila solo con quienes administran el sistema.
 */

const URL_RESERVAS = 'https://api.ceq-una.com/api/sincronizacion/reservas';
const ZONA = 'America/Asuncion';
const HOJA_RESERVAS = 'Reservas';
const HOJA_RESUMEN = 'Resumen';
const PREFIJO_COPIA = 'Copia ';
const COPIAS_A_CONSERVAR = 24;
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const PATRON_HOJA_MES = new RegExp('^(' + MESES.join('|') + ') \\d{4}$'); // "Octubre 2026"
const COLUMNAS = ['N°', 'Fecha', 'Día', 'Espacio', 'Turno', 'Inicio', 'Fin', 'Nombre', 'Celular', 'Email', 'Motivo',
  'Estado', 'Prioridad', 'Creada', 'Cancelada', 'Cancelada por', 'Motivo de cancelación'];
const COL_FECHA = 2;
const COL_FECHA_HORA = [14, 15];

// ---------- Menú ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Reservas CEQ')
    .addItem('Actualizar ahora', 'actualizarAhora')
    .addSeparator()
    .addItem('1. Guardar clave de sincronización', 'guardarClave')
    .addItem('2. Activar actualización automática (cada hora)', 'activarActualizacionAutomatica')
    .addItem('Desactivar actualización automática', 'desactivarActualizacionAutomatica')
    .addToUi();
}

function guardarClave() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Clave de sincronización',
    'Pegá la clave (la misma que pusiste en Render como CLAVE_SINCRONIZACION):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const clave = r.getResponseText().trim();
  if (clave.length < 32) {
    ui.alert('La clave es demasiado corta (tiene que tener al menos 32 caracteres). No se guardó.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('CLAVE_SINCRONIZACION', clave);
  ui.alert('Clave guardada. Ahora usá "Actualizar ahora" para probar.');
}

function activarActualizacionAutomatica() {
  desactivarActualizacionAutomatica_();
  ScriptApp.newTrigger('sincronizar').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('Listo: la planilla se va a actualizar sola cada hora. Si alguna vez falla, Google avisa por correo.');
}

function desactivarActualizacionAutomatica() {
  const cuantos = desactivarActualizacionAutomatica_();
  SpreadsheetApp.getUi().alert(cuantos > 0 ? 'Se desactivó la actualización automática.' : 'No estaba activada.');
}

function desactivarActualizacionAutomatica_() {
  const disparadores = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sincronizar');
  disparadores.forEach(t => ScriptApp.deleteTrigger(t));
  return disparadores.length;
}

function actualizarAhora() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const total = sincronizar();
    ss.toast(`Listo: ${total} reservas.`, 'Reservas CEQ', 5);
  } catch (e) {
    SpreadsheetApp.getUi().alert('No se pudo actualizar: ' + e.message);
  }
}

// ---------- Actualización (la llama el disparador cada hora) ----------
function sincronizar() {
  const candado = LockService.getScriptLock();
  if (!candado.tryLock(60 * 1000)) return 0; // ya hay otra actualización en curso
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const resumen = obtenerHoja_(ss, HOJA_RESUMEN, 0);
  try {
    if (ss.getSpreadsheetTimeZone() !== ZONA) ss.setSpreadsheetTimeZone(ZONA);
    const datos = pedirReservas_();
    const hoja = obtenerHoja_(ss, HOJA_RESERVAS, 1);
    escribirReservas_(hoja, datos.reservas);
    escribirMeses_(ss, datos.reservas);
    escribirResumen_(resumen, datos);
    guardarCopiaMensual_(ss, hoja);
    borrarHojaVaciaInicial_(ss);
    return datos.reservas.length;
  } catch (e) {
    // Se dejan los últimos datos buenos y solo se anota el error. Al relanzarlo, Google avisa
    // por correo si falla el disparador automático.
    resumen.getRange('B3').setValue('Error: ' + e.message + ' (' + ahoraTexto_() + ')');
    throw e;
  } finally {
    candado.releaseLock();
  }
}

function pedirReservas_() {
  const clave = PropertiesService.getScriptProperties().getProperty('CLAVE_SINCRONIZACION');
  if (!clave) throw new Error('Falta guardar la clave (menú Reservas CEQ > 1. Guardar clave de sincronización).');
  const opciones = { method: 'get', headers: { 'X-Clave-Sincronizacion': clave }, muteHttpExceptions: true };
  let respuesta = UrlFetchApp.fetch(URL_RESERVAS, opciones);
  if (respuesta.getResponseCode() >= 500) { // el servidor gratuito puede estar despertando
    Utilities.sleep(20 * 1000);
    respuesta = UrlFetchApp.fetch(URL_RESERVAS, opciones);
  }
  const codigo = respuesta.getResponseCode();
  let cuerpo = {};
  try { cuerpo = JSON.parse(respuesta.getContentText()); } catch (e) { /* respuesta no JSON */ }
  if (codigo === 401) throw new Error('El servidor rechazó la clave. Revisá que sea la misma que CLAVE_SINCRONIZACION en Render.');
  if (codigo !== 200) throw new Error(`El servidor respondió ${codigo}${cuerpo.error ? ': ' + cuerpo.error : ''}`);
  if (!Array.isArray(cuerpo.reservas)) throw new Error('Respuesta inesperada del servidor');
  return cuerpo;
}

// ---------- Armado de filas (sin servicios de Google: se puede probar aparte) ----------
function armarFilasReservas(reservas, fechaDesdeTexto, fechaHoraDesdeIso) {
  return reservas.map(r => [
    r.id,
    fechaDesdeTexto(r.fecha),
    diaSemana(r.fecha),
    r.espacio,
    r.turno || '-',
    comoTexto(r.hora_inicio), // si no, Google lo convierte en hora y muestra "7:00" en vez de "07:00"
    comoTexto(r.hora_fin),
    comoTexto(r.nombre),
    comoTexto(r.celular),
    comoTexto(r.email),
    comoTexto(r.motivo),
    r.estado === 'cancelada' ? 'Cancelada' : 'Activa',
    r.prioridad ? 'Sí' : 'No',
    r.creada_en ? fechaHoraDesdeIso(r.creada_en) : '',
    r.estado === 'cancelada' && r.cancelada_en ? fechaHoraDesdeIso(r.cancelada_en) : '',
    r.estado === 'cancelada' ? (r.cancelada_por || (r.cancelada_en ? '' : 'sin datos')) : '',
    comoTexto(r.motivo_cancelacion)
  ]);
}

// Lo que escribe la gente nunca se interpreta como fórmula ni como número (un celular
// "0981..." perdería el 0). La comilla inicial no se ve en la celda.
function comoTexto(valor) {
  const texto = String(valor == null ? '' : valor);
  return texto === '' ? '' : "'" + texto;
}

function diaSemana(fechaIso) {
  const [a, m, d] = fechaIso.split('-').map(Number);
  return DIAS_SEMANA[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
}

function armarResumen(reservas) {
  const activas = reservas.filter(r => r.estado === 'activa');
  const contar = (lista, condicion) => lista.filter(condicion).length;
  const bloques = [];

  const porEspacio = [['Por espacio', 'Activas', 'Canceladas', 'Total']];
  ['Frente', 'Altillo', 'Sala de Reuniones'].forEach(espacio => {
    const del = reservas.filter(r => r.espacio === espacio);
    if (del.length === 0) return;
    const act = contar(del, r => r.estado === 'activa');
    porEspacio.push([espacio, act, del.length - act, del.length]);
  });
  porEspacio.push(['Total', activas.length, reservas.length - activas.length, reservas.length]);
  bloques.push(porEspacio);

  const frente = activas.filter(r => r.espacio === 'Frente');
  if (frente.length > 0) {
    bloques.push([['Frente por turno (activas)', 'Reservas']]
      .concat(['Desayuno', 'Almuerzo', 'Merienda'].map(t => [t, contar(frente, r => r.turno === t)])));
  }

  bloques.push([['Por día de la semana (activas)', 'Reservas']]
    .concat([1, 2, 3, 4, 5].map(d => [DIAS_SEMANA[d], contar(activas, r => diaSemana(r.fecha) === DIAS_SEMANA[d])])));

  const meses = Array.from(new Set(reservas.map(r => r.fecha.slice(0, 7)))).sort();
  bloques.push([['Por mes', 'Activas', 'Canceladas']].concat(meses.map(mes => {
    const del = reservas.filter(r => r.fecha.startsWith(mes));
    const act = contar(del, r => r.estado === 'activa');
    // Como texto: si no, Google convierte "Agosto 2026" en una fecha
    return [comoTexto(`${MESES[Number(mes.slice(5, 7)) - 1]} ${mes.slice(0, 4)}`), act, del.length - act];
  })));

  const personas = new Set(activas.map(r => (r.email || '').toLowerCase() || (r.celular || '').replace(/\D/g, '')).filter(Boolean));
  bloques.push([
    ['Personas distintas con reservas activas', personas.size],
    ['Reservas de prioridad (activas)', contar(activas, r => r.prioridad)]
  ]);
  return bloques;
}

// ---------- Escritura en la planilla ----------
function obtenerHoja_(ss, nombre, posicion) {
  let hoja = ss.getSheetByName(nombre);
  if (!hoja) {
    hoja = ss.insertSheet(nombre, posicion);
  }
  return hoja;
}

function escribirReservas_(hoja, reservas) {
  const fechaDesdeTexto = f => Utilities.parseDate(f, ZONA, 'yyyy-MM-dd');
  const fechaHoraDesdeIso = iso => new Date(iso);
  const filas = [COLUMNAS].concat(armarFilasReservas(reservas, fechaDesdeTexto, fechaHoraDesdeIso));

  const filtro = hoja.getFilter();
  if (filtro) filtro.remove();
  hoja.clear();
  const filasDatos = Math.max(filas.length - 1, 1);
  hoja.getRange(2, COL_FECHA, filasDatos, 1).setNumberFormat('dd/mm/yyyy');
  COL_FECHA_HORA.forEach(c => hoja.getRange(2, c, filasDatos, 1).setNumberFormat('dd/mm/yyyy hh:mm'));

  hoja.getRange(1, 1, filas.length, COLUMNAS.length).setValues(filas);
  hoja.getRange(1, 1, 1, COLUMNAS.length).setFontWeight('bold').setBackground('#1F3A68').setFontColor('#FFFFFF');
  hoja.setFrozenRows(1);
  hoja.getRange(1, 1, filas.length, COLUMNAS.length).createFilter();
  hoja.autoResizeColumns(1, COLUMNAS.length);
}

// Una pestaña por mes, con el mismo formato que "Reservas"
function escribirMeses_(ss, reservas) {
  const porMes = {};
  reservas.forEach(r => {
    const clave = r.fecha.slice(0, 7);
    (porMes[clave] = porMes[clave] || []).push(r);
  });
  const nombreHojaMes = clave => `${MESES[Number(clave.slice(5, 7)) - 1]} ${clave.slice(0, 4)}`;
  const claves = Object.keys(porMes).sort(); // del más viejo al más nuevo
  const nombres = claves.map(nombreHojaMes);

  // Meses que ya no tienen reservas (por ejemplo, porque se eliminaron)
  ss.getSheets()
    .filter(h => PATRON_HOJA_MES.test(h.getName()) && nombres.indexOf(h.getName()) === -1)
    .forEach(h => ss.deleteSheet(h));

  claves.forEach(clave => {
    const hoja = ss.getSheetByName(nombreHojaMes(clave)) || ss.insertSheet(nombreHojaMes(clave));
    escribirReservas_(hoja, porMes[clave]);
  });
  ordenarHojas_(ss);
}

// Orden fijo de las pestañas: Resumen, Reservas, los meses del más nuevo al más viejo y al final
// lo demás (las copias). Solo mueve si hace falta (cuando aparece un mes nuevo).
function ordenarHojas_(ss) {
  const hojas = ss.getSheets();
  const nombres = hojas.map(h => h.getName());
  const claveMes = nombre => nombre.split(' ')[1] + '-' + String(MESES.indexOf(nombre.split(' ')[0]) + 1).padStart(2, '0');
  const meses = nombres.filter(n => PATRON_HOJA_MES.test(n)).sort((a, b) => claveMes(b).localeCompare(claveMes(a)));
  const fijas = [HOJA_RESUMEN, HOJA_RESERVAS].filter(n => nombres.indexOf(n) !== -1);
  const orden = fijas.concat(meses, nombres.filter(n => fijas.indexOf(n) === -1 && meses.indexOf(n) === -1));
  if (orden.every((n, i) => n === nombres[i])) return;
  // moveActiveSheet cuenta desde 1. Se ubican de a una, de la primera a la última.
  orden.forEach((n, i) => {
    ss.setActiveSheet(ss.getSheetByName(n));
    ss.moveActiveSheet(i + 1);
  });
  ss.setActiveSheet(ss.getSheetByName(orden[0]));
}

function escribirResumen_(hoja, datos) {
  hoja.clear();
  hoja.getRange('A1:B3').setValues([
    ['Reservas del CEQ', ''],
    ['Última actualización', comoTexto(ahoraTexto_())],
    ['Estado', `OK: ${datos.reservas.length} reservas en la base`]
  ]);
  hoja.getRange('A1').setFontWeight('bold').setFontSize(14);
  let fila = 5;
  armarResumen(datos.reservas).forEach(bloque => {
    const ancho = Math.max.apply(null, bloque.map(f => f.length));
    const valores = bloque.map(f => f.concat(Array(ancho - f.length).fill('')));
    hoja.getRange(fila, 1, valores.length, ancho).setValues(valores);
    hoja.getRange(fila, 1, 1, ancho).setFontWeight('bold').setBackground('#E6EBF2');
    fila += valores.length + 1;
  });
  hoja.autoResizeColumns(1, 4);
}

function guardarCopiaMensual_(ss, hoja) {
  const nombre = PREFIJO_COPIA + Utilities.formatDate(new Date(), ZONA, 'yyyy-MM');
  if (!ss.getSheetByName(nombre)) {
    hoja.copyTo(ss).setName(nombre); // la copia queda al final, después de las demás hojas
  }
  const copias = ss.getSheets().filter(h => h.getName().indexOf(PREFIJO_COPIA) === 0)
    .sort((a, b) => a.getName() < b.getName() ? -1 : 1);
  copias.slice(0, Math.max(copias.length - COPIAS_A_CONSERVAR, 0)).forEach(h => ss.deleteSheet(h));
}

// La hoja vacía que trae toda planilla nueva ("Hoja 1"), si sigue vacía
function borrarHojaVaciaInicial_(ss) {
  ['Hoja 1', 'Hoja1', 'Sheet1'].forEach(nombre => {
    const hoja = ss.getSheetByName(nombre);
    if (hoja && hoja.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(hoja);
  });
}

function ahoraTexto_() {
  return Utilities.formatDate(new Date(), ZONA, 'dd/MM/yyyy HH:mm');
}
