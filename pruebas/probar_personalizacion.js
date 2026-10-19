// Prueba la personalización del admin supremo (octubre 2026): reglas de cada espacio (días,
// plazo para cancelar, recordatorio, anticipación, límite por persona y normas), textos de la
// página con la cinta de anuncios, y las plantillas de los correos con "Enviarme una prueba".
// Con el server.js real, Supabase simulado, Brevo interceptado y un reloj falso.
// Uso: node probar_personalizacion.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-personalizacion-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-personalizacion-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const hasta = async (condicion, ms = 6000) => { for (let i = 0; i < ms / 100 && !condicion(); i++) await esperar(100); return condicion(); };
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const SECRETO = 'secreto-personalizacion';
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

const reserva = extra => ({ espacio_id: 3, hora_inicio: '07:00:00', hora_fin: '10:00:00', estado: 'activa', motivo: 'Actividad Personal',
  reservado_por_admin: false, acompanantes: [], asistencia: null, created_at: '2026-11-01T12:00:00', cancelada_en: null, cancelada_por: null,
  motivo_cancelacion: null, recordatorio_enviado_en: null, ...extra });
const db = {
  reservas: [
    reserva({ id: 901, nombre_solicitante: 'Frente Dos Días', contacto: '0981 000 001 | frente2@example.com', fecha: '2026-11-18', codigo_cancelacion_hash: sha('X1') }),
    reserva({ id: 902, espacio_id: 1, nombre_solicitante: 'Altillo Tres Días', contacto: '0981 000 002 | altillo3@example.com', fecha: '2026-11-19', hora_inicio: '08:00:00', hora_fin: '09:00:00', motivo: 'Estudiar', codigo_cancelacion_hash: sha('X2') }),
    reserva({ id: 903, espacio_id: 1, nombre_solicitante: 'Altillo Dos Días', contacto: '0981 000 003 | altillo2@example.com', fecha: '2026-11-18', hora_inicio: '08:00:00', hora_fin: '09:00:00', motivo: 'Estudiar', codigo_cancelacion_hash: sha('X3') })
  ],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }],
  registro_actividad: [], reportes_errores: [], bloqueos: [], lista_espera: [], correos_pendientes: []
};
const mini = crearMiniPostgrest(db, {
  unicas: { configuracion: [['clave']], lista_espera: [['espacio_id', 'email', 'mes']] },
  porDefecto: {
    reservas: () => ({ created_at: new Date(Date.now() + desfase).toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false }),
    registro_actividad: () => ({ creado_en: new Date(Date.now() + desfase).toISOString() }),
    correos_pendientes: () => ({ intentos: 0, creado_en: new Date(Date.now() + desfase).toISOString(), reclamado_hasta: null, ultimo_error: null, enviado_en: null }),
    lista_espera: () => ({ avisado_en: null })
  }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3983', SUPABASE_URL: 'http://127.0.0.1:54333', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '1000', INTERVALO_COLA_CORREOS_MS: '300',
      NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3983';
let ipN = 1;
async function pedir(metodo, ruta, cuerpo, rol) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ipN++ % 250}` };
  if (rol) {
    const ahora = Math.floor((Date.now() + desfase) / 1000);
    const token = jwt.sign({ adminId: 'admin', rol, v: 1, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
    Object.assign(headers, { cookie: `admin_token=${token}; csrf_token=csrf`, 'x-csrf-token': 'csrf' });
  }
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const texto = await res.text();
  let datos = {};
  try { datos = JSON.parse(texto); } catch (e) { datos = { texto }; }
  return { status: res.status, datos };
}
const delCorreo = email => correos().filter(c => c.to.some(t => t.email === email));
const reservar = (espacio, fecha, ini, fin, email, extra = {}) => pedir('POST', '/api/reservas', {
  espacio_id: espacio, nombre_solicitante: extra.nombre || 'Persona Prueba', contacto: `0985 ${String(ipN).padStart(3, '0')} 111 | ${email}`, fecha,
  hora_inicio: ini, hora_fin: fin, motivo: espacio === 3 ? 'Actividad Personal' : 'Estudiar', ...extra.cuerpo
});
const REGLAS_SIEMPRE = {
  3: { dias: [1, 2, 3, 4, 5], plazo_cancelacion_dias: 2, recordatorio: true, recordatorio_dias: 2, anticipacion_min_dias: 0, anticipacion_max_dias: 0, limite_por_persona_mes: 0, normas: '' },
  1: { dias: [1, 2, 3, 4, 5], plazo_cancelacion_dias: 0, recordatorio: true, recordatorio_dias: 2, anticipacion_min_dias: 0, anticipacion_max_dias: 0, limite_por_persona_mes: 0, normas: '' }
};

(async () => {
  await new Promise(ok => mini.servidor.listen(54333, '127.0.0.1', ok));
  ponerHora('2026-11-16T10:00:00Z'); // lunes 16/11/2026, 07:00 en Paraguay (antes de los recordatorios)
  const hijo = await arrancar();
  await esperar(800);

  // ===== Solo el admin supremo =====
  const prohibidas = [await pedir('GET', '/api/superadmin/personalizacion', null, 'admin'), await pedir('POST', '/api/superadmin/reglas', { reglas: REGLAS_SIEMPRE }, 'admin'),
    await pedir('POST', '/api/superadmin/textos', { textos: {} }, 'admin'), await pedir('POST', '/api/superadmin/plantillas', { clave: 'confirmacion', restaurar: true }, 'admin'),
    await pedir('POST', '/api/superadmin/plantillas/prueba', { clave: 'confirmacion' }, 'admin')];
  anotar('El admin común no puede usar la personalización (403)', prohibidas.every(p => p.status === 403), prohibidas.map(p => p.status).join(','));

  // ===== Sin nada guardado: los valores de siempre =====
  let conf = await pedir('GET', '/api/configuracion');
  anotar('Por defecto: lunes a viernes, Frente 2 días para cancelar y 2 por persona, Altillo sin plazo ni límite, textos de siempre y sin anuncio',
    conf.status === 200 && conf.datos.reglas['3'].dias.join() === '1,2,3,4,5' && conf.datos.reglas['3'].plazo_cancelacion_dias === 2 && conf.datos.reglas['3'].limite_por_persona_mes === 2 &&
    conf.datos.reglas['1'].plazo_cancelacion_dias === 0 && conf.datos.reglas['1'].limite_por_persona_mes === null && conf.datos.textos.titulo_inicio === 'Reserva de espacios' &&
    conf.datos.anuncio === null, JSON.stringify(conf.datos.reglas));
  let p = await pedir('GET', '/api/superadmin/personalizacion', null, 'superadmin');
  anotar('El editor recibe las reglas, los textos y las 9 plantillas con su texto original',
    p.status === 200 && Object.keys(p.datos.plantillas).length === 9 && p.datos.plantillas.confirmacion.defecto.titulo === '¡Reserva Confirmada!' &&
    p.datos.plantillas.lista_espera_aviso.obligatorios.join() === 'enlace_reservar' && p.datos.textos.lista_espera.comodines.join() === 'espacio,mes', `${p.status}`);

  // ===== Reglas inválidas =====
  const conReglas = cambio => ({ reglas: { 3: { ...REGLAS_SIEMPRE[3], ...(cambio[3] || {}) }, 1: { ...REGLAS_SIEMPRE[1], ...(cambio[1] || {}) } } });
  const malas = [
    await pedir('POST', '/api/superadmin/reglas', conReglas({ 3: { dias: [] } }), 'superadmin'),
    await pedir('POST', '/api/superadmin/reglas', conReglas({ 1: { anticipacion_min_dias: 5, anticipacion_max_dias: 3 } }), 'superadmin'),
    await pedir('POST', '/api/superadmin/reglas', conReglas({ 3: { plazo_cancelacion_dias: 20 } }), 'superadmin'),
    await pedir('POST', '/api/superadmin/reglas', conReglas({ 1: { normas: 'x'.repeat(1501) } }), 'superadmin'),
    await pedir('POST', '/api/superadmin/reglas', { ...conReglas({}), max_reservas_por_persona_mes: 0 }, 'superadmin')
  ];
  anotar('Reglas inválidas = 400 con el motivo (sin días, máxima < mínima, plazo de 20, normas largas, límite 0)',
    malas.every(m => m.status === 400 && m.datos.error), malas.map(m => `${m.status} ${m.datos.error}`).join(' | '));

  // ===== Reglas nuevas =====
  let r = await pedir('POST', '/api/superadmin/reglas', {
    ...conReglas({
      3: { plazo_cancelacion_dias: 3, recordatorio: false, anticipacion_min_dias: 2 },
      1: { dias: [1, 2, 3, 4, 5, 6], recordatorio_dias: 3, limite_por_persona_mes: 1, normas: 'No comer en el Altillo.\nDejarlo limpio y con la luz apagada.' }
    }), max_reservas_por_persona_mes: 3
  }, 'superadmin');
  conf = await pedir('GET', '/api/configuracion');
  anotar('Se guardan las reglas y la página las recibe', r.status === 200 && conf.datos.reglas['3'].plazo_cancelacion_dias === 3 && conf.datos.reglas['3'].limite_por_persona_mes === 3 &&
    conf.datos.max_reservas_por_persona_mes === 3 && conf.datos.reglas['1'].dias.join() === '1,2,3,4,5,6' && conf.datos.reglas['1'].limite_por_persona_mes === 1 &&
    conf.datos.reglas['1'].normas.startsWith('No comer'), `${r.status} ${r.datos.error || ''} ${JSON.stringify(conf.datos.reglas)}`);
  await esperar(300);
  const actReglas = db.registro_actividad.find(a => a.accion === 'Cambió las reglas de los espacios');
  anotar('...y queda en el registro de actividad qué se cambió', !!actReglas && /Frente: .*plazo para cancelar.*límite por persona \(3\)/.test(actReglas.detalle) && /Altillo: días/.test(actReglas.detalle), actReglas && actReglas.detalle);
  r = await pedir('POST', '/api/superadmin/reglas', { ...conReglas({ 3: { plazo_cancelacion_dias: 3, recordatorio: false, anticipacion_min_dias: 2 }, 1: { dias: [1, 2, 3, 4, 5, 6], recordatorio_dias: 3, limite_por_persona_mes: 1, normas: 'No comer en el Altillo.\nDejarlo limpio y con la luz apagada.' } }), max_reservas_por_persona_mes: 3 }, 'superadmin');
  anotar('Guardar lo mismo otra vez: "No había cambios"', r.status === 200 && r.datos.mensaje === 'No había cambios', JSON.stringify(r.datos));

  // ===== Las reglas se aplican al reservar =====
  r = await reservar(3, '2026-11-17', '07:00', '10:00', 'frente@example.com');
  anotar('Frente con anticipación mínima de 2 días: mañana no (400)', r.status === 400 && /al menos 2 días de anticipación/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await reservar(3, '2026-11-21', '07:00', '10:00', 'frente@example.com');
  anotar('Frente un sábado: no (400)', r.status === 400 && /fuera del rango/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await reservar(3, '2026-11-19', '07:00', '10:00', 'frente@example.com', { nombre: 'Eva <i>López</i>' });
  anotar('Frente a 3 días: sí (201)', r.status === 201, `${r.status} ${r.datos.error}`);
  const codigoFrente = r.datos.codigo;
  await hasta(() => delCorreo('frente@example.com').length > 0);
  let conf1 = delCorreo('frente@example.com')[0];
  anotar('La confirmación dice el plazo nuevo (hasta el 16/11, 3 días antes), con el código y sin HTML del nombre',
    conf1 && conf1.htmlContent.includes('hasta el <strong>16/11/2026</strong> (3 días antes)') && /Código de cancelación:<\/strong> [0-9A-F]{16}/.test(conf1.htmlContent) &&
    !conf1.htmlContent.includes('<i>López') && conf1.htmlContent.includes('Hola Eva &lt;i&gt;López&lt;/i&gt;,'), conf1 && conf1.htmlContent.slice(0, 400));

  r = await reservar(1, '2026-11-21', '09:00', '11:00', 'altillo@example.com');
  anotar('Altillo con normas: sin tildar que se leyeron no deja (400)', r.status === 400 && /normas de uso del Altillo/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await reservar(1, '2026-11-21', '09:00', '11:00', 'altillo@example.com', { cuerpo: { acepta_normas: true } });
  anotar('Altillo un sábado (ahora habilitado) aceptando las normas: sí (201)', r.status === 201, `${r.status} ${r.datos.error}`);
  await hasta(() => delCorreo('altillo@example.com').length > 0);
  const confAlt = delCorreo('altillo@example.com')[0];
  anotar('La confirmación del Altillo trae las normas', confAlt && confAlt.htmlContent.includes('Normas de uso del Altillo:') && confAlt.htmlContent.includes('No comer en el Altillo.<br>Dejarlo limpio'), confAlt && confAlt.subject);
  r = await reservar(1, '2026-11-23', '09:00', '10:00', 'altillo@example.com', { cuerpo: { acepta_normas: true } });
  anotar('Altillo con límite de 1 por persona: la segunda del mes no (400)', r.status === 400 && /El máximo es 1 por persona/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await reservar(1, '2026-12-01', '09:00', '10:00', 'otra@example.com', { cuerpo: { acepta_normas: true } });
  anotar('...(diciembre sigue sin habilitar: 400)', r.status === 400, `${r.status}`);

  // ===== Plazo para cancelar nuevo =====
  r = await reservar(3, '2026-11-18', '10:00', '13:00', 'plazo@example.com');
  const codigoPlazo = r.datos.codigo;
  let consulta = await pedir('POST', '/api/cancelar-por-codigo/consultar', { codigo: codigoPlazo || 'X' });
  anotar('Frente a 2 días con plazo de 3: avisa que venció el plazo (plazo_dias 3)', consulta.status === 200 && consulta.datos.plazo_vencido === true && consulta.datos.plazo_dias === 3 &&
    consulta.datos.correo_contacto === 'Monsegonza511@gmail.com', JSON.stringify(consulta.datos));
  r = await pedir('POST', '/api/cancelar-por-codigo', { codigo: codigoPlazo || 'X' });
  anotar('...y no la cancela (403)', r.status === 403 && /^EL PERIODO DE CANCELACION/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  consulta = await pedir('POST', '/api/cancelar-por-codigo/consultar', { codigo: codigoFrente || 'X' });
  anotar('La de a 3 días todavía se puede cancelar', consulta.datos.se_puede_cancelar === true, JSON.stringify(consulta.datos));

  // ===== Plantillas de correo =====
  const malasPlantillas = [
    await pedir('POST', '/api/superadmin/plantillas', { clave: 'confirmacion', asunto: 'Hola {nomber}', titulo: 'x', mensaje: 'y' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/plantillas', { clave: 'confirmacion', asunto: 'Asunto', titulo: 'Título', mensaje: 'Con <b>HTML</b>' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/plantillas', { clave: 'lista_espera_aviso', asunto: 'Se liberó', texto: 'Hay lugar el {dia}' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/plantillas', { clave: 'confirmacion', asunto: '', titulo: 'Título', mensaje: 'x' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/plantillas', { clave: 'no_existe', asunto: 'x', titulo: 'x', mensaje: 'x' }, 'superadmin')
  ];
  anotar('Plantillas inválidas = 400 (comodín mal escrito, signos < >, sin el enlace obligatorio, asunto vacío, correo desconocido)',
    malasPlantillas.every(m => m.status === 400 && m.datos.error), malasPlantillas.map(m => `${m.status} ${m.datos.error}`).join(' | '));
  anotar('...el error del comodín dice cuáles se pueden usar', /\{nomber\}/.test(malasPlantillas[0].datos.error) && /\{nombre\}/.test(malasPlantillas[0].datos.error), malasPlantillas[0].datos.error);

  r = await pedir('POST', '/api/superadmin/plantillas', { clave: 'confirmacion', asunto: 'Tu lugar en el {espacio} está reservado', titulo: '¡Listo, {nombre}!', mensaje: 'Gracias por reservar.\n\nTe esperamos el {fecha}, {horario}.' }, 'superadmin');
  anotar('Se guarda una confirmación nueva', r.status === 200 && r.datos.plantilla.modificada === true, `${r.status} ${r.datos.error}`);
  r = await reservar(3, '2026-11-20', '14:00', '18:00', 'nueva@example.com', { nombre: 'Juan Pérez' });
  await hasta(() => delCorreo('nueva@example.com').length > 0);
  const confNueva = delCorreo('nueva@example.com')[0];
  anotar('La confirmación sale con el asunto, el título y el mensaje nuevos (con " - CEQ #número" y los datos de siempre)',
    confNueva && confNueva.subject === `Tu lugar en el Frente está reservado - CEQ #${r.datos.reserva && r.datos.reserva.id}` && confNueva.htmlContent.includes('<h2>¡Listo, Juan Pérez!</h2>') &&
    confNueva.htmlContent.includes('<p>Te esperamos el viernes 20/11/2026, Merienda (14:00 - 18:00).</p>') && /Código de cancelación:<\/strong> [0-9A-F]{16}/.test(confNueva.htmlContent) &&
    confNueva.htmlContent.includes('cancelar.html?r=') && confNueva.htmlContent.includes('calendar.google.com'), confNueva && `${confNueva.subject} ${confNueva.htmlContent.slice(0, 300)}`);
  r = await pedir('POST', '/api/superadmin/plantillas', { clave: 'confirmacion', restaurar: true }, 'superadmin');
  const otra = await reservar(3, '2026-11-20', '07:00', '10:00', 'vuelta@example.com');
  await hasta(() => delCorreo('vuelta@example.com').length > 0);
  const confVuelta = delCorreo('vuelta@example.com')[0];
  anotar('"Volver al original" deja la confirmación de siempre', r.status === 200 && r.datos.plantilla.modificada === false && confVuelta &&
    confVuelta.subject === `✓ Confirmación de Reserva - CEQ #${otra.datos.reserva && otra.datos.reserva.id}` && confVuelta.htmlContent.includes('<h2>¡Reserva Confirmada!</h2>'), confVuelta && confVuelta.subject);
  await esperar(300);
  anotar('El registro anota los cambios de correos', db.registro_actividad.some(a => a.accion === 'Cambió un correo' && a.detalle === 'Confirmación de reserva') &&
    db.registro_actividad.some(a => a.accion === 'Volvió al correo original'));

  // ===== Enviarme una prueba =====
  r = await pedir('POST', '/api/superadmin/plantillas/prueba', { clave: 'recordatorio', espacio_id: 1, asunto: 'Ojo {nombre}: mañana tenés el {espacio}', titulo: 'Recordatorio', mensaje: 'Hola {nombre}.' }, 'superadmin');
  await hasta(() => delCorreo('ceq.informatica@gmail.com').some(c => c.subject.startsWith('[PRUEBA]')));
  const prueba = delCorreo('ceq.informatica@gmail.com').find(c => c.subject.startsWith('[PRUEBA]'));
  anotar('La prueba llega al correo de alertas, con lo escrito (sin guardar) y datos de ejemplo',
    r.status === 200 && prueba && prueba.subject === '[PRUEBA] Ojo Ana Pérez: mañana tenés el Altillo' && prueba.htmlContent.includes('<p>Hola Ana Pérez.</p>') && prueba.htmlContent.includes('Normas de uso del Altillo'),
    `${r.status} ${r.datos.error || ''} ${prueba && prueba.subject}`);
  p = await pedir('GET', '/api/superadmin/personalizacion', null, 'superadmin');
  anotar('...y la plantilla guardada no cambió', p.datos.plantillas.recordatorio.modificada === false && p.datos.plantillas.recordatorio.actual.asunto === '⏰ Recordatorio: {espacio}, {fecha}');
  r = await pedir('POST', '/api/superadmin/plantillas/prueba', { clave: 'lista_espera_aviso', espacio_id: 3 }, 'superadmin');
  await hasta(() => delCorreo('ceq.informatica@gmail.com').filter(c => c.subject.startsWith('[PRUEBA]')).length >= 2);
  const pruebaTexto = delCorreo('ceq.informatica@gmail.com').filter(c => c.subject.startsWith('[PRUEBA]'))[1];
  anotar('Prueba del aviso de la lista de espera: solo texto, con el saludo y el enlace', r.status === 200 && pruebaTexto && !pruebaTexto.htmlContent &&
    pruebaTexto.textContent.startsWith('Hola, Ana:') && pruebaTexto.textContent.includes('https://reservas.ceq-una.com/?fecha=') && /^\[PRUEBA\] Se liberó un lugar en el Frente: \S+ \d\d\/\d\d, Desayuno$/.test(pruebaTexto.subject),
    pruebaTexto && `${pruebaTexto.subject} | ${pruebaTexto.textContent && pruebaTexto.textContent.slice(0, 80)}`);
  r = await pedir('POST', '/api/superadmin/plantillas/prueba', { clave: 'confirmacion', asunto: 'x {malo}', titulo: 'x', mensaje: 'x' }, 'superadmin');
  anotar('Prueba con un error: 400 y no se manda', r.status === 400, `${r.status}`);

  // ===== Lista de espera con la plantilla cambiada =====
  r = await pedir('POST', '/api/superadmin/plantillas', { clave: 'lista_espera_inscripcion', asunto: 'Anotado/a en el {espacio}', texto: '{saludo}\n\nYa estás en la lista para {mes}.\n\nPara salir: {enlace_quitar}' }, 'superadmin');
  const anotarse = await pedir('POST', '/api/lista-espera', { espacio_id: 3, email: 'espera@example.com', nombre: 'Lola Gómez', mes: '2026-11' });
  await hasta(() => delCorreo('espera@example.com').length > 0);
  const insc = delCorreo('espera@example.com')[0];
  anotar('La inscripción a la lista de espera sale con el texto nuevo y el enlace para salir', r.status === 200 && anotarse.status === 201 && insc && insc.subject === 'Anotado/a en el Frente' &&
    insc.textContent.startsWith('Hola, Lola:\n\nYa estás en la lista para noviembre de 2026.') && insc.textContent.includes('lista-espera.html?s=3&e=espera%40example.com&t='), insc && JSON.stringify(insc.textContent));

  // ===== Textos de la página y anuncio =====
  const malosTextos = [
    await pedir('POST', '/api/superadmin/textos', { textos: { lista_espera: 'Lleno el {dia}' } }, 'superadmin'),
    await pedir('POST', '/api/superadmin/textos', { textos: { titulo_inicio: 'x'.repeat(61) } }, 'superadmin'),
    await pedir('POST', '/api/superadmin/textos', { textos: {}, anuncio: { activo: true, texto: '' } }, 'superadmin'),
    await pedir('POST', '/api/superadmin/textos', { textos: {}, anuncio: { activo: true, texto: 'Hola', hasta: '2026-02-30' } }, 'superadmin')
  ];
  anotar('Textos inválidos = 400 (comodín que no existe, título largo, anuncio vacío, fecha inválida)', malosTextos.every(m => m.status === 400), malosTextos.map(m => `${m.status} ${m.datos.error}`).join(' | '));
  r = await pedir('POST', '/api/superadmin/textos', { textos: { titulo_inicio: 'Reservas del CEQ', lista_espera: 'No queda lugar en el {espacio} para {mes}.', cancelar_ayuda: '' },
    anuncio: { activo: true, texto: 'El viernes 20 el Frente cierra a las 16:00.', hasta: '2026-11-20', tipo: 'importante' } }, 'superadmin');
  conf = await pedir('GET', '/api/configuracion');
  anotar('Se guardan los textos y el anuncio, y la página los recibe (los no cambiados, con su texto de siempre)', r.status === 200 && conf.datos.textos.titulo_inicio === 'Reservas del CEQ' &&
    conf.datos.textos.lista_espera === 'No queda lugar en el {espacio} para {mes}.' && conf.datos.textos.cancelar_ayuda === '' && conf.datos.textos.mes_no_habilitado.startsWith('Este mes todavía') &&
    conf.datos.anuncio && conf.datos.anuncio.tipo === 'importante' && conf.datos.anuncio.texto.startsWith('El viernes 20'), `${r.status} ${r.datos.error || ''} ${JSON.stringify(conf.datos.textos)} ${JSON.stringify(conf.datos.anuncio)}`);
  await esperar(300);
  anotar('...queda en el registro', db.registro_actividad.some(a => a.accion === 'Cambió los textos de la página' && /Título de la página/.test(a.detalle) && /anuncio: "El viernes 20/.test(a.detalle)));

  // ===== Recordatorios con las reglas nuevas (10:00 en Paraguay) =====
  ponerHora('2026-11-16T13:00:00Z');
  await hasta(() => delCorreo('altillo3@example.com').length > 0, 8000);
  await esperar(2500);
  const recAlt = delCorreo('altillo3@example.com')[0];
  anotar('Altillo con recordatorio a 3 días: le llega a la de dentro de 3 días, con las normas y sin "último día"', recAlt && recAlt.subject === '⏰ Recordatorio: Altillo, jueves 19/11/2026 - CEQ #902' &&
    recAlt.htmlContent.includes('Normas de uso del Altillo') && !recAlt.htmlContent.includes('último día'), recAlt && recAlt.subject);
  anotar('...no a la del Altillo de dentro de 2 días, ni a la del Frente (recordatorio apagado)', delCorreo('altillo2@example.com').length === 0 && delCorreo('frente2@example.com').length === 0,
    correos().map(c => c.subject).join(' | '));

  // ===== El anuncio deja de verse después de su fecha =====
  ponerHora('2026-11-21T13:00:00Z');
  await esperar(300);
  conf = await pedir('GET', '/api/configuracion');
  anotar('Pasada la fecha "hasta", el anuncio ya no se muestra', conf.datos.anuncio === null, JSON.stringify(conf.datos.anuncio));

  // ===== Después de reiniciar, todo se lee de la base =====
  hijo.kill();
  await esperar(500);
  const hijo2 = await arrancar();
  await esperar(800);
  conf = await pedir('GET', '/api/configuracion');
  p = await pedir('GET', '/api/superadmin/personalizacion', null, 'superadmin');
  anotar('Después de reiniciar, las reglas, los textos y las plantillas siguen', conf.datos.reglas['3'].plazo_cancelacion_dias === 3 && conf.datos.reglas['1'].normas.startsWith('No comer') &&
    conf.datos.textos.titulo_inicio === 'Reservas del CEQ' && p.datos.plantillas.lista_espera_inscripcion.modificada === true && p.datos.plantillas.confirmacion.modificada === false,
    JSON.stringify(conf.datos.reglas));

  hijo2.kill();
  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
