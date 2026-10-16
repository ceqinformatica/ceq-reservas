// Prueba los arreglos de la auditoría técnica de octubre de 2026 (CEQ-02 a CEQ-13), con el
// server.js real, Supabase simulado, Brevo interceptado y un reloj falso.
// Uso: node probar_auditoria.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const bcrypt = require(require.resolve('bcryptjs', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-auditoria-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-auditoria-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const ponerHora = isoUtc => fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: Date.parse(isoUtc) - Date.now() }));
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const SECRETO = 'secreto-auditoria';
const CLAVE = 'clave-de-prueba-local';

let id = 900;
const fila = extra => ({ id: ++id, espacio_id: 3, nombre_solicitante: 'Persona ' + id, contacto: `0981 000 ${id} | p${id}@example.com`,
  fecha: '2026-11-20', hora_inicio: '07:00:00', hora_fin: '10:00:00', estado: 'activa', motivo: 'Actividad Personal',
  codigo_cancelacion_hash: sha('COD' + id), created_at: '2026-11-01T12:00:00', reservado_por_admin: false, cancelada_en: null,
  cancelada_por: null, motivo_cancelacion: null, recordatorio_enviado_en: '2026-11-01T12:00:00', asistencia: null, acompanantes: [], ...extra });

const db = {
  reservas: [
    // CEQ-02: dos reservas de prioridad de la misma persona (no cuentan para su límite)
    fila({ fecha: '2026-11-25', contacto: '0981 555 111 | prioridad@example.com', reservado_por_admin: true }),
    fila({ fecha: '2026-11-26', contacto: '0981 555 111 | prioridad@example.com', reservado_por_admin: true }),
    // CEQ-05: Altillo de hoy (lunes 16/11) que ya terminó, y uno que todavía no
    fila({ id: 801, espacio_id: 1, fecha: '2026-11-16', hora_inicio: '08:00:00', hora_fin: '09:00:00', motivo: 'Estudiar', codigo_cancelacion_hash: sha('ALTILLOTERMINADO') }),
    fila({ id: 802, espacio_id: 1, fecha: '2026-11-16', hora_inicio: '14:00:00', hora_fin: '15:00:00', motivo: 'Estudiar', codigo_cancelacion_hash: sha('ALTILLOMASTARDE') }),
    // CEQ-06: reserva del Frente que se cancela para avisar a la lista de espera
    fila({ id: 803, fecha: '2026-11-27', hora_inicio: '14:00:00', hora_fin: '18:00:00', codigo_cancelacion_hash: sha('FRENTEPARACANCELAR') }),
    // CEQ-09: reservas viejas (más de 6 meses) con motivo de la lista y con motivo libre
    fila({ id: 804, fecha: '2026-03-10', motivo: 'Actividad Personal' }),
    fila({ id: 805, fecha: '2026-03-11', motivo: 'Reunión con Juan Pérez por el congreso', reservado_por_admin: true })
  ],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 2, nombre: 'Sala', publico: false, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'email_alertas', valor: 'alertas@example.com' }],
  registro_actividad: [], bloqueos: [], reportes_errores: [],
  lista_espera: []
};
// 61 inscriptos en la lista del Frente, uno con un correo que Brevo rechaza
for (let i = 1; i <= 61; i++) {
  db.lista_espera.push({ id: i, espacio_id: 3, email: i === 3 ? 'falla-brevo@example.com' : `espera${i}@example.com`,
    creado_en: new Date(Date.UTC(2026, 10, 10, 12, i)).toISOString(), avisado_en: null });
}
const mini = crearMiniPostgrest(db, {
  unicas: { reservas: [['espacio_id', 'fecha', 'hora_inicio']] },
  porDefecto: { reservas: () => ({ created_at: new Date().toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false, cancelada_en: null }) }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3991', SUPABASE_URL: 'http://127.0.0.1:54328', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(CLAVE, 4), SUPERADMIN_PASSWORD_HASH: '', EMAIL_MODERADOR: '', BREVO_LOG: brevoLog,
      RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '600000',
      // Ya no hay correos exentos (CEQ-01): aunque quede la variable vieja en Render, beto tiene límite
      EMAILS_SIN_LIMITE: 'beto@example.com', NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  hijo.salida = () => salida;
  return hijo;
}
const API = 'http://127.0.0.1:3991';
let ipN = 1;
const ip = () => `198.51.100.${ipN++ % 250}`;
async function pedir(metodo, ruta, cuerpo, { admin = false, ipFija, crudo } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ipFija || ip() };
  if (admin) {
    // Con la hora del reloj falso (si no, el servidor lo ve vencido)
    const ahora = Math.floor((Date.now() + JSON.parse(fs.readFileSync(relojArchivo, 'utf8')).desfase_ms) / 1000);
    const token = jwt.sign({ adminId: 'admin', rol: 'admin', v: 1, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
    Object.assign(headers, { cookie: `admin_token=${token}; csrf_token=csrf-prueba`, 'x-csrf-token': 'csrf-prueba' });
  }
  const res = await fetch(API + ruta, { method: metodo, headers, body: crudo !== undefined ? crudo : (cuerpo ? JSON.stringify(cuerpo) : undefined) });
  const texto = await res.text();
  let datos = {}; try { datos = JSON.parse(texto); } catch (e) { /* no es JSON */ }
  return { status: res.status, datos, texto, headers: res.headers };
}
const reservar = extra => pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Ana Gómez', contacto: '0982 123 456 | ana@example.com',
  fecha: '2026-11-17', hora_inicio: '07:00', hora_fin: '10:00', motivo: 'Actividad Personal', ...extra });
