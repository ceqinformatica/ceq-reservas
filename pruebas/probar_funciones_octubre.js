// Prueba las funciones nuevas con el server.js real (Node 24), Supabase simulado, Brevo
// interceptado y un reloj falso que la prueba mueve: configuración editable, apertura
// programada, recordatorio 2 días antes, cancelar con enlace, lista de espera, asistencia y
// alertas. Uso: node probar_funciones_octubre.js <carpeta server+node_modules> <scratchpad>
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const [carpeta, scratch] = process.argv.slice(2);
const { crearMiniPostgrest } = require(path.join(scratch, 'mini_postgrest.js'));
const jwt = require(path.join(carpeta, 'node_modules', 'jsonwebtoken'));
const SECRETO = 'secreto-de-prueba-octubre';
const CLAVE_SINC = 'clave-de-sincronizacion-de-prueba-0123456789abcdef';
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-oct-' + Date.now() + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-' + Date.now() + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const ponerHora = isoUtc => fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: Date.parse(isoUtc) - Date.now() }));
const ahoraFalso = () => Date.now() + JSON.parse(fs.readFileSync(relojArchivo, 'utf8')).desfase_ms;
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const correosA = email => correos().filter(c => c.to.some(t => t.email === email));
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const tokenEsperado = id => crypto.createHmac('sha256', crypto.createHmac('sha256', SECRETO).update('enlaces-de-cancelacion-v1').digest()).update(`cancelar:${id}`).digest('base64url').slice(0, 32);

// ---------- Datos: "hoy" es el lunes 16/11/2026 ----------
let id = 100;
const r = (extra) => ({ id: ++id, espacio_id: 3, nombre_solicitante: 'Persona ' + (id), contacto: `0981000${id} | persona${id}@example.com`, fecha: '2026-11-18',
  hora_inicio: '07:00:00', hora_fin: '10:00:00', estado: 'activa', motivo: 'Estudio', codigo_cancelacion: null, codigo_cancelacion_hash: sha('X' + id),
  created_at: '2026-11-10T12:00:00', updated_at: '2026-11-10T12:00:00', reservado_por_admin: false, cancelada_en: null, cancelada_por: null,
  motivo_cancelacion: null, recordatorio_enviado_en: null, asistencia: null, ...extra });
const R = {};
R.uno = r({ contacto: '0981111111 | persona1@example.com' });                                           // 18/11 Desayuno -> recordatorio
R.reciente = r({ hora_inicio: '10:00:00', hora_fin: '13:00:00', created_at: '2026-11-16T12:00:00' });  // hecha hace 1 h -> no
R.prioridad = r({ hora_inicio: '14:00:00', hora_fin: '18:00:00', reservado_por_admin: true });         // prioridad -> no
R.altillo = r({ espacio_id: 1, hora_inicio: '09:00:00', hora_fin: '11:00:00', contacto: '0982222222 | altillo@example.com' }); // -> recordatorio
R.tresDias = r({ fecha: '2026-11-19' });                                                               // en 3 días -> no
R.cancelada = r({ estado: 'cancelada' });                                                              // cancelada -> no
R.fallaBrevo = r({ espacio_id: 1, hora_inicio: '14:00:00', hora_fin: '15:00:00', contacto: '0983333333 | falla-brevo@example.com' });
R.llenoD = r({ fecha: '2026-11-20' });
R.llenoA = r({ fecha: '2026-11-20', hora_inicio: '10:00:00', hora_fin: '13:00:00' });
R.llenoM = r({ fecha: '2026-11-20', hora_inicio: '14:00:00', hora_fin: '18:00:00', codigo_cancelacion_hash: sha('CODIGO12') });
R.manana = r({ fecha: '2026-11-17' });                                                                 // Frente en 1 día: plazo vencido
R.altilloManana = r({ espacio_id: 1, fecha: '2026-11-17', hora_inicio: '08:00:00', hora_fin: '09:00:00' });
R.pasada = r({ fecha: '2026-11-13' });                                                                 // viernes pasado
R.hoy = r({ fecha: '2026-11-16' });                                                                    // hoy 07:00 (ya empezó)

