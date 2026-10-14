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
 *     "Reservas" (copia de seguridad). Se borra a los 6 meses y, mientras tanto, las reservas
 *     que pasan ese plazo quedan sin nombre, acompañantes ni motivo libre (Política de Privacidad).
 *
 * La clave NO se escribe en este código: se guarda con el menú "Reservas CEQ > Guardar clave".
 * No trae celulares, correos ni datos de cancelación (esos se ven en el panel y en el Excel del
 * panel). Igual tiene nombres: compartila solo con quienes administran el sistema.
 */

const URL_RESERVAS = 'https://api.ceq-una.com/api/sincronizacion/reservas';
const ZONA = 'America/Asuncion';
const HOJA_RESERVAS = 'Reservas';
const HOJA_RESUMEN = 'Resumen';
const PREFIJO_COPIA = 'Copia ';
// Plazo de la Política de Privacidad: las copias de más de 6 meses se borran, y en las demás se
// borran los datos de las reservas que ya pasaron ese plazo
const MESES_CONSERVACION = 6;
const NOMBRE_ANONIMIZADO = '(datos eliminados)';
// Los motivos del Frente son categorías (no datos personales): se conservan, como en el servidor
const MOTIVOS_FRENTE = ['Actividad Personal', 'Recaudación - Asociación Estudiantil', 'Recaudación - Secretaría CEQ',
  'Recaudación - Padrinaje', 'Recaudación - Congreso o Evento Académico'];
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const PATRON_HOJA_MES = new RegExp('^(' + MESES.join('|') + ') \\d{4}$'); // "Octubre 2026"
// Sin celulares, correos, prioridad ni datos de cancelación (no se muestran en la planilla)
const COLUMNAS = ['N°', 'Fecha', 'Día', 'Espacio', 'Turno', 'Inicio', 'Fin', 'Nombre', 'Motivo',
  'Acompañantes', 'Estado', 'Asistencia', 'Creada'];
const COL_FECHA = 2;
const COL_FECHA_HORA = [13];
// Columnas de versiones anteriores que se borran de las copias mensuales ya guardadas
const COLUMNAS_QUITADAS = ['Celular', 'Email', 'Prioridad', 'Cancelada', 'Cancelada por', 'Motivo de cancelación'];

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
    comoTexto(r.motivo),
    comoTexto(r.acompanantes), // solo nombres: "Ana Pérez, Luis Gómez" (vacío si no hay)
    r.estado === 'cancelada' ? 'Cancelada' : 'Activa',
    r.asistencia === 'vino' ? 'Vino' : r.asistencia === 'no_vino' ? 'No vino' : '',
    r.creada_en ? fechaHoraDesdeIso(r.creada_en) : ''
  ]);
}

