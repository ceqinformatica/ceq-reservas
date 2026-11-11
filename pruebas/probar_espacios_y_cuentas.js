// Prueba los espacios que se crean desde el panel (por turnos o por bloques, públicos o "solo por
// moderador") y las cuentas del panel con usuario y contraseña, cada una con sus espacios.
// Con el server.js real, Supabase simulado y Brevo interceptado.
// Uso: node probar_espacios_y_cuentas.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const bcrypt = require(require.resolve('bcryptjs', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-esp-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-esp-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const ahoraFalso = () => Date.now() + desfase;
const SECRETO = 'secreto-espacios-y-cuentas';
const CLAVE_ADMIN = 'clave-de-prueba-local';
const CLAVE_SUPREMO = 'clave-suprema-de-prueba';
const CLAVE_CUENTA = 'clave-del-polideportivo';

const reserva = (extra = {}) => ({
  espacio_id: 3, nombre_solicitante: 'Persona', contacto: '0981 000 000 | persona@example.com', fecha: '2026-11-18', hora_inicio: '07:00:00', hora_fin: '10:00:00',
  estado: 'activa', motivo: 'Actividad Personal', codigo_cancelacion_hash: 'x', reservado_por_admin: false, acompanantes: [], asistencia: null,
  created_at: '2026-11-01T12:00:00', cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, recordatorio_enviado_en: null, ...extra
});
const db = {
  reservas: [reserva({ id: 701, nombre_solicitante: 'Del Frente' }), reserva({ id: 702, espacio_id: 1, nombre_solicitante: 'Del Altillo', hora_inicio: '09:00:00', hora_fin: '10:00:00', motivo: 'Estudio' })],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }, { clave: 'email_alertas', valor: 'alertas@example.com' }],
  registro_actividad: [], reportes_errores: [], bloqueos: [], lista_espera: [], correos_pendientes: []
};
let proximoEspacio = 4;
const mini = crearMiniPostgrest(db, {
  unicas: { configuracion: [['clave']], lista_espera: [['espacio_id', 'email', 'mes']] },
  porDefecto: {
    espacios: () => ({ id: proximoEspacio++ }),
    reservas: () => ({ created_at: new Date(ahoraFalso()).toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false, cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, acompanantes: [] }),
    registro_actividad: () => ({ creado_en: new Date(ahoraFalso()).toISOString() }),
    reportes_errores: () => ({ created_at: new Date(ahoraFalso()).toISOString().replace('Z', ''), estado: 'nuevo', nota: null }),
    lista_espera: () => ({ creado_en: new Date(ahoraFalso()).toISOString(), avisado_en: null }),
    correos_pendientes: () => ({ intentos: 0, reclamado_hasta: null, ultimo_error: null, enviado_en: null })
  }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3985', SUPABASE_URL: 'http://127.0.0.1:54338', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(CLAVE_ADMIN, 4), SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(CLAVE_SUPREMO, 4),
      EMAIL_MODERADOR: 'moderador@example.com', EMAIL_MODERADOR_FRENTE: 'moderador@example.com',
      BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '600000', INTERVALO_COLA_CORREOS_MS: '300', NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3985';
let ipN = 1;
// quien: 'superadmin' o 'admin' (un token armado acá), o { cookie } (la sesión que devolvió el login)
async function pedir(metodo, ruta, cuerpo, quien) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.18.${Math.floor(ipN / 250)}.${ipN++ % 250 + 1}` };
  if (typeof quien === 'string') {
    const ahora = Math.floor(ahoraFalso() / 1000);
    const token = jwt.sign({ adminId: 'admin', rol: quien, v: 1, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
    Object.assign(headers, { cookie: `admin_token=${token}; csrf_token=csrf`, 'x-csrf-token': 'csrf' });
  } else if (quien && quien.cookie) {
    Object.assign(headers, { cookie: `admin_token=${quien.cookie}; csrf_token=csrf`, 'x-csrf-token': 'csrf' });
  }
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const texto = await res.text();
  let datos = {};
  try { datos = JSON.parse(texto); } catch (e) { datos = { texto }; }
  const galleta = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(c => c.match(/^admin_token=([^;]+)/)).filter(m => m && m[1]).map(m => m[1]).pop();
  return { status: res.status, datos, cookie: galleta };
}
const entrar = (usuario, password) => pedir('POST', '/api/login', usuario === null ? { password } : { usuario, password });
let celular = 300;
const datosReserva = (espacio, fecha, ini, fin, motivo, email) => ({
  espacio_id: espacio, nombre_solicitante: 'Persona Prueba', contacto: `0985 ${celular++} 222 | ${email || `p${celular}@example.com`}`, fecha, hora_inicio: ini, hora_fin: fin, motivo
});

(async () => {
  await new Promise(ok => mini.servidor.listen(54338, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  const hijo = await arrancar();
  await esperar(800);
  let r;

  // ===== 1. Crear un espacio por turnos que se reserva solo a través de un moderador =====
  r = await pedir('POST', '/api/superadmin/espacios', { nombre: 'Polideportivo', modo: 'moderador', horario: 'turnos',
    turnos: [{ nombre: 'Mañana', inicio: '08:00', fin: '12:00' }, { nombre: 'Tarde', inicio: '14:00', fin: '18:00' }],
    contacto_email: 'deportes@example.com', contacto_texto: 'Para reservar el Polideportivo escribí a deportes@example.com' }, 'admin');
  anotar('Un admin común no puede crear espacios (403)', r.status === 403, String(r.status));
  r = await pedir('POST', '/api/superadmin/espacios', { nombre: 'P', horario: 'turnos', turnos: [{ nombre: 'Mañana', inicio: '08:00', fin: '12:00' }] }, 'superadmin');
  anotar('Un nombre de 1 letra no se acepta (400)', r.status === 400, `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/superadmin/espacios', { nombre: 'Polideportivo', modo: 'moderador', horario: 'turnos',
    turnos: [{ nombre: 'Mañana', inicio: '08:00', fin: '12:00' }, { nombre: 'Tarde', inicio: '14:00', fin: '18:00' }],
    contacto_email: 'deportes@example.com', contacto_texto: 'Para reservar el Polideportivo escribí a deportes@example.com' }, 'superadmin');
  const poli = r.datos.id;
  const filaPoli = db.espacios.find(e => e.id === poli);
  anotar('El admin supremo crea el Polideportivo (201) y queda sin publicar', r.status === 201 && !!filaPoli && filaPoli.publico === false && filaPoli.nombre === 'Polideportivo', `${r.status} ${JSON.stringify(r.datos).slice(0, 200)}`);
  r = await pedir('POST', '/api/superadmin/espacios', { nombre: 'polideportivo', horario: 'bloques' }, 'superadmin');
  anotar('No se puede crear otro con el mismo nombre (409)', r.status === 409, String(r.status));
  r = await pedir('POST', `/api/superadmin/espacios/${poli}`, { publico: true }, 'superadmin');
  anotar('Se publica desde "Espacios disponibles" (200)', r.status === 200 && filaPoli.publico === true, String(r.status));

  r = await pedir('GET', '/api/configuracion');
  const defPoli = (r.datos.espacios || {})[poli] || {};
  anotar('La configuración pública trae el espacio nuevo: por turnos, solo por moderador y con su cartel',
    defPoli.nombre === 'Polideportivo' && defPoli.modo === 'moderador' && defPoli.horario === 'turnos' && defPoli.turnos.length === 2 && /deportes@example.com/.test(defPoli.aviso_moderador || ''),
    JSON.stringify(defPoli).slice(0, 300));
  anotar('...y sigue trayendo el Frente (turnos) y el Altillo (bloques) como siempre, con sus reglas',
    r.datos.espacios[3].horario === 'turnos' && r.datos.espacios[1].horario === 'bloques' && r.datos.espacios[3].modo === 'publico' && !!r.datos.reglas[poli] && r.datos.turnos_frente.length === 3,
    JSON.stringify(Object.keys(r.datos.reglas)));

  // ===== 2. El público ve pero no reserva =====
  r = await pedir('POST', '/api/reservas', datosReserva(poli, '2026-11-19', '08:00', '12:00', 'Partido'));
  anotar('El público no puede reservar el Polideportivo: 403 con el cartel de contacto', r.status === 403 && r.datos.solo_moderador === true && /deportes@example.com/.test(r.datos.error), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/lista-espera', { espacio_id: poli, email: 'lola@example.com', nombre: 'Lola Espera', mes: '2026-11' });
  anotar('...ni anotarse en una lista de espera (400)', r.status === 400, String(r.status));

  // ===== 3. Cuentas con usuario y contraseña =====
  r = await pedir('POST', '/api/superadmin/usuarios', { usuario: 'polideportivo', nombre: 'Secretaría de Deportes', password: 'corta', espacios: [poli] }, 'superadmin');
  anotar('Una contraseña de menos de 10 caracteres no se acepta (400)', r.status === 400, String(r.status));
  r = await pedir('POST', '/api/superadmin/usuarios', { usuario: 'supremo', password: CLAVE_CUENTA, espacios: [poli] }, 'superadmin');
  anotar('No se puede crear una cuenta con un usuario reservado (400)', r.status === 400, String(r.status));
  r = await pedir('POST', '/api/superadmin/usuarios', { usuario: 'polideportivo', password: CLAVE_CUENTA, espacios: [999] }, 'superadmin');
  anotar('Una cuenta necesita al menos un espacio que exista (400)', r.status === 400, String(r.status));
  r = await pedir('POST', '/api/superadmin/usuarios', { usuario: 'Polideportivo', nombre: 'Secretaría de Deportes', password: CLAVE_CUENTA, espacios: [poli] }, 'admin');
  anotar('Un admin común no puede crear cuentas (403)', r.status === 403, String(r.status));
  r = await pedir('POST', '/api/superadmin/usuarios', { usuario: 'Polideportivo', nombre: 'Secretaría de Deportes', password: CLAVE_CUENTA, espacios: [poli] }, 'superadmin');
  const filaCuentas = () => JSON.parse((db.configuracion.find(c => c.clave === 'usuarios_panel') || { valor: '[]' }).valor);
  anotar('El admin supremo crea la cuenta "polideportivo" (201); la contraseña se guarda cifrada',
    r.status === 201 && filaCuentas().length === 1 && filaCuentas()[0].usuario === 'polideportivo' && /^\$2/.test(filaCuentas()[0].hash) && !JSON.stringify(r.datos).includes('hash'),
    `${r.status} ${JSON.stringify(r.datos).slice(0, 200)}`);

  r = await entrar('polideportivo', 'otra-clave-equivocada');
  anotar('Con la contraseña equivocada no entra (401)', r.status === 401, String(r.status));
  r = await entrar('nadie', CLAVE_CUENTA);
  anotar('Un usuario que no existe no entra (401)', r.status === 401, String(r.status));
  r = await entrar('polideportivo', CLAVE_CUENTA);
  const sesionPoli = { cookie: r.cookie };
  anotar('La cuenta entra con su usuario y su contraseña (200, rol admin)', r.status === 200 && r.datos.rol === 'admin' && !!r.cookie, `${r.status} ${JSON.stringify(r.datos)}`);
  r = await pedir('GET', '/api/admin/verificar-sesion', null, sesionPoli);
  anotar('...y su panel es solo del Polideportivo, sin lo general',
    r.status === 200 && r.datos.usuario === 'polideportivo' && r.datos.espacios.length === 1 && r.datos.espacios[0].id === poli && r.datos.espacios[0].nombre === 'Polideportivo' && r.datos.general === false,
    JSON.stringify(r.datos));

  r = await entrar(null, CLAVE_ADMIN);
  anotar('Sin usuario, la contraseña compartida sigue entrando como antes (admin)', r.status === 200 && r.datos.rol === 'admin', `${r.status} ${JSON.stringify(r.datos)}`);
  const sesionModeradores = { cookie: r.cookie };
  r = await pedir('GET', '/api/admin/verificar-sesion', null, sesionModeradores);
  anotar('...es la cuenta "moderadores": Frente y Altillo, con lo general', r.datos.usuario === 'moderadores' && r.datos.espacios.map(e => e.id).sort().join() === '1,3' && r.datos.general === true, JSON.stringify(r.datos));
  r = await entrar('supremo', CLAVE_SUPREMO);
  anotar('El usuario "supremo" con su contraseña entra como admin supremo', r.status === 200 && r.datos.rol === 'superadmin', `${r.status} ${JSON.stringify(r.datos)}`);
  r = await entrar('moderadores', CLAVE_SUPREMO);
  anotar('...pero esa contraseña no sirve con el usuario "moderadores" (401)', r.status === 401, String(r.status));
  r = await entrar('supremo', CLAVE_ADMIN);
  anotar('...ni la compartida con el usuario "supremo" (401)', r.status === 401, String(r.status));

  // ===== 4. La cuenta del espacio carga las reservas y no toca los otros espacios =====
  r = await pedir('POST', '/api/admin/reservas', datosReserva(poli, '2026-11-19', '09:00', '11:00', 'Partido de fútbol', 'ana@example.com'), sesionPoli);
  anotar('Un horario que no es un turno del espacio no se acepta (400)', r.status === 400 && /Turno inválido para Polideportivo/.test(r.datos.error), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/admin/reservas', datosReserva(poli, '2026-11-19', '08:00', '12:00', 'Partido de fútbol', 'ana@example.com'), sesionPoli);
  const idPoli = r.datos.reserva && r.datos.reserva.id;
  anotar('La cuenta del Polideportivo carga una reserva en su espacio (200)', r.status === 200 && !!idPoli && db.reservas.find(x => x.id === idPoli).espacio_id === poli, `${r.status} ${r.datos.error || ''}`);
  // (Que el mismo turno no se pueda cargar dos veces lo garantiza la base: se prueba en probar_esquema)
  r = await pedir('GET', '/api/reservas');
  const publica = (r.datos || []).find(x => x.espacio_id === poli);
  anotar('La reserva se ve en el calendario público con nombre y motivo, sin contacto', !!publica && publica.nombre_solicitante === 'Persona Prueba' && publica.motivo === 'Partido de fútbol' && !('contacto' in publica), JSON.stringify(publica));
  r = await pedir('POST', '/api/admin/reservas', datosReserva(3, '2026-11-19', '07:00', '10:00', 'Actividad Personal'), sesionPoli);
  anotar('No puede cargar reservas en el Frente (403)', r.status === 403, String(r.status));
  r = await pedir('GET', '/api/admin/reservas', null, sesionPoli);
  anotar('En su lista de reservas solo están las de su espacio', r.status === 200 && r.datos.length === 1 && r.datos[0].espacio_id === poli, `${r.status} ${r.datos.length}`);
  r = await pedir('POST', '/api/admin/cancelar/701', { motivo: 'no debería' }, sesionPoli);
  anotar('No puede cancelar una reserva del Frente (403)', r.status === 403 && db.reservas.find(x => x.id === 701).estado === 'activa', String(r.status));
  r = await pedir('POST', '/api/admin/reservas/701/asistencia', { asistencia: 'vino' }, sesionPoli);
  anotar('...ni marcarle la asistencia (403)', r.status === 403, String(r.status));
  r = await pedir('POST', '/api/bloqueos', { espacio_id: 3, fecha: '2026-11-20', hora_inicio: '00:00:00', hora_fin: '23:59:00', motivo: 'x' }, sesionPoli);
  anotar('...ni bloquear el Frente (403)', r.status === 403 && db.bloqueos.length === 0, String(r.status));
  r = await pedir('POST', '/api/bloqueos', { espacio_id: poli, fecha: '2026-11-20', hora_inicio: '00:00:00', hora_fin: '23:59:00', motivo: 'Mantenimiento' }, sesionPoli);
  anotar('Sí puede bloquear un día de su espacio (201)', r.status === 201 && db.bloqueos.length === 1, `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/admin/meses-habilitados', { anio: 2026, mes: 12, habilitado: true }, sesionPoli);
  const meses = r.status;
  r = await pedir('GET', '/api/admin/reportes', null, sesionPoli);
  anotar('Sin "lo general" no habilita meses ni ve los reportes (403)', meses === 403 && r.status === 403, `${meses} ${r.status}`);
  r = await pedir('GET', '/api/superadmin/estado', null, sesionPoli);
  anotar('...ni entra a lo del admin supremo (403)', r.status === 403, String(r.status));
  r = await pedir('POST', '/api/admin/reservas', datosReserva(poli, '2026-11-23', '08:00', '12:00', 'Torneo'), sesionModeradores);
  anotar('La cuenta "moderadores" no maneja el Polideportivo (403)', r.status === 403, String(r.status));
  r = await pedir('GET', '/api/admin/reservas', null, sesionModeradores);
  anotar('...y en su lista ve el Frente y el Altillo, no el Polideportivo', r.status === 200 && r.datos.length === 2 && r.datos.every(x => x.espacio_id !== poli), `${r.status} ${r.datos.length}`);
  r = await pedir('GET', '/api/admin/reservas', null, 'superadmin');
  anotar('El admin supremo ve las de todos los espacios', r.status === 200 && r.datos.length === 3, `${r.status} ${r.datos.length}`);
  r = await pedir('POST', `/api/admin/cancelar/${idPoli}`, { motivo: 'Se suspendió' }, sesionPoli);
  anotar('La cuenta cancela una reserva de su espacio (200)', r.status === 200 && db.reservas.find(x => x.id === idPoli).estado === 'cancelada', String(r.status));
  await esperar(400); // el registro se guarda después de responder
  anotar('El registro de actividad dice qué cuenta lo hizo', db.registro_actividad.some(a => a.accion === 'Canceló una reserva' && /cuenta: polideportivo/.test(a.detalle)), JSON.stringify(db.registro_actividad.slice(-2)));

  // ===== 5. Cambiar la contraseña cierra la sesión de la cuenta =====
  r = await pedir('POST', '/api/superadmin/usuarios', { usuario: 'polideportivo', nombre: 'Secretaría de Deportes', password: 'una-clave-nueva-y-larga', espacios: [poli], general: true }, 'superadmin');
  anotar('El admin supremo le cambia la contraseña y le da "lo general" (200)', r.status === 200, String(r.status));
  r = await pedir('GET', '/api/admin/verificar-sesion', null, sesionPoli);
  anotar('...y la sesión anterior deja de valer (401)', r.status === 401, String(r.status));
  r = await entrar('polideportivo', 'una-clave-nueva-y-larga');
  const sesionPoli2 = { cookie: r.cookie };
  r = await pedir('GET', '/api/admin/reportes', null, sesionPoli2);
  anotar('Con la contraseña nueva entra y ahora sí ve los reportes', r.status === 200, String(r.status));

  // ===== 6. Un espacio por bloques, abierto al público, con motivos de una lista =====
  r = await pedir('POST', '/api/superadmin/espacios', { nombre: 'Sala de estudio', horario: 'bloques', hora_desde: 8, hora_hasta: 12, max_horas: 2, motivos: ['Estudio', 'Reunión'] }, 'superadmin');
  const sala = r.datos.id;
  await pedir('POST', `/api/superadmin/espacios/${sala}`, { publico: true }, 'superadmin');
  anotar('Se crea un espacio por bloques de 1 hora (201)', r.status === 201 && sala !== poli, `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/reservas', datosReserva(sala, '2026-11-19', '09:30', '10:30', 'Estudio'));
  anotar('Solo horas completas (400)', r.status === 400 && /bloques de horas completas/.test(r.datos.error), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/reservas', datosReserva(sala, '2026-11-19', '08:00', '11:00', 'Estudio'));
  anotar('No más horas que el máximo del espacio (400)', r.status === 400 && /entre 1 y 2 horas/.test(r.datos.error), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/reservas', datosReserva(sala, '2026-11-19', '11:00', '13:00', 'Estudio'));
  anotar('No fuera de su horario (400)', r.status === 400 && /Horario fuera de rango \(08:00-12:00\)/.test(r.datos.error), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/reservas', datosReserva(sala, '2026-11-19', '09:00', '11:00', 'Fiesta'));
  anotar('El motivo tiene que ser de la lista del espacio (400)', r.status === 400 && /motivo de la lista/.test(r.datos.error), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/reservas', datosReserva(sala, '2026-11-19', '09:00', '11:00', 'Estudio', 'beto@example.com'));
  const idSala = r.datos.reserva && r.datos.reserva.id;
  anotar('El público reserva el espacio nuevo (201)', r.status === 201 && !!idSala, `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/reservas', datosReserva(3, '2026-11-19', '07:00', '10:00', 'Actividad Personal'));
  const frente = r.status;
  r = await pedir('POST', '/api/reservas', datosReserva(1, '2026-11-19', '14:00', '15:00', 'Estudio para el parcial'));
  anotar('El Frente y el Altillo se siguen reservando como siempre (201 y 201)', frente === 201 && r.status === 201, `${frente} ${r.status}`);
  r = await pedir('POST', '/api/bloqueos', { espacio_id: sala, fecha: '2026-11-23', hora_inicio: '07:00', hora_fin: '09:00', motivo: 'x' }, 'superadmin');
  anotar('Un bloqueo fuera del horario del espacio no se acepta (400)', r.status === 400 && /08:00-12:00/.test(r.datos.error), `${r.status} ${r.datos.error || ''}`);

  // ===== 7. Cambiar y quitar espacios =====
  r = await pedir('PUT', `/api/superadmin/espacios/${sala}/definicion`, { nombre: 'Sala de estudio', horario: 'bloques', hora_desde: 10, hora_hasta: 12, max_horas: 2, motivos: ['Estudio'] }, 'superadmin');
  anotar('No se achica el horario por debajo de una reserva activa (409)', r.status === 409 && new RegExp('#' + idSala).test(r.datos.error), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('PUT', `/api/superadmin/espacios/${sala}/definicion`, { nombre: 'Sala de lectura', horario: 'bloques', hora_desde: 8, hora_hasta: 13, max_horas: 3, motivos: [] }, 'superadmin');
  anotar('Sí se le cambia el nombre y se amplía (200)', r.status === 200 && db.espacios.find(e => e.id === sala).nombre === 'Sala de lectura', `${r.status} ${r.datos.error || ''}`);
  r = await pedir('DELETE', `/api/superadmin/espacios/${sala}`, null, 'superadmin');
  anotar('Un espacio con reservas activas que no pasaron no se puede quitar (409)', r.status === 409, String(r.status));
  await pedir('POST', `/api/admin/cancelar/${idSala}`, { motivo: 'Se quita el espacio' }, 'superadmin');
  r = await pedir('DELETE', `/api/superadmin/espacios/${sala}`, null, 'superadmin');
  anotar('Cancelada la reserva, se quita: deja de usarse y sus reservas anteriores se conservan', r.status === 200 && db.reservas.some(x => x.id === idSala) && db.espacios.find(e => e.id === sala).publico === false, `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/reservas', datosReserva(sala, '2026-11-24', '09:00', '10:00', 'Estudio'));
  anotar('...y ya no se puede reservar (400)', r.status === 400, String(r.status));
  r = await pedir('DELETE', '/api/superadmin/espacios/3', null, 'superadmin');
  anotar('El Frente no se puede quitar (400)', r.status === 400, String(r.status));

  r = await pedir('PUT', '/api/superadmin/espacios/3/definicion', { modo: 'moderador', contacto_texto: 'El Frente se reserva por la Secretaría' }, 'superadmin');
  const cambio = r.status;
  r = await pedir('POST', '/api/reservas', datosReserva(3, '2026-11-24', '07:00', '10:00', 'Actividad Personal'));
  anotar('El Frente también se puede pasar a "solo por moderador": el público recibe 403 con el cartel', cambio === 200 && r.status === 403 && /Secretaría/.test(r.datos.error), `${cambio} ${r.status} ${r.datos.error || ''}`);
  await pedir('PUT', '/api/superadmin/espacios/3/definicion', { modo: 'publico' }, 'superadmin');
  r = await pedir('POST', '/api/reservas', datosReserva(3, '2026-11-24', '07:00', '10:00', 'Actividad Personal'));
  anotar('...y volver a abrirlo al público (201)', r.status === 201, `${r.status} ${r.datos.error || ''}`);

  // ===== 8. Detector de abusos e informe del período =====
  const conContacto = (fecha, contacto, nombre) => pedir('POST', '/api/reservas', { ...datosReserva(3, fecha, '10:00', '13:00', 'Actividad Personal'), contacto, nombre_solicitante: nombre });
  await conContacto('2026-11-25', '0971 111 222 | uno@example.com', 'Marta Dos Correos');
  await conContacto('2026-11-26', '+595 971 111 222 | dos@example.com', 'Marta Dos Correos');
  // La misma persona con todo distinto: así sí se saltea el límite de 2 por mes del Frente
  const trampa = [];
  for (const [fecha, contacto] of [['2026-11-17', '0972 300 001 | carlos1@example.com'], ['2026-11-18', '0972 300 002 | carlos2@example.com'], ['2026-11-20', '0972 300 003 | carlos3@example.com']]) {
    trampa.push((await conContacto(fecha, contacto, fecha === '2026-11-18' ? 'TRAMPA  Carlós' : 'Carlos Trampa')).status);
  }
  await esperar(400); // la huella de la red se guarda después de responder
  r = await pedir('GET', '/api/superadmin/abusos', null, 'admin');
  anotar('El detector de abusos es solo del admin supremo (403)', r.status === 403, String(r.status));
  r = await pedir('GET', '/api/superadmin/abusos', null, 'superadmin');
  const casoCelular = (r.datos.casos || []).find(c => c.tipo === 'celular');
  const casoNombre = (r.datos.casos || []).find(c => c.tipo === 'nombre');
  anotar('Detector: el mismo celular con dos correos aparece como un caso (sin pasar el límite)',
    r.status === 200 && !!casoCelular && casoCelular.reservas.length === 2 && casoCelular.pasa_el_limite === false, JSON.stringify(r.datos).slice(0, 300));
  anotar('Detector: el mismo nombre con correo y celular distintos, 3 reservas en el mes: pasa el límite y sale primero',
    trampa.join() === '201,201,201' && !!casoNombre && casoNombre.reservas.length === 3 && casoNombre.pasa_el_limite === true && r.datos.casos[0].tipo === 'nombre',
    `${trampa.join()} ${JSON.stringify((r.datos.casos || []).map(c => [c.tipo, c.reservas.length, c.pasa_el_limite]))}`);
  const conHuella = db.reservas.filter(x => !x.reservado_por_admin && typeof x.huella_red === 'string' && x.huella_red.length === 16);
  anotar('Las reservas hechas desde la página guardan la huella de la red (cifrada, no la dirección); las cargadas por un moderador, no',
    conHuella.length >= 5 && !db.reservas.some(x => x.reservado_por_admin && x.huella_red) && !conHuella.some(x => /\d+\.\d+\.\d+/.test(x.huella_red)), String(conHuella.length));

  r = await pedir('GET', '/api/superadmin/informe', null, 'admin');
  anotar('El informe del período es solo del admin supremo (403)', r.status === 403, String(r.status));
  r = await pedir('GET', '/api/superadmin/informe?desde=2026-12-01&hasta=2026-11-01', null, 'superadmin');
  anotar('Informe: fechas al revés no se aceptan (400)', r.status === 400, String(r.status));
  r = await pedir('GET', '/api/superadmin/informe', null, 'superadmin');
  const delFrente = (r.datos.por_espacio || []).find(x => x.espacio === 'Frente') || {};
  anotar('Informe: por defecto toma el semestre en curso y cuenta por espacio, por mes y las canceladas',
    r.status === 200 && r.datos.desde === '2026-07-01' && r.datos.hasta === '2026-12-31' && r.datos.total === db.reservas.length && delFrente.total >= 6 &&
    r.datos.canceladas === db.reservas.filter(x => x.estado !== 'activa').length && r.datos.por_mes.some(m => m.mes === '2026-11') && (r.datos.por_espacio || []).some(x => x.espacio === 'Polideportivo'),
    JSON.stringify(r.datos).slice(0, 300));
  anotar('Informe: no lleva nombres ni contactos', !/example\.com|0971|Carlos|Marta/.test(JSON.stringify(r.datos)), '');

  // ===== 9. Borrar una cuenta cierra su sesión =====
  r = await pedir('DELETE', '/api/superadmin/usuarios/polideportivo', null, 'superadmin');
  const borrada = r.status;
  r = await pedir('GET', '/api/admin/verificar-sesion', null, sesionPoli2);
  anotar('Al borrar la cuenta, su sesión deja de valer (401) y ya no puede entrar', borrada === 200 && r.status === 401 && (await entrar('polideportivo', 'una-clave-nueva-y-larga')).status === 401, `${borrada} ${r.status}`);
  r = await pedir('GET', '/api/superadmin/usuarios', null, 'superadmin');
  anotar('La lista de cuentas muestra siempre "supremo" y "moderadores", sin contraseñas', r.status === 200 && r.datos.cuentas.length === 2 && !JSON.stringify(r.datos).includes('$2'), JSON.stringify(r.datos).slice(0, 200));

  hijo.kill(); mini.servidor.close();
  fs.unlinkSync(brevoLog); fs.unlinkSync(relojArchivo);
  let ok = 0;
  for (const x of resultados) { console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + String(x.detalle).slice(0, 400)}`); if (x.ok) ok++; }
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
