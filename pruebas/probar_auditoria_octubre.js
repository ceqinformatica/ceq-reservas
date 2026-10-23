// Prueba los arreglos de la auditoría del 23/10/2026: topes de correos contados en la base y lista de
// espera solo con el mes lleno (AUD-01, AUD-17), tope total de intentos de inicio de sesión (AUD-02),
// lecturas públicas sin días de meses anteriores y con parámetros validados (AUD-03, AUD-13), el
// código de cancelación fuera del aviso interno y de la respuesta (AUD-04) y el historial que dice
// quién canceló (AUD-08). Con el server.js real, Supabase simulado y Brevo interceptado.
// Uso: node probar_auditoria_octubre.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const bcrypt = require(require.resolve('bcryptjs', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-aud-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-aud-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const hasta = async (condicion, ms = 6000) => { for (let i = 0; i < ms / 100 && !condicion(); i++) await esperar(100); return condicion(); };
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const ahoraFalso = () => Date.now() + desfase;
const SECRETO = 'secreto-auditoria-octubre';
const CLAVE_ADMIN = 'clave-de-prueba-local';

const reserva = (extra = {}) => ({
  espacio_id: 3, nombre_solicitante: 'Persona', contacto: '0981 000 000 | persona@example.com', fecha: '2026-11-18', hora_inicio: '07:00:00', hora_fin: '10:00:00',
  estado: 'activa', motivo: 'Actividad Personal', codigo_cancelacion_hash: 'x', reservado_por_admin: false, acompanantes: [], asistencia: null,
  created_at: '2026-11-01T12:00:00', cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, recordatorio_enviado_en: null, ...extra
});
const db = {
  reservas: [
    reserva({ id: 501, nombre_solicitante: 'Octubre Pasado', motivo: 'Algo privado', fecha: '2026-10-20' }),
    reserva({ id: 502, nombre_solicitante: 'Noviembre Actual', fecha: '2026-11-18' }),
    reserva({ id: 503, nombre_solicitante: 'Para Moderador', fecha: '2026-11-25', contacto: '0981 000 503 | mod@example.com' }),
    reserva({ id: 504, nombre_solicitante: 'Para Supremo', fecha: '2026-11-26', contacto: '0981 000 504 | sup@example.com' })
  ],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }, { clave: 'email_alertas', valor: 'alertas@example.com' }],
  registro_actividad: [], reportes_errores: [], bloqueos: [], lista_espera: [], correos_pendientes: []
};
const mini = crearMiniPostgrest(db, {
  unicas: { configuracion: [['clave']], lista_espera: [['espacio_id', 'email', 'mes']] },
  porDefecto: {
    reservas: () => ({ created_at: new Date(ahoraFalso()).toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false, cancelada_en: null, cancelada_por: null, motivo_cancelacion: null }),
    registro_actividad: () => ({ creado_en: new Date(ahoraFalso()).toISOString() }),
    reportes_errores: () => ({ created_at: new Date(ahoraFalso()).toISOString().replace('Z', ''), estado: 'nuevo', nota: null }),
    lista_espera: () => ({ creado_en: new Date(ahoraFalso()).toISOString(), avisado_en: null }),
    correos_pendientes: () => ({ intentos: 0, reclamado_hasta: null, ultimo_error: null, enviado_en: null })
  }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3980', SUPABASE_URL: 'http://127.0.0.1:54336', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(CLAVE_ADMIN, 4), EMAIL_MODERADOR: 'moderador@example.com', EMAIL_MODERADOR_FRENTE: 'moderador@example.com',
      BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '1500', INTERVALO_COLA_CORREOS_MS: '300', NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3980';
let ipN = 1;
async function pedir(metodo, ruta, cuerpo, rol) {
  // Cada pedido sale de una IP distinta: así no lo frena el límite por IP y se ve el tope total
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.18.${Math.floor(ipN / 250)}.${ipN++ % 250 + 1}` };
  if (rol) {
    const ahora = Math.floor(ahoraFalso() / 1000);
    const token = jwt.sign({ adminId: 'admin', rol, v: 1, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
    Object.assign(headers, { cookie: `admin_token=${token}; csrf_token=csrf`, 'x-csrf-token': 'csrf' });
  }
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const texto = await res.text();
  let datos = {};
  try { datos = JSON.parse(texto); } catch (e) { datos = { texto }; }
  return { status: res.status, datos };
}
let celular = 200;
const reservar = (fecha, ini, fin, email) => pedir('POST', '/api/reservas', {
  espacio_id: 3, nombre_solicitante: 'Persona Prueba', contacto: `0985 ${celular++} 111 | ${email}`, fecha, hora_inicio: ini, hora_fin: fin, motivo: 'Actividad Personal'
});
const anotarse = (email, mes = '2026-11') => pedir('POST', '/api/lista-espera', { espacio_id: 3, email, nombre: 'Lola Espera', mes });
// Filas de correos ya mandados hoy (como las que deja la cola), para llegar a los topes
const correosDeHoy = (n, asunto = 'Correo anterior') => Array.from({ length: n }, (_, i) => ({
  id: 90000 + db.correos_pendientes.length + i, destinatarios: [], asunto, html: '', texto: null, responder_a: null, estado: 'enviado', intentos: 1,
  proximo_intento: new Date(ahoraFalso()).toISOString(), reclamado_hasta: null, ultimo_error: null, creado_en: new Date(ahoraFalso() - 60000).toISOString(), enviado_en: null
}));
// Bloquea en el Frente todo lo que queda de noviembre (en esta prueba no hay otros bloqueos)
const bloquearNoviembre = () => {
  for (let d = 16; d <= 30; d++) db.bloqueos.push({ id: 8000 + d, espacio_id: 3, fecha: `2026-11-${d}`, hora_inicio: '00:00:00', hora_fin: '23:59:00', motivo: 'Mes lleno (prueba)', lote: null });
};
const desbloquear = () => db.bloqueos.splice(0, db.bloqueos.length);
const quitarBloqueoDel = fecha => db.bloqueos.splice(db.bloqueos.findIndex(b => b.fecha === fecha), 1);
const quitar = (tabla, filas) => { const fuera = new Set(filas); db[tabla] = db[tabla].filter(f => !fuera.has(f)); };

(async () => {
  await new Promise(ok => mini.servidor.listen(54336, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  const hijo = await arrancar();
  await esperar(800);

  // ===== AUD-03 y AUD-13: lecturas públicas =====
  let r = await pedir('GET', '/api/reservas?fecha=2026-10-20');
  anotar('AUD-03: un día de un mes anterior no devuelve nombres ni motivos (lista vacía)', r.status === 200 && Array.isArray(r.datos) && r.datos.length === 0, JSON.stringify(r.datos));
  r = await pedir('GET', '/api/reservas?fecha=2026-11-18');
  anotar('...un día de este mes sí (para corroborar la propia reserva)', r.status === 200 && r.datos.length === 1 && r.datos[0].nombre_solicitante === 'Noviembre Actual' && r.datos[0].contacto === undefined, JSON.stringify(r.datos));
  r = await pedir('GET', '/api/reservas');
  anotar('...y sin parámetros, desde el día 1 del mes (sin octubre)', r.status === 200 && !r.datos.some(x => x.fecha === '2026-10-20') && r.datos.some(x => x.fecha === '2026-11-18'), JSON.stringify(r.datos.map(x => x.fecha)));
  const malas = [await pedir('GET', '/api/reservas?fecha=abc'), await pedir('GET', '/api/reservas?fecha=2026-02-30'), await pedir('GET', '/api/reservas?espacio_id=x'),
    await pedir('GET', '/api/reservas?espacio_id=3abc'), await pedir('GET', '/api/reservas?fecha=2026-11-18&fecha=2026-11-19')];
  anotar('AUD-13: fecha o espacio inválidos responden 400 (no 500 ni alerta)', malas.every(m => m.status === 400), malas.map(m => `${m.status} ${m.datos.error}`).join(' ; '));
  r = await pedir('GET', '/api/reservas?espacio_id=3&fecha=2026-11-18');
  anotar('...y los válidos siguen andando', r.status === 200 && r.datos.length === 1, JSON.stringify(r.datos));

  // ===== AUD-04: el código no va en el aviso interno ni en la respuesta =====
  const antesReserva = correos().length;
  r = await reservar('2026-11-19', '07:00', '10:00', 'nueva@example.com');
  await hasta(() => correos().slice(antesReserva).length >= 2);
  const confirmacion = correos().slice(antesReserva).find(c => c.to[0].email === 'nueva@example.com');
  const avisoInterno = correos().slice(antesReserva).find(c => c.to[0].email === 'moderador@example.com');
  anotar('AUD-04: la respuesta no trae el código ni el contacto, solo el número y el horario', r.status === 201 && r.datos.codigo === undefined &&
    JSON.stringify(Object.keys(r.datos.reserva).sort()) === '["espacio_id","fecha","hora_fin","hora_inicio","id"]', JSON.stringify(r.datos));
  anotar('...la persona sigue recibiendo su código en la confirmación', confirmacion && /Código de cancelación:<\/strong> [0-9A-F]{16}/.test(confirmacion.htmlContent), confirmacion && confirmacion.subject);
  anotar('...y el aviso a los moderadores trae el contacto pero no el código', avisoInterno && avisoInterno.htmlContent.includes('nueva@example.com') &&
    !/Código/.test(avisoInterno.htmlContent) && !(confirmacion && avisoInterno.htmlContent.includes(confirmacion.htmlContent.match(/Código de cancelación:<\/strong> ([0-9A-F]{16})/)[1])),
    avisoInterno && avisoInterno.htmlContent.slice(0, 300));
  r = await pedir('POST', '/api/superadmin/plantillas/vista-previa', { clave: 'aviso_nueva', espacio_id: 3 }, 'superadmin');
  anotar('...la vista previa del aviso interno tampoco muestra un código', r.status === 200 && !/Código/.test(r.datos.html) && !r.datos.html.includes('A1B2C3D4E5F60789'), `${r.status} ${r.datos.error || ''}`);

  // ===== AUD-01: lista de espera =====
  r = await anotarse('con-lugar@example.com');
  await esperar(800);
  anotar('AUD-01: con lugares libres en el mes no se anota (409) ni le llega ningún correo', r.status === 409 && db.lista_espera.length === 0 &&
    !correos().some(c => c.to[0].email === 'con-lugar@example.com'), `${r.status} ${r.datos.error}`);
  bloquearNoviembre();
  r = await anotarse('lola@example.com');
  await hasta(() => correos().some(c => c.to[0].email === 'lola@example.com'));
  anotar('...con el mes lleno sí (201) y llega la confirmación', r.status === 201 && correos().filter(c => c.to[0].email === 'lola@example.com').length === 1, `${r.status} ${r.datos.error || r.datos.mensaje}`);
  for (let i = 0; i < 5; i++) await anotarse('lola@example.com');
  await esperar(800);
  anotar('...anotarse 5 veces más con el mismo correo no manda más correos (sigue 1)', correos().filter(c => c.to[0].email === 'lola@example.com').length === 1 && db.lista_espera.length === 1,
    `${correos().filter(c => c.to[0].email === 'lola@example.com').length} correos`);
  // Si queda un solo día con lugar (27/11), el mes no está lleno: no corresponde anotarse
  quitarBloqueoDel('2026-11-27');
  db.bloqueos.push({ id: 8101, espacio_id: 3, fecha: '2026-11-27', hora_inicio: '07:00:00', hora_fin: '13:00:00', motivo: 'x', lote: null });
  r = await anotarse('otra@example.com');
  anotar('...si queda un solo turno libre en el mes (Merienda del 27/11), tampoco (409)', r.status === 409, `${r.status} ${r.datos.error}`);
  db.bloqueos.push({ id: 8102, espacio_id: 3, fecha: '2026-11-27', hora_inicio: '14:00:00', hora_fin: '18:00:00', motivo: 'x', lote: null });
  // Hoy (16/11, 10:00) ya empezaron el Desayuno y el Almuerzo: si solo quedan esos, el mes está lleno
  quitarBloqueoDel('2026-11-16');
  db.bloqueos.push({ id: 8103, espacio_id: 3, fecha: '2026-11-16', hora_inicio: '14:00:00', hora_fin: '18:00:00', motivo: 'x', lote: null });
  r = await anotarse('turnos-pasados@example.com');
  anotar('...los turnos de hoy que ya empezaron no cuentan como lugar libre (201)', r.status === 201, `${r.status} ${r.datos.error || ''}`);

  // Tope diario de inscripciones, contado en la base
  const inscriptosHoy = Array.from({ length: 60 }, (_, i) => ({ id: 9500 + i, espacio_id: 1, email: `hoy${i}@example.com`, nombre: 'Ya Anotado', mes: '2026-11', creado_en: new Date(ahoraFalso() - 3600000).toISOString(), avisado_en: null }));
  db.lista_espera.push(...inscriptosHoy);
  r = await anotarse('tope@example.com');
  anotar('AUD-17: con 60 inscripciones hoy (contadas en la base), la siguiente no se anota (503)', r.status === 503 && !db.lista_espera.some(f => f.email === 'tope@example.com'), `${r.status} ${r.datos.error}`);
  quitar('lista_espera', inscriptosHoy);

  // Tope de los correos que no son de una reserva
  const hoy250 = correosDeHoy(250);
  db.correos_pendientes.push(...hoy250);
  r = await anotarse('sin-lugar@example.com');
  anotar('Con 250 correos en el día: la lista de espera no anota más (503)', r.status === 503, `${r.status} ${r.datos.error}`);
  const antesReporte = correos().length;
  r = await pedir('POST', '/api/reportes', { mensaje: 'Reporte con el cupo de correos lleno' });
  await esperar(800);
  anotar('...el reporte se guarda (201) pero no se manda el aviso', r.status === 201 && db.reportes_errores.length === 1 && !correos().slice(antesReporte).some(c => /reporte/i.test(c.subject)), `${r.status}`);
  r = await pedir('POST', '/api/superadmin/plantillas/prueba', { clave: 'recordatorio', espacio_id: 3 }, 'superadmin');
  anotar('...la prueba de correo del panel se frena (429)', r.status === 429 && /confirmaciones/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  const antesEsencial = correos().length;
  desbloquear();
  r = await reservar('2026-11-20', '07:00', '10:00', 'esencial@example.com');
  await hasta(() => correos().slice(antesEsencial).some(c => c.to[0].email === 'esencial@example.com'));
  anotar('...pero las confirmaciones de las reservas siguen saliendo', r.status === 201 && correos().slice(antesEsencial).some(c => c.to[0].email === 'esencial@example.com'), String(r.status));
  // Una cancelación con el cupo lleno: no se avisa a la lista de espera y la inscripción sigue pendiente
  const antesCancelar = correos().length;
  r = await pedir('POST', '/api/admin/cancelar/502', { motivo: 'Prueba' }, 'admin');
  await esperar(1200);
  anotar('...y con el cupo lleno, una cancelación no avisa a la lista de espera (siguen pendientes)', r.status === 200 && !correos().slice(antesCancelar).some(c => c.subject.startsWith('Se liberó un lugar')) &&
    db.lista_espera.filter(f => f.espacio_id === 3).every(f => !f.avisado_en), `${r.status} ${db.lista_espera.map(f => f.avisado_en).join()}`);
  quitar('correos_pendientes', hoy250);

  // Tope de avisos de la lista de espera, contado en la base
  const avisadosHoy = Array.from({ length: 60 }, (_, i) => ({ id: 9700 + i, espacio_id: 1, email: `avisado${i}@example.com`, nombre: 'Ya Avisado', mes: '2026-11', creado_en: new Date(ahoraFalso() - 7200000).toISOString(), avisado_en: new Date(ahoraFalso() - 3600000).toISOString() }));
  db.lista_espera.push(...avisadosHoy);
  const antesAvisos = correos().length;
  r = await pedir('POST', '/api/admin/cancelar/503', { motivo: 'Prueba' }, 'admin');
  await esperar(1200);
  anotar('AUD-17: con 60 avisos hoy (contados en la base), otra cancelación no avisa a nadie más', r.status === 200 && !correos().slice(antesAvisos).some(c => c.subject.startsWith('Se liberó un lugar')), String(r.status));
  quitar('lista_espera', avisadosHoy);
  const antesAvisos2 = correos().length;
  r = await pedir('POST', '/api/admin/cancelar/504', { motivo: 'Prueba' }, 'superadmin');
  await hasta(() => correos().slice(antesAvisos2).some(c => c.subject.startsWith('Se liberó un lugar')));
  anotar('...sin esos avisos previos, la siguiente cancelación avisa a los anotados', r.status === 200 && correos().slice(antesAvisos2).filter(c => c.subject.startsWith('Se liberó un lugar')).length >= 1, String(r.status));

  // Tope de pruebas de correo contado en la cola
  const pruebasHoy = correosDeHoy(30, '[PRUEBA] Algo');
  db.correos_pendientes.push(...pruebasHoy);
  r = await pedir('POST', '/api/superadmin/plantillas/prueba', { clave: 'recordatorio', espacio_id: 3 }, 'superadmin');
  anotar('AUD-17: con 30 pruebas hoy en la cola, la siguiente se frena (429)', r.status === 429 && /30 pruebas/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  quitar('correos_pendientes', pruebasHoy);
  r = await pedir('POST', '/api/superadmin/plantillas/prueba', { clave: 'recordatorio', espacio_id: 3 }, 'superadmin');
  anotar('...y sin ellas, la prueba sale', r.status === 200, `${r.status} ${r.datos.error || ''}`);

  // ===== AUD-08: el historial dice quién canceló =====
  const historial = async id => ((await pedir('GET', `/api/superadmin/reservas/${id}/historial`, null, 'superadmin')).datos.eventos || []).map(e => e.que).join(' | ');
  const h503 = await historial(503), h504 = await historial(504);
  anotar('AUD-08: una cancelación de un moderador figura como "Cancelada por un moderador"', /Cancelada por un moderador \(motivo: Prueba\)/.test(h503), h503);
  anotar('...y una del admin supremo, como "Cancelada por el admin supremo"', /Cancelada por el admin supremo/.test(h504), h504);
  db.reservas.push(reserva({ id: 600, estado: 'cancelada', cancelada_en: '2026-11-10T12:00:00Z', cancelada_por: 'usuario' }));
  const h505 = await historial(600);
  anotar('...la que canceló la persona, "Cancelada por la persona"', /Cancelada por la persona/.test(h505), h505);

  // ===== AUD-09: cambiar el contacto de una reserva anula el código y el enlace viejos =====
  const codigoDe = c => ((c && c.htmlContent.match(/Código de cancelación:<\/strong> ([0-9A-F]{16})/)) || [])[1];
  const enlaceDe = c => { const m = c && c.htmlContent.match(/cancelar\.html\?r=(\d+)&(?:amp;)?t=([\w-]{32})/); return m ? { r: m[1], t: m[2] } : null; };
  const antesEditar = correos().length;
  r = await reservar('2026-11-24', '07:00', '10:00', 'equivocado@example.com');
  const idEditar = r.datos.reserva && r.datos.reserva.id;
  await hasta(() => correos().slice(antesEditar).some(c => c.to[0].email === 'equivocado@example.com'));
  const confVieja = correos().slice(antesEditar).find(c => c.to[0].email === 'equivocado@example.com');
  const codigoViejo = codigoDe(confVieja), enlaceViejo = enlaceDe(confVieja);
  let consulta = await pedir('GET', `/api/cancelar-por-enlace?r=${enlaceViejo && enlaceViejo.r}&t=${enlaceViejo && enlaceViejo.t}`);
  anotar('AUD-09: el enlace del correo de confirmación sirve', r.status === 201 && !!codigoViejo && consulta.status === 200 && consulta.datos.se_puede_cancelar === true, `${r.status} ${consulta.status}`);
  r = await pedir('PUT', `/api/superadmin/reservas/${idEditar}`, { email: 'correcto@example.com', avisar: false }, 'superadmin');
  await hasta(() => correos().some(c => c.to[0].email === 'correcto@example.com'));
  const avisoNuevo = correos().find(c => c.to[0].email === 'correcto@example.com');
  const codigoNuevo = codigoDe(avisoNuevo), enlaceNuevo = enlaceDe(avisoNuevo);
  anotar('...al corregir el correo se manda un código nuevo al correo nuevo (aunque se pida no avisar)', r.status === 200 && !!codigoNuevo && codigoNuevo !== codigoViejo && !!enlaceNuevo,
    `${r.status} ${r.datos.error || r.datos.mensaje} ${avisoNuevo && avisoNuevo.subject}`);
  consulta = await pedir('POST', '/api/cancelar-por-codigo/consultar', { codigo: codigoViejo });
  const consultaEnlace = await pedir('GET', `/api/cancelar-por-enlace?r=${enlaceViejo.r}&t=${enlaceViejo.t}`);
  anotar('...el código viejo ya no encuentra la reserva y el enlace viejo no sirve (404)', consulta.status === 404 && consultaEnlace.status === 404, `${consulta.status} ${consultaEnlace.status}`);
  consulta = await pedir('GET', `/api/cancelar-por-enlace?r=${enlaceNuevo.r}&t=${enlaceNuevo.t}`);
  const consultaCodigo = await pedir('POST', '/api/cancelar-por-codigo/consultar', { codigo: codigoNuevo });
  anotar('...el código y el enlace nuevos sí', consulta.status === 200 && consultaCodigo.status === 200 && consultaCodigo.datos.se_puede_cancelar === true, `${consulta.status} ${consultaCodigo.status}`);
  r = await pedir('PUT', `/api/superadmin/reservas/${idEditar}`, { nombre_solicitante: 'Nombre Corregido' }, 'superadmin');
  consulta = await pedir('POST', '/api/cancelar-por-codigo/consultar', { codigo: codigoNuevo });
  anotar('...cambiar solo el nombre no cambia el código', r.status === 200 && consulta.status === 200, `${r.status} ${consulta.status}`);
  // Enlaces del formato viejo (solo el número): sirven para las reservas de antes del cambio
  const crypto = require('crypto');
  const firmaVieja = id => crypto.createHmac('sha256', crypto.createHmac('sha256', SECRETO).update('enlaces-de-cancelacion-v1').digest()).update(`cancelar:${id}`).digest('base64url').slice(0, 32);
  db.reservas.push(reserva({ id: 610, fecha: '2026-11-27', created_at: '2026-10-20T12:00:00' }));
  consulta = await pedir('GET', `/api/cancelar-por-enlace?r=610&t=${firmaVieja(610)}`);
  const conFirmaVieja = await pedir('GET', `/api/cancelar-por-enlace?r=${idEditar}&t=${firmaVieja(idEditar)}`);
  anotar('...un enlace viejo de una reserva de antes del cambio sigue sirviendo; para una reserva nueva, no', consulta.status === 200 && conFirmaVieja.status === 404, `${consulta.status} ${conFirmaVieja.status}`);

  // ===== AUD-12: comodín de los acompañantes por espacio para los textos legales =====
  r = await pedir('GET', '/api/superadmin/legal', null, 'superadmin');
  const comodin = (r.datos.comodines || []).find(c => c.clave === 'acompanantes_por_espacio');
  anotar('AUD-12: el comodín {acompanantes_por_espacio} dice en qué espacios y cuántos (por defecto, solo el Altillo, hasta 4)',
    r.status === 200 && comodin && comodin.valor === 'solo en el Altillo, hasta cuatro (4) por Reserva', JSON.stringify(comodin));
  const priv = r.datos.documentos && r.datos.documentos.privacidad;
  r = await pedir('POST', '/api/superadmin/legal/vista-previa', { doc: 'privacidad', intro: 'Acompañantes: {acompanantes_por_espacio}.', articulos: priv.articulos, plantillas: priv.plantillas }, 'superadmin');
  anotar('...y se puede usar en el texto (la vista previa lo completa)', r.status === 200 && JSON.stringify(r.datos).includes('solo en el Altillo, hasta cuatro (4) por Reserva'), `${r.status} ${r.datos.error || ''}`);

  // ===== AUD-02: tope total de intentos fallidos =====
  // 9 fallidos de hace un rato: el 10.º (desde otra IP) dispara la alerta
  const viejos = Array.from({ length: 30 }, (_, i) => ({ id: 9900 + i, rol: '-', accion: 'Intento de inicio de sesión fallido', detalle: '', creado_en: new Date(ahoraFalso() - 2 * 3600000).toISOString() }));
  db.registro_actividad.push(...viejos);
  r = await pedir('POST', '/api/login', { password: CLAVE_ADMIN });
  anotar('AUD-02: 30 intentos fallidos de hace más de una hora no cuentan (se entra)', r.status === 200, `${r.status} ${r.datos.error || ''}`);
  quitar('registro_actividad', viejos);
  const recientes = Array.from({ length: 9 }, (_, i) => ({ id: 9950 + i, rol: '-', accion: 'Intento de inicio de sesión fallido', detalle: '', creado_en: new Date(ahoraFalso() - 600000).toISOString() }));
  db.registro_actividad.push(...recientes);
  r = await pedir('POST', '/api/login', { password: 'equivocada' });
  anotar('...el 10.º fallido de la hora responde 401', r.status === 401, String(r.status));
  await hasta(() => correos().some(c => c.to[0].email === 'alertas@example.com' && c.htmlContent.includes('intentos de inicio de sesión fallidos')), 8000);
  anotar('...y manda una alerta por correo', correos().some(c => c.to[0].email === 'alertas@example.com' && c.htmlContent.includes('10 intentos de inicio de sesión fallidos')),
    correos().filter(c => c.to[0].email === 'alertas@example.com').map(c => c.subject).join(' | '));
  for (let i = 0; i < 20; i++) await pedir('POST', '/api/login', { password: 'equivocada' + i });
  const fallidos = db.registro_actividad.filter(a => a.accion === 'Intento de inicio de sesión fallido').length;
  r = await pedir('POST', '/api/login', { password: CLAVE_ADMIN });
  anotar('...con 30 fallidos en la hora (cada uno desde otra IP), ni la contraseña correcta entra (429)', fallidos === 30 && r.status === 429 && /cerrado/.test(r.datos.error), `${fallidos} fallidos, ${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/login', { password: 'otra-equivocada' });
  anotar('...y mientras está cerrado no se prueban más contraseñas (no se anotan más fallidos)', r.status === 429 && db.registro_actividad.filter(a => a.accion === 'Intento de inicio de sesión fallido').length === 30, String(r.status));
  // Pasa la hora: se vuelve a poder entrar
  ponerHora('2026-11-16T14:05:00Z');
  await esperar(1500); // el reloj falso del servidor lee el archivo cada tanto
  r = await pedir('POST', '/api/login', { password: CLAVE_ADMIN });
  anotar('...pasada la hora se vuelve a entrar', r.status === 200, `${r.status} ${r.datos.error || ''}`);

  hijo.kill(); mini.servidor.close();
  fs.unlinkSync(brevoLog); fs.unlinkSync(relojArchivo);
  let ok = 0;
  for (const x of resultados) { console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + String(x.detalle).slice(0, 400)}`); if (x.ok) ok++; }
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