const reservasDe = email => db.reservas.filter(r => String(r.contacto).toLowerCase().includes(email));

(async () => {
  await new Promise(ok => mini.servidor.listen(54328, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  const hijo = await arrancar();
  await esperar(1500);

  // ===== CEQ-03: validación antes de guardar =====
  const antes = db.reservas.length;
  const invalidos = [
    [{ contacto: ['0982 123 456 | ana@example.com'] }, 'contacto como lista'],
    [{ contacto: { a: 1 } }, 'contacto como objeto'],
    [{ nombre_solicitante: '     ' }, 'nombre de espacios'],
    [{ nombre_solicitante: '12345' }, 'nombre sin letras'],
    [{ contacto: 'abc | ana@example.com' }, 'celular "abc"'],
    [{ contacto: '12 | ana@example.com' }, 'celular muy corto'],
    [{ contacto: '0982 123 456 | ana' }, 'correo inválido'],
    [{ fecha: '2026-11-31' }, 'fecha que no existe (31/11)'],
    [{ fecha: '2026-11-17T00:00' }, 'fecha con hora'],
    [{ espacio_id: '3abc' }, 'espacio "3abc"'],
    [{ espacio_id: 3.5 }, 'espacio 3.5'],
    [{ motivo: 7 }, 'motivo numérico'],
    [{ hora_inicio: 700 }, 'hora numérica']
  ];
  const estados = [];
  for (const [extra] of invalidos) estados.push((await reservar(extra)).status);
  anotar('Datos inválidos (lista, objeto, nombre vacío, celular "abc", 31/11, espacio "3abc"…): todos 400', estados.every(s => s === 400),
    invalidos.map(([, n], i) => `${n}=${estados[i]}`).join(', '));
  anotar('...y ninguno guardó una fila', db.reservas.length === antes, `${antes} -> ${db.reservas.length}`);
  let r = await pedir('POST', '/api/reservas', null, { crudo: '{"espacio_id": 3, "nombre' });
  anotar('JSON mal escrito: 400 en JSON, sin detalles internos (CEQ-12)', r.status === 400 && r.datos.error === 'JSON inválido' && !/at |node_modules|body-parser/i.test(r.texto), `${r.status} ${r.texto.slice(0, 120)}`);
  r = await pedir('POST', '/api/reservas', null, { crudo: JSON.stringify({ x: 'a'.repeat(200 * 1024) }) });
  anotar('Cuerpo demasiado grande: 413 en JSON (CEQ-12)', r.status === 413 && r.datos.error === 'Solicitud demasiado grande', `${r.status} ${r.texto.slice(0, 80)}`);
  r = await reservar({ nombre_solicitante: '  Ana   Gómez  ', contacto: ' 0982 123 456 |  ANA@Example.com ' });
  const guardada = db.reservas.find(x => x.id === r.datos.reserva?.id) || db.reservas[db.reservas.length - 1];
  anotar('Una reserva válida se guarda con los datos limpios', r.status === 201 && guardada.nombre_solicitante === 'Ana Gómez' && guardada.contacto === '0982 123 456 | ana@example.com',
    `${r.status} ${JSON.stringify(guardada && { n: guardada.nombre_solicitante, c: guardada.contacto })}`);

  // ===== CEQ-02: límite del Frente contado y guardado juntos =====
  const fechas = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24'];
  const simultaneas = await Promise.all(fechas.map(f => pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Beto Ruiz',
    contacto: '0983 444 555 | beto@example.com', fecha: f, hora_inicio: '10:00', hora_fin: '13:00', motivo: 'Actividad Personal' })));
  const exitos = simultaneas.filter(x => x.status === 201).length;
  anotar('Frente: 5 pedidos simultáneos de la misma persona con límite 2 → exactamente 2 reservas', exitos === 2 && reservasDe('beto@example.com').length === 2,
    simultaneas.map(x => x.status).join(','));
  const rechazo = simultaneas.find(x => x.status === 400);
  anotar('...y los otros reciben el mensaje del límite', rechazo && /Ya tenés 2 reservas activas en Frente/.test(rechazo.datos.error), rechazo && rechazo.datos.error);
  r = await pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Beto Ruiz', contacto: '0983 999 999 | BETO@example.com',
    fecha: '2026-11-25', hora_inicio: '14:00', hora_fin: '18:00', motivo: 'Actividad Personal' });
  anotar('Cambiar solo el celular no saltea el límite (se reconoce por correo)', r.status === 400, String(r.status));
  r = await pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Beto Ruiz', contacto: '+595 983 444 555 | otro@example.com',
    fecha: '2026-11-25', hora_inicio: '14:00', hora_fin: '18:00', motivo: 'Actividad Personal' });
  anotar('Cambiar solo el correo no saltea el límite (se reconoce por celular, con o sin +595)', r.status === 400, String(r.status));

  const prio = [];
  for (const f of ['2026-11-18', '2026-11-19']) {
    prio.push((await pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Carla Prioridad', contacto: '0981 555 111 | prioridad@example.com',
      fecha: f, hora_inicio: '14:00', hora_fin: '18:00', motivo: 'Actividad Personal' })).status);
  }
  anotar('Las reservas de prioridad del panel no cuentan: con 2 de prioridad igual puede hacer sus 2', prio.every(s => s === 201), prio.join(','));

  const altillo = [];
  for (const [f, h] of [['2026-11-17', '08'], ['2026-11-18', '08'], ['2026-11-19', '08'], ['2026-11-20', '08']]) {
    altillo.push((await pedir('POST', '/api/reservas', { espacio_id: 1, nombre_solicitante: 'Dani Altillo', contacto: '0984 777 888 | dani@example.com',
      fecha: f, hora_inicio: `${h}:00`, hora_fin: `${Number(h) + 1}:00`.padStart(5, '0'), motivo: 'Estudiar' })).status);
  }
  anotar('El Altillo no tiene límite por persona: 4 reservas en el mes, todas aceptadas', altillo.every(s => s === 201), altillo.join(','));

  // ===== CEQ-04: Altillo en horas completas y bloqueos según el espacio =====
  r = await pedir('POST', '/api/reservas', { espacio_id: 1, nombre_solicitante: 'Dani Altillo', contacto: '0984 777 888 | dani@example.com',
    fecha: '2026-11-23', hora_inicio: '08:30', hora_fin: '10:00', motivo: 'Estudiar' });
  anotar('Altillo 08:30-10:00: rechazado (solo horas completas)', r.status === 400 && /horas completas/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/bloqueos', { espacio_id: 1, fecha: '2026-11-24', hora_inicio: '18:00', hora_fin: '19:00', motivo: 'Limpieza' }, { admin: true });
  anotar('Bloquear el Altillo de 18:00 a 19:00 (antes el tope era 18:00) ahora se puede', [200, 201].includes(r.status), `${r.status} ${JSON.stringify(r.datos).slice(0, 100)}`);
  r = await pedir('POST', '/api/bloqueos', { espacio_id: 1, fecha: '2026-11-24', hora_inicio: '18:00', hora_fin: '20:00' }, { admin: true });
  anotar('Bloquear el Altillo hasta las 20:00: rechazado (cierra a las 19:00)', r.status === 400 && /07:00-19:00/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/bloqueos', { espacio_id: 3, fecha: '2026-11-24', hora_inicio: '06:00', hora_fin: '07:00' }, { admin: true });
  anotar('Bloquear el Frente fuera de sus turnos (06:00): rechazado con el rango de los turnos', r.status === 400 && /07:00-18:00/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/bloqueos', { espacio_id: 3, fecha: '2026-02-30', hora_inicio: '07:00', hora_fin: '10:00' }, { admin: true });
  anotar('Bloqueo en una fecha que no existe (30/02): rechazado', r.status === 400, String(r.status));

  // ===== CEQ-05: no se cancela un turno que ya terminó =====
  r = await pedir('POST', '/api/cancelar-por-codigo', { codigo: 'ALTILLOTERMINADO' });
  anotar('Altillo de hoy 08:00-09:00, a las 10:00: no se puede cancelar', r.status === 400 && /ya pasó/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  anotar('...y sigue activa', db.reservas.find(x => x.id === 801).estado === 'activa');
  r = await pedir('POST', '/api/cancelar-por-codigo', { codigo: 'ALTILLOMASTARDE' });
  anotar('Altillo de hoy 14:00-15:00, a las 10:00: se cancela normalmente', r.status === 200 && db.reservas.find(x => x.id === 802).estado === 'cancelada', `${r.status} ${JSON.stringify(r.datos)}`);

  // ===== CEQ-06: lista de espera con el tope diario =====
  await esperar(1000); // el aviso del Altillo cancelado no tiene lista
  const antesCorreos = correos().length;
  r = await pedir('POST', '/api/cancelar-por-codigo', { codigo: 'FRENTEPARACANCELAR' });
  anotar('Se cancela una reserva del Frente con 61 personas en la lista de espera', r.status === 200, `${r.status} ${JSON.stringify(r.datos)}`);
  for (let i = 0; i < 100 && correos().slice(antesCorreos).filter(c => c.subject.startsWith('Se liberó')).length < 59; i++) await esperar(100);
  await esperar(500);
  const avisos = correos().slice(antesCorreos).filter(c => c.subject.startsWith('Se liberó'));
  const avisadas = db.lista_espera.filter(x => x.avisado_en);
  const pendientes = db.lista_espera.filter(x => !x.avisado_en).map(x => x.email);
  anotar('Se toman solo 60 (el tope del día); salen 59 avisos porque uno falla en Brevo', avisos.length === 59, String(avisos.length));
  anotar('Quedan marcadas como avisadas solo las 59 que lo recibieron', avisadas.length === 59, String(avisadas.length));
  anotar('La que falló y la número 61 siguen pendientes para el próximo turno', pendientes.length === 2 && pendientes.includes('falla-brevo@example.com') && pendientes.includes('espera61@example.com'), pendientes.join(', '));

  // ===== CEQ-13: el enlace de cancelación no queda en el registro del 429 =====
  for (let i = 0; i < 22; i++) await pedir('GET', '/api/cancelar-por-enlace?r=999&t=TOKENSECRETO123', null, { ipFija: '203.0.113.77' });
  await esperar(300);
  const log = hijo.salida();
  anotar('El aviso de 429 se registra sin el token del enlace', /429 rate limit/.test(log) && !log.includes('TOKENSECRETO123'), (log.match(/.*429 rate limit.*/) || [''])[0]);

  // ===== CEQ-10: cookie de sesión solo para la API =====
  r = await pedir('POST', '/api/login', { password: CLAVE });
  const setCookie = r.headers.getSetCookie();
  const nueva = setCookie.find(c => c.startsWith('admin_token=') && !c.startsWith('admin_token=;'));
  const borraVieja = setCookie.find(c => c.startsWith('admin_token=;') && /Domain=\.?ceq-una\.com/i.test(c));
  const csrf = setCookie.find(c => c.startsWith('csrf_token='));
  anotar('Login: la cookie del token NO lleva Domain (solo api.ceq-una.com)', r.status === 200 && nueva && !/Domain=/i.test(nueva) && /HttpOnly/i.test(nueva) && /Secure/i.test(nueva), nueva);
  anotar('...borra la cookie vieja de .ceq-una.com', !!borraVieja, setCookie.join(' || '));
  anotar('...y la del CSRF sigue en .ceq-una.com para que el panel la lea', csrf && /Domain=\.?ceq-una\.com/i.test(csrf) && !/HttpOnly/i.test(csrf), csrf);
  r = await pedir('POST', '/api/logout');
  const borra = r.headers.getSetCookie();
  anotar('Cerrar sesión borra las dos versiones del token y el CSRF', borra.filter(c => c.startsWith('admin_token=;')).length === 2 && borra.some(c => c.startsWith('csrf_token=;')), borra.join(' || '));

  // ===== CEQ-09: el motivo libre se borra a los 6 meses =====
  hijo.kill(); await esperar(300);
  ponerHora('2026-11-17T12:00:00Z');
  const hijo2 = await arrancar();
  await esperar(2500);
  await pedir('GET', '/api/health');
  // la tarea diaria corre a los pocos segundos de arrancar
  for (let i = 0; i < 100 && db.reservas.find(x => x.id === 805).nombre_solicitante !== '(datos eliminados)'; i++) await esperar(200);
  await esperar(1000); // el motivo se borra en un paso posterior de la misma tarea
  const r804 = db.reservas.find(x => x.id === 804), r805 = db.reservas.find(x => x.id === 805);
  anotar('Reserva vieja del Frente con motivo de la lista: se anonimiza y conserva el motivo', r804.nombre_solicitante === '(datos eliminados)' && r804.motivo === 'Actividad Personal', JSON.stringify({ n: r804.nombre_solicitante, m: r804.motivo }));
  anotar('Reserva vieja de prioridad con motivo libre: se borra también el motivo', r805.nombre_solicitante === '(datos eliminados)' && r805.motivo === '', JSON.stringify({ n: r805.nombre_solicitante, m: r805.motivo }));
  hijo2.kill();

  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