// Lo que escribe la gente nunca se interpreta como fórmula ni como número. La comilla inicial
// no se ve en la celda.
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

  // Los turnos salen de los datos (se pueden cambiar desde el panel), ordenados por hora
  const frente = activas.filter(r => r.espacio === 'Frente');
  if (frente.length > 0) {
    const turnos = [];
    frente.slice().sort((a, b) => a.hora_inicio < b.hora_inicio ? -1 : 1).forEach(r => {
      if (r.turno && turnos.indexOf(r.turno) === -1) turnos.push(r.turno);
    });
    const filas = turnos.map(t => [t, contar(frente, r => r.turno === t)]);
    const otros = contar(frente, r => !r.turno);
    if (otros > 0) filas.push(['Otro horario (turnos anteriores)', otros]);
    bloques.push([['Frente por turno (activas)', 'Reservas']].concat(filas));
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

  // `persona` es un código anónimo que manda el servidor (mismo correo o celular = mismo código)
  const personas = new Set(activas.map(r => r.persona).filter(Boolean));
  bloques.push([
    ['Personas distintas con reservas activas', personas.size],
    ['Asistencia marcada: vinieron', contar(activas, r => r.asistencia === 'vino')],
    ['Asistencia marcada: no vinieron', contar(activas, r => r.asistencia === 'no_vino')]
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
  // Política de Privacidad: los datos se guardan como máximo 6 meses (CEQ-09). Se borran las
  // copias de hace más de 6 meses (por su fecha, no por cantidad) y, en las que quedan, se borran
  // los datos personales de las reservas que ya pasaron ese plazo (igual que hace el servidor).
  const limite = fechaLimiteConservacion_();
  const mesLimite = limite.slice(0, 7);
  ss.getSheets().filter(h => h.getName().indexOf(PREFIJO_COPIA) === 0).forEach(h => {
    const mes = h.getName().slice(PREFIJO_COPIA.length);
    if (/^\d{4}-\d{2}$/.test(mes) && mes < mesLimite) ss.deleteSheet(h);
    else {
      limpiarCopiaVieja_(h);
      anonimizarCopia_(h, limite);
    }
  });
}

// "AAAA-MM-DD" de hoy menos MESES_CONSERVACION meses, en hora de Paraguay
function fechaLimiteConservacion_() {
  const [a, m, d] = Utilities.formatDate(new Date(), ZONA, 'yyyy-MM-dd').split('-').map(Number);
  const fecha = new Date(Date.UTC(a, m - 1 - MESES_CONSERVACION, d));
  return fecha.toISOString().slice(0, 10);
}

// En una copia guardada, las reservas con fecha anterior al límite quedan sin nombre, sin
// acompañantes y, si el motivo no es uno de la lista del Frente, sin motivo
function anonimizarCopia_(hoja, limite) {
  const ancho = hoja.getLastColumn();
  const filas = hoja.getLastRow() - 1;
  if (ancho === 0 || filas <= 0) return;
  const encabezado = hoja.getRange(1, 1, 1, ancho).getValues()[0];
  const col = n => encabezado.indexOf(n);
  const [cFecha, cNombre, cMotivo, cAcomp] = [col('Fecha'), col('Nombre'), col('Motivo'), col('Acompañantes')];
  if (cFecha === -1 || cNombre === -1) return;
  const rango = hoja.getRange(2, 1, filas, ancho);
  const valores = rango.getValues();
  let cambios = false;
  valores.forEach(f => {
    const esFecha = Object.prototype.toString.call(f[cFecha]) === '[object Date]';
    const fecha = esFecha ? Utilities.formatDate(f[cFecha], ZONA, 'yyyy-MM-dd') : textoAFechaIso_(f[cFecha]);
    if (!fecha || fecha >= limite || f[cNombre] === NOMBRE_ANONIMIZADO) return;
    f[cNombre] = NOMBRE_ANONIMIZADO;
    if (cAcomp !== -1) f[cAcomp] = '';
    if (cMotivo !== -1 && MOTIVOS_FRENTE.indexOf(String(f[cMotivo])) === -1) f[cMotivo] = '';
    cambios = true;
  });
  if (cambios) rango.setValues(valores);
}

// "16/11/2026" o "2026-11-16" -> "2026-11-16"; cualquier otra cosa -> ''
function textoAFechaIso_(valor) {
  const t = String(valor || '').replace(/^'/, '');
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

// Las copias guardadas con la versión anterior tenían celulares, correos y otros datos que ya no
// van: se borran esas columnas y se dejan solo los nombres de los acompañantes (sin el celular).
// En las copias nuevas no hay nada que hacer.
function limpiarCopiaVieja_(hoja) {
  const ancho = hoja.getLastColumn();
  if (ancho === 0) return;
  const encabezado = hoja.getRange(1, 1, 1, ancho).getValues()[0];
  for (let c = ancho; c >= 1; c--) {
    if (COLUMNAS_QUITADAS.indexOf(encabezado[c - 1]) !== -1) hoja.deleteColumn(c);
  }
  const nuevo = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  const colAcomp = nuevo.indexOf('Acompañantes') + 1;
  const filas = hoja.getLastRow() - 1;
  if (colAcomp > 0 && filas > 0) {
    const rango = hoja.getRange(2, colAcomp, filas, 1);
    const valores = rango.getValues();
    if (valores.some(f => /\(/.test(String(f[0])))) {
      rango.setValues(valores.map(f => [f[0] === '' ? '' : comoTexto(quitarCelulares(String(f[0])))]));
    }
  }
}

// "Ana Pérez (0981 111 222), Luis (0982 333 444)" -> "Ana Pérez, Luis"
function quitarCelulares(texto) {
  return texto.replace(/\s*\([^)]*\)/g, '');
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