const db = {
  reservas: Object.values(R),
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 2, nombre: 'Sala de Reuniones', publico: false, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }, { id: 2, anio: 2026, mes: 12, habilitado: false, abrir_en: null }],
  configuracion: [
    { clave: 'version_sesiones', valor: '1' },
    { clave: 'turnos_frente', valor: '[{"nombre":"Desayuno","inicio":"07:00","fin":"10:00"},{"nombre":"Almuerzo","inicio":"10:00","fin":"13:00"},{"nombre":"Merienda","inicio":"14:00","fin":"18:00"}]' },
    { clave: 'max_reservas_por_persona_mes', valor: '2' },
    { clave: 'contacto_email_frente', valor: 'Monsegonza511@gmail.com' },
    { clave: 'contacto_whatsapp_frente', valor: '595972753471' },
    { clave: 'email_alertas', valor: 'ceq.informatica@gmail.com' }
  ],
  registro_actividad: [], lista_espera: [], bloqueos: [], reportes_errores: []
};
let fallarBloqueos = false;
const mini = crearMiniPostgrest(db, {
  unicas: { lista_espera: [['espacio_id', 'email']] },
  porDefecto: {
    reservas: () => ({ created_at: new Date(ahoraFalso()).toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false }),
    registro_actividad: () => ({ creado_en: new Date(ahoraFalso()).toISOString() }),
    lista_espera: () => ({ creado_en: new Date(ahoraFalso()).toISOString(), avisado_en: null })
  },
  fallar: (tabla, metodo) => fallarBloqueos && tabla === 'bloqueos' && metodo === 'GET'
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(scratch, 'reloj_falso.js'), '--require', path.join(scratch, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3994', SUPABASE_URL: 'http://127.0.0.1:54325', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '1000',
      CLAVE_SINCRONIZACION: CLAVE_SINC, EMAILS_SIN_LIMITE: '', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  hijo.salida = () => salida;
  return hijo;
}

const API = 'http://127.0.0.1:3994';
let ipN = 1;
const tokenDe = rol => { const s = Math.floor(ahoraFalso() / 1000); return jwt.sign({ adminId: 'admin', rol, v: 1, iat: s, exp: s + 30 * 86400 }, SECRETO, { algorithm: 'HS256' }); };
async function llamar(metodo, ruta, { cuerpo, rol, ip, sinCsrf } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip || `198.51.100.${ipN++ % 250}` };
  if (rol) { headers.cookie = `admin_token=${tokenDe(rol)}; csrf_token=abc`; if (!sinCsrf) headers['x-csrf-token'] = 'abc'; }
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { status: res.status, datos: await res.json().catch(() => ({})) };
}
const reservar = (fecha, inicio, fin, contacto, espacio_id = 3) => llamar('POST', '/api/reservas', { cuerpo: { espacio_id, nombre_solicitante: 'Prueba', contacto, fecha, hora_inicio: inicio, hora_fin: fin, motivo: espacio_id === 3 ? 'Actividad Personal' : 'estudio' } });
const fila = rid => db.reservas.find(x => x.id === rid);
const actividad = () => db.registro_actividad.map(a => `${a.rol}|${a.accion}|${a.detalle || ''}`);

(async () => {
  await new Promise(ok => mini.servidor.listen(54325, '127.0.0.1', ok));
  ponerHora('2026-11-16T10:30:00Z'); // 07:30 en Paraguay
  let hijo = await arrancar();
  await esperar(2500);

  // ===== Recordatorio: antes de las 08:00 no sale nada =====
  anotar('07:30: todavía no se manda ningún recordatorio', !correos().some(c => c.subject.includes('Recordatorio')), correos().map(c => c.subject).join(' | '));

  // ===== Configuración =====
  let x = await llamar('GET', '/api/configuracion');
  anotar('GET /api/configuracion: los 3 turnos de siempre y el contacto', x.status === 200 && x.datos.turnos_frente.map(t => t.nombre).join() === 'Desayuno,Almuerzo,Merienda' && x.datos.contacto_frente.whatsapp === '595972753471' && x.datos.max_reservas_por_persona_mes === 2, JSON.stringify(x.datos));
  anotar('No expone el correo de alertas en la configuración pública', !JSON.stringify(x.datos).includes('email_alertas'));
  x = await llamar('POST', '/api/superadmin/configuracion', { rol: 'admin', cuerpo: { max_reservas_por_persona_mes: 5 } });
  anotar('El admin normal no puede cambiar la configuración (403)', x.status === 403, String(x.status));
  const T = (n, i, f) => ({ nombre: n, inicio: i, fin: f });
  const invalidos = [
    [{ turnos_frente: [T('A', '07:00', '10:00'), T('B', '09:00', '12:00')] }, 'se superponen'],
    [{ turnos_frente: [T('A', '7:00', '10:00')] }, 'HH:MM'],
    [{ turnos_frente: [T('A', '10:00', '09:00')] }, 'anterior'],
    [{ turnos_frente: [T('A', '05:00', '07:00')] }, '06:00'],
    [{ turnos_frente: [T('A', '07:00', '08:00'), T('a', '09:00', '10:00')] }, 'mismo nombre'],
    [{ turnos_frente: Array.from({ length: 6 }, (_, i) => T('T' + i, `${String(7 + i * 2).padStart(2, '0')}:00`, `${String(8 + i * 2).padStart(2, '0')}:00`)) }, 'entre 1 y 5'],
    [{ turnos_frente: [] }, 'entre 1 y 5'],
    [{ max_reservas_por_persona_mes: 0 }, 'entre 1 y 20'],
    [{ contacto_whatsapp_frente: 'abc' }, 'código de país'],
    [{ email_alertas: 'no-es-correo' }, 'no es válido'],
    [{}, 'nada para guardar']
  ];
  const fallos = [];
  for (const [cuerpo, texto] of invalidos) { x = await llamar('POST', '/api/superadmin/configuracion', { rol: 'superadmin', cuerpo }); if (!(x.status === 400 && String(x.datos.error).includes(texto))) fallos.push(`${JSON.stringify(cuerpo).slice(0, 40)} -> ${x.status} ${x.datos.error}`); }
  anotar('Configuración inválida (superpuestos, formato, orden, horario, nombre repetido, cantidad, límite, WhatsApp, correo, vacío): 400 con mensaje claro', fallos.length === 0, fallos.join(' ; '));

  x = await llamar('POST', '/api/superadmin/configuracion', { rol: 'superadmin', cuerpo: { turnos_frente: [T('Merienda', '14:00', '18:00'), T('Desayuno', '07:00', '10:00'), T('Almuerzo', '10:00', '13:00'), T(' Cena ', '18:00', '21:00')] } });
  anotar('Agregar un turno "Cena" 18-21: se guarda ordenado por hora', x.status === 200 && x.datos.config.turnos_frente.map(t => t.nombre).join() === 'Desayuno,Almuerzo,Merienda,Cena', JSON.stringify(x.datos));
  await esperar(150);
  anotar('Registro: "Cambió la configuración — turnos del Frente"', actividad().includes('superadmin|Cambió la configuración|turnos del Frente'), actividad().slice(-2).join(' ; '));
  x = await reservar('2026-11-25', '18:00', '21:00', '0985555555 | cena@example.com');
  anotar('Con el turno nuevo, se puede reservar Cena', x.status === 201, `${x.status} ${JSON.stringify(x.datos).slice(0, 120)}`);
  x = await reservar('2026-11-25', '08:00', '09:00', '0985555556 | otro@example.com');
  anotar('Un horario que no es turno sigue rechazado, y el mensaje lista los turnos', x.status === 400 && x.datos.error.includes('Cena (18:00-21:00)'), x.datos.error);
  const registrosAntes = db.registro_actividad.length;
  x = await llamar('POST', '/api/superadmin/configuracion', { rol: 'superadmin', cuerpo: { max_reservas_por_persona_mes: 2 } });
  await esperar(150);
  anotar('Guardar sin cambios: "No había cambios" y no se registra nada', x.status === 200 && x.datos.mensaje === 'No había cambios' && db.registro_actividad.length === registrosAntes, x.datos.mensaje);

  x = await reservar('2026-11-23', '07:00', '10:00', '0986666666 | limite@example.com');
  const primera = x.status;
  await llamar('POST', '/api/superadmin/configuracion', { rol: 'superadmin', cuerpo: { max_reservas_por_persona_mes: 1 } });
  x = await reservar('2026-11-24', '07:00', '10:00', '0986666666 | limite@example.com');
  anotar('Límite por persona en 1: la segunda reserva del mes se rechaza', primera === 201 && x.status === 400 && x.datos.error.includes('El máximo es 1'), `${primera} ${x.status} ${x.datos.error}`);
  await llamar('POST', '/api/superadmin/configuracion', { rol: 'superadmin', cuerpo: { max_reservas_por_persona_mes: 2, contacto_whatsapp_frente: '+595 981 000-000' } });
  x = await reservar('2026-11-26', '07:00', '10:00', '0987777777 | whatsapp@example.com');
  await esperar(300);
  const confirmacion = correosA('whatsapp@example.com').pop();
  anotar('WhatsApp cambiado (se limpia a solo números) y aparece en el correo de confirmación', x.status === 201 && confirmacion && confirmacion.htmlContent.includes('wa.me/595981000000'), confirmacion && confirmacion.subject);
  anotar('El correo de confirmación trae el enlace "Cancelar mi reserva" firmado', confirmacion && confirmacion.htmlContent.includes(`cancelar.html?r=${x.datos.reserva.id}&amp;t=${tokenEsperado(x.datos.reserva.id)}`) || confirmacion.htmlContent.includes(`cancelar.html?r=${x.datos.reserva.id}&t=${tokenEsperado(x.datos.reserva.id)}`), '');

  // ===== Recordatorios (10:00 en Paraguay) =====
  ponerHora('2026-11-16T13:00:00Z');
  await esperar(3000);
  const rec = correos().filter(c => c.subject.includes('Recordatorio'));
  const recUno = correosA('persona1@example.com').find(c => c.subject.includes('Recordatorio'));
  const recAlt = correosA('altillo@example.com').find(c => c.subject.includes('Recordatorio'));
  anotar('10:00: recordatorio a la reserva del Frente y a la del Altillo de dentro de 2 días', !!recUno && !!recAlt, rec.map(c => c.to[0].email).join(','));
  anotar('No a la hecha hace 1 hora, ni a la de prioridad, ni a la de dentro de 3 días, ni a la cancelada', rec.length === 2 && fila(R.reciente.id).recordatorio_enviado_en === null && fila(R.prioridad.id).recordatorio_enviado_en === null && fila(R.tresDias.id).recordatorio_enviado_en === null && fila(R.cancelada.id).recordatorio_enviado_en === null, rec.map(c => c.subject).join(' | '));
  anotar('Frente: "Hoy es el último día para cancelar gratis" + botón con enlace firmado', recUno && recUno.htmlContent.includes('último día para cancelar gratis') && recUno.htmlContent.includes(`cancelar.html?r=${R.uno.id}&t=${tokenEsperado(R.uno.id)}`), recUno && recUno.subject);
  anotar('Asunto con espacio y día: "Frente, miércoles 18/11/2026"', recUno && recUno.subject.includes('Frente, miércoles 18/11/2026'), recUno && recUno.subject);
  anotar('Altillo: sin la regla de los 2 días', recAlt && !recAlt.htmlContent.includes('último día'), '');
  anotar('Queda marcado como enviado', !!fila(R.uno.id).recordatorio_enviado_en && !!fila(R.altillo.id).recordatorio_enviado_en);
  anotar('Si Brevo falla, se desmarca para reintentar', fila(R.fallaBrevo.id).recordatorio_enviado_en === null);
  await esperar(2200);
  anotar('En las vueltas siguientes no se repite', correos().filter(c => c.subject.includes('Recordatorio')).length === 2, String(correos().filter(c => c.subject.includes('Recordatorio')).length));

  // ===== Cancelar con el enlace =====
  const tokUno = tokenEsperado(R.uno.id);
  x = await llamar('GET', `/api/cancelar-por-enlace?r=${R.uno.id}&t=${tokUno}`);
  anotar('GET enlace válido: datos mínimos y "se puede cancelar"', x.status === 200 && x.datos.se_puede_cancelar === true && x.datos.espacio === 'Frente' && x.datos.horario.startsWith('Desayuno') && x.datos.fecha_larga === 'miércoles 18/11/2026', JSON.stringify(x.datos));
  // Para el saludo ("Hola, Persona"): solo el primer nombre, sin apellido, celular ni correo
  anotar('Trae solo el primer nombre para saludar (sin apellido, celular ni correo)', x.datos.nombre === 'Persona' && !JSON.stringify(x.datos).match(/persona\d|@example|0981|Persona \d/), JSON.stringify(x.datos));
  const malos = [await llamar('GET', `/api/cancelar-por-enlace?r=${R.reciente.id}&t=${tokUno}`), await llamar('GET', `/api/cancelar-por-enlace?r=${R.uno.id}&t=${'A'.repeat(32)}`), await llamar('GET', `/api/cancelar-por-enlace?r=abc&t=${tokUno}`), await llamar('POST', '/api/cancelar-por-enlace', { cuerpo: { r: R.reciente.id, t: tokUno } })];
  anotar('Enlace de otra reserva, firma falsa o número inválido: 404 y no cancela nada', malos.every(m => m.status === 404) && fila(R.reciente.id).estado === 'activa', malos.map(m => m.status).join(','));
  x = await llamar('GET', `/api/cancelar-por-enlace?r=${R.manana.id}&t=${tokenEsperado(R.manana.id)}`);
  const y = await llamar('POST', '/api/cancelar-por-enlace', { cuerpo: { r: R.manana.id, t: tokenEsperado(R.manana.id) } });
  anotar('Frente para mañana: avisa plazo vencido (con WhatsApp) y no la cancela (403)', x.datos.plazo_vencido === true && x.datos.se_puede_cancelar === false && x.datos.whatsapp === '595981000000' && y.status === 403 && fila(R.manana.id).estado === 'activa', `${JSON.stringify(x.datos)} ${y.status}`);
  x = await llamar('POST', '/api/cancelar-por-enlace', { cuerpo: { r: R.uno.id, t: tokUno } });
  anotar('POST con el enlace: cancela y guarda "usuario"', x.status === 200 && fila(R.uno.id).estado === 'cancelada' && fila(R.uno.id).cancelada_por === 'usuario', `${x.status} ${JSON.stringify(x.datos)}`);
  x = await llamar('POST', '/api/cancelar-por-enlace', { cuerpo: { r: R.uno.id, t: tokUno } });
  anotar('Usar el enlace otra vez: "ya se encontraba cancelada"', x.status === 200 && x.datos.mensaje === 'La reserva ya se encontraba cancelada', JSON.stringify(x.datos));
  x = await llamar('POST', '/api/cancelar-por-enlace', { cuerpo: { r: R.altilloManana.id, t: tokenEsperado(R.altilloManana.id) } });
  anotar('Altillo para mañana: se puede cancelar (la regla de 2 días es solo del Frente)', x.status === 200 && fila(R.altilloManana.id).estado === 'cancelada', String(x.status));
  x = await llamar('GET', `/api/cancelar-por-enlace?r=${R.pasada.id}&t=${tokenEsperado(R.pasada.id)}`);
  const z = await llamar('POST', '/api/cancelar-por-enlace', { cuerpo: { r: R.pasada.id, t: tokenEsperado(R.pasada.id) } });
  anotar('Reserva que ya pasó: "ya_paso" y no se cancela', x.datos.ya_paso === true && z.status === 400 && fila(R.pasada.id).estado === 'activa', `${JSON.stringify(x.datos)} ${z.status}`);

  // ===== Asistencia =====
  x = await llamar('POST', `/api/admin/reservas/${R.pasada.id}/asistencia`, { rol: 'admin', cuerpo: { asistencia: 'vino' } });
  const a2 = await llamar('POST', `/api/admin/reservas/${R.hoy.id}/asistencia`, { rol: 'admin', cuerpo: { asistencia: 'no_vino' } });
  anotar('Asistencia de una reserva pasada (vino) y de una de hoy (no vino)', x.status === 200 && a2.status === 200 && fila(R.pasada.id).asistencia === 'vino' && fila(R.hoy.id).asistencia === 'no_vino', `${x.status} ${a2.status}`);
  const asisMalas = [
    await llamar('POST', `/api/admin/reservas/${R.tresDias.id}/asistencia`, { rol: 'admin', cuerpo: { asistencia: 'vino' } }),
    await llamar('POST', `/api/admin/reservas/${R.cancelada.id}/asistencia`, { rol: 'admin', cuerpo: { asistencia: 'vino' } }),
    await llamar('POST', `/api/admin/reservas/${R.pasada.id}/asistencia`, { rol: 'admin', cuerpo: { asistencia: 'tal vez' } }),
    await llamar('POST', `/api/admin/reservas/99999/asistencia`, { rol: 'admin', cuerpo: { asistencia: 'vino' } })
  ];
  anotar('Asistencia: futura, cancelada o valor inválido = 400; inexistente = 404', asisMalas.map(m => m.status).join() === '400,400,400,404', asisMalas.map(m => `${m.status} ${m.datos.error}`).join(' ; '));
  x = await llamar('POST', `/api/admin/reservas/${R.pasada.id}/asistencia`, { cuerpo: { asistencia: 'vino' } });
  const sinCsrf = await llamar('POST', `/api/admin/reservas/${R.pasada.id}/asistencia`, { rol: 'admin', sinCsrf: true, cuerpo: { asistencia: null } });
  anotar('Sin sesión: 401; sin CSRF: 403', x.status === 401 && sinCsrf.status === 403, `${x.status} ${sinCsrf.status}`);
  await llamar('POST', `/api/admin/reservas/${R.hoy.id}/asistencia`, { rol: 'admin', cuerpo: { asistencia: null } });
  await esperar(150);
  anotar('Se puede borrar la marca (null) y queda en el registro', fila(R.hoy.id).asistencia === null && actividad().some(a => a.startsWith(`admin|Marcó la asistencia de una reserva|#${R.pasada.id} · Vino`)) && actividad().some(a => a.startsWith(`admin|Borró la asistencia de una reserva|#${R.hoy.id}`)), actividad().slice(-3).join(' ; '));
  const sinc = await fetch(API + '/api/sincronizacion/reservas', { headers: { 'x-clave-sincronizacion': CLAVE_SINC } }).then(q => q.json());
  anotar('La planilla recibe la asistencia', sinc.reservas.find(q => q.id === R.pasada.id).asistencia === 'vino');

  // ===== Lista de espera (general, por espacio) =====
  const anotarse = (email, espacio_id = 3, ip) => llamar('POST', '/api/lista-espera', { cuerpo: { espacio_id, email }, ip });
  x = await anotarse('Espera1@Example.com');
  const e2 = await anotarse('espera2@example.com');
  const e3 = await anotarse('espera3@example.com', 1);
  anotar('Tres personas se anotan (dos al Frente, una al Altillo)', x.status === 201 && e2.status === 201 && e3.status === 201 && db.lista_espera.length === 3, `${x.status} ${e2.status} ${e3.status} filas=${db.lista_espera.length}`);
  anotar('Se guarda solo espacio y correo (en minúsculas), sin día ni turno', db.lista_espera.some(f => f.email === 'espera1@example.com' && f.espacio_id === 3 && !('fecha' in f)));
  x = await anotarse('espera1@example.com');
  anotar('Anotarse dos veces al mismo espacio no duplica', x.status === 201 && db.lista_espera.filter(f => f.email === 'espera1@example.com').length === 1, String(db.lista_espera.length));
  const listaMalas = [await anotarse('no-es-correo'), await anotarse('t@example.com', 2), await anotarse('t@example.com', 9), await anotarse('')];
  anotar('Correo inválido, espacio cerrado o inexistente = 400', listaMalas.every(m => m.status === 400), listaMalas.map(m => `${m.status} ${m.datos.error}`).join(' ; '));

  const antes = correos().length;
  x = await llamar('POST', `/api/admin/cancelar/${R.llenoD.id}`, { rol: 'admin', cuerpo: { motivo: 'prueba' } });
  await esperar(500);
  const avisos = correos().slice(antes).filter(c => c.subject.includes('Se liberó un turno'));
  anotar('Se cancela una reserva del Frente: avisan a los 2 anotados al Frente (no al del Altillo)', x.status === 200 && avisos.map(c => c.to[0].email).sort().join() === 'espera1@example.com,espera2@example.com', avisos.map(c => c.to[0].email).join());
  anotar('Asunto con día, turno y número de reserva (no se agrupan en Gmail), sin emoji, y SOLO texto (sin HTML, para no caer en Promociones)', avisos[0] && avisos[0].subject === `Se liberó un turno en el Frente: viernes 20/11/2026, Desayuno (07:00 - 10:00) (aviso #${R.llenoD.id})` && !/[\u{1F300}-\u{1FAFF}]/u.test(avisos[0].subject) && (avisos[0].textContent || '').includes('https://reservas.ceq-una.com/?fecha=2026-11-20&espacio=3') && avisos[0].htmlContent === undefined, avisos[0] && avisos[0].subject);
  anotar('El aviso dice qué día y turno se liberó y trae el enlace directo', avisos[0] && avisos[0].subject.includes('Frente') && avisos[0].textContent.includes('viernes 20/11/2026') && avisos[0].textContent.includes('Desayuno') && avisos[0].textContent.includes('https://reservas.ceq-una.com/?fecha=2026-11-20&espacio=3'), avisos[0] && avisos[0].subject);
  anotar('Quedan marcadas como avisadas; la del Altillo sigue pendiente', db.lista_espera.filter(f => f.espacio_id === 3).every(f => f.avisado_en) && db.lista_espera.find(f => f.email === 'espera3@example.com').avisado_en === null);
  const antes2 = correos().length;
  x = await llamar('POST', '/api/cancelar-por-codigo', { cuerpo: { codigo: 'codigo12' } });
  await esperar(500);
  anotar('Otra cancelación del Frente: no se vuelve a avisar (un solo aviso por inscripción)', x.status === 200 && !correos().slice(antes2).some(c => c.subject.includes('Se liberó un turno')), String(x.status));
  x = await anotarse('espera1@example.com');
  anotar('Volver a anotarse reactiva la inscripción', x.status === 201 && db.lista_espera.find(f => f.email === 'espera1@example.com').avisado_en === null);
  const antes3 = correos().length;
  await llamar('POST', `/api/admin/cancelar/${R.altillo.id}`, { rol: 'admin', cuerpo: {} });
  await esperar(500);
  const avisos3 = correos().slice(antes3).filter(c => c.subject.includes('Se liberó un turno'));
  anotar('Se cancela una del Altillo: avisan solo al anotado al Altillo', avisos3.map(c => c.to[0].email).join() === 'espera3@example.com' && avisos3[0].subject.includes('Altillo'), avisos3.map(c => c.to[0].email).join());
  const haceDias = d => new Date(ahoraFalso() - d * 86400000).toISOString();
  db.lista_espera.push({ id: 950, espacio_id: 3, email: 'avisado-viejo@example.com', creado_en: haceDias(20), avisado_en: haceDias(10) });
  db.lista_espera.push({ id: 951, espacio_id: 3, email: 'pendiente-viejo@example.com', creado_en: haceDias(70), avisado_en: null });
  db.lista_espera.push({ id: 952, espacio_id: 3, email: 'avisado-reciente@example.com', creado_en: haceDias(3), avisado_en: haceDias(2) });
  const antes4 = correos().length;
  await llamar('POST', `/api/admin/cancelar/${R.hoy.id}`, { rol: 'admin', cuerpo: {} });
  await esperar(2300);
  anotar('Si el turno liberado ya empezó (hoy 07:00, son las 10:00), no se avisa', !correos().slice(antes4).some(c => c.subject.includes('Se liberó un turno')) && db.lista_espera.find(f => f.email === 'espera1@example.com').avisado_en === null);
  anotar('Limpieza: se borran las avisadas hace más de 7 días y las pendientes de más de 60', !db.lista_espera.some(f => f.id === 950 || f.id === 951) && db.lista_espera.some(f => f.id === 952) && db.lista_espera.some(f => f.email === 'espera1@example.com'), db.lista_espera.map(f => f.id).join(','));

  // ===== Apertura programada =====
  const en = seg => new Date(ahoraFalso() + seg * 1000).toISOString();
  const programar = (cuerpo, opciones = {}) => llamar('POST', '/api/admin/meses-habilitados/programar', { rol: 'admin', cuerpo, ...opciones });
  const progMalas = [
    await programar({ anio: 2026, mes: 12, abrir_en: en(-60) }),
    await programar({ anio: 2027, mes: 1, abrir_en: en(3600) }),
    await programar({ anio: 2026, mes: 11, abrir_en: en(3600) }),
    await programar({ anio: 2026, mes: 12, abrir_en: 'mañana' }),
    await programar({ anio: 2026, mes: 12, abrir_en: en(200 * 86400) }),
    await programar({ anio: 2026, mes: 13, abrir_en: en(3600) })
  ];
  const progSinCsrf = await programar({ anio: 2026, mes: 12, abrir_en: en(3600) }, { sinCsrf: true });
  anotar('Programar: hora pasada, mes no seguido, mes ya abierto, fecha inválida, más de 6 meses o mes inválido = 400; sin CSRF = 403',
    progMalas.every(m => m.status === 400) && progSinCsrf.status === 403, progMalas.map(m => `${m.status} ${m.datos.error}`).join(' ; '));
  x = await programar({ anio: 2026, mes: 12, abrir_en: en(90) });
  await esperar(150);
  anotar('El admin programa diciembre para dentro de 90 segundos', x.status === 200 && !!db.meses_habilitados.find(m => m.mes === 12).abrir_en && actividad().some(a => a.startsWith('admin|Programó la apertura de un mes|12/2026 · se abre el 16/11/2026')), `${x.status} ${actividad().slice(-1)}`);
  x = await llamar('GET', '/api/meses-habilitados');
  const ap = await llamar('GET', '/api/aperturas-programadas');
  const resDic = await reservar('2026-12-07', '07:00', '10:00', '0988888888 | diciembre@example.com');
  anotar('Antes de la hora: diciembre no figura como habilitado y no se puede reservar', x.datos.map(m => m.mes).join() === '11' && resDic.status === 400, `${JSON.stringify(x.datos)} ${resDic.status}`);
  anotar('/api/aperturas-programadas: diciembre, la hora exacta y la hora del servidor', ap.datos.aperturas.length === 1 && ap.datos.aperturas[0].mes === 12 && Math.abs(Date.parse(ap.datos.ahora) - ahoraFalso()) < 3000, JSON.stringify(ap.datos));
  ponerHora(new Date(ahoraFalso() + 91 * 1000).toISOString());
  await esperar(80);
  x = await llamar('GET', '/api/meses-habilitados');
  const resDic2 = await reservar('2026-12-07', '07:00', '10:00', '0988888888 | diciembre@example.com');
  anotar('Al llegar la hora: diciembre se abre al instante y se puede reservar', x.datos.map(m => m.mes).join() === '11,12' && resDic2.status === 201, `${JSON.stringify(x.datos)} ${resDic2.status}`);
  await esperar(1500);
  const dic = db.meses_habilitados.find(m => m.mes === 12);
  await esperar(150);
  anotar('La tarea periódica lo deja marcado como habilitado y lo registra como "Sistema"', dic.habilitado === true && dic.abrir_en === null && actividad().includes('sistema|Se abrió un mes programado|12/2026'), JSON.stringify(dic));
  x = await programar({ anio: 2027, mes: 1, abrir_en: en(86400) });
  const cancelar = await programar({ anio: 2027, mes: 1, abrir_en: null });
  const ene = db.meses_habilitados.find(m => m.anio === 2027 && m.mes === 1);
  anotar('Programar enero y cancelar la apertura', x.status === 200 && cancelar.status === 200 && ene.abrir_en === null && ene.habilitado === false, `${x.status} ${cancelar.status}`);
  await programar({ anio: 2027, mes: 1, abrir_en: en(86400) });
  await llamar('POST', '/api/admin/meses-habilitados', { rol: 'admin', cuerpo: { anio: 2027, mes: 1, habilitado: true } });
  anotar('Habilitar a mano un mes programado borra la programación', db.meses_habilitados.find(m => m.anio === 2027 && m.mes === 1).abrir_en === null);
  x = await llamar('GET', '/api/admin/meses-habilitados', { rol: 'admin' });
  anotar('El panel recibe abrir_en de cada mes', x.status === 200 && x.datos.every(m => 'abrir_en' in m), JSON.stringify(x.datos));

  // ===== Alertas =====
  await llamar('POST', '/api/superadmin/configuracion', { rol: 'superadmin', cuerpo: { email_alertas: 'alertas@example.com' } });
  fallarBloqueos = true;
  x = await llamar('GET', '/api/bloqueos');
  fallarBloqueos = false;
  await esperar(2300);
  let alertas = correosA('alertas@example.com');
  anotar('Error del servidor: llega una alerta al correo configurado', x.status === 500 && alertas.length === 1 && alertas[0].subject.includes('1 error(es)') && alertas[0].htmlContent.includes('GET /api/bloqueos'), alertas.map(c => c.subject).join(' | '));
  const codigos = [];
  for (let i = 0; i < 16; i++) codigos.push((await anotarse('rafaga@example.com', 3, '203.0.113.99')).status);
  await esperar(2300);
  anotar('Un 429 dentro de la misma hora no manda otra alerta', codigos[15] === 429 && correosA('alertas@example.com').length === 1, codigos.slice(-2).join(','));
  ponerHora(new Date(ahoraFalso() + 61 * 60 * 1000).toISOString());
  await esperar(2300);
  alertas = correosA('alertas@example.com');
  anotar('Pasada la hora: llega la alerta del 429 con la IP', alertas.length === 2 && alertas[1].subject.includes('bloqueo(s) 429') && alertas[1].htmlContent.includes('203.0.113.99'), alertas.map(c => c.subject).join(' | '));
  await esperar(2300);
  anotar('Sin novedades no se manda nada más', correosA('alertas@example.com').length === 2);

  // ===== Reinicio =====
  hijo.kill(); await esperar(400);
  hijo = await arrancar();
  await esperar(300);
  x = await llamar('GET', '/api/configuracion');
  anotar('Después de reiniciar, la configuración se lee de la base (4 turnos, WhatsApp nuevo)', x.datos.turnos_frente.length === 4 && x.datos.contacto_frente.whatsapp === '595981000000', JSON.stringify(x.datos));
  hijo.kill();
  mini.servidor.close();

  const avisos500 = hijo.salida().split('\n').filter(l => /DeprecationWarning|ExperimentalWarning/i.test(l));
  anotar('Sin avisos de funciones obsoletas de Node', avisos500.length === 0, avisos500.join(' | '));
  for (const z2 of resultados) console.log(`${z2.ok ? 'OK   ' : 'FALLA'} ${z2.nombre}${z2.detalle && !z2.ok ? '  ->  ' + z2.detalle : ''}`);
  console.log(`\n${resultados.filter(z2 => z2.ok).length}/${resultados.length} pruebas correctas`);
  fs.unlinkSync(brevoLog); fs.unlinkSync(relojArchivo);
  process.exit(0);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
