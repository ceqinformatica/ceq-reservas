// Prueba del admin supremo con el server.js real (Node 24): Supabase simulado con un mini PostgREST
// en memoria (filtros eq/neq/in/is/gte/lte, select, order, limit, insert, upsert, update, delete)
// y Brevo interceptado. Uso: node probar_superadmin.js <carpeta con server.js y node_modules> <interceptar_brevo.js>
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { filaDesdeRpcReserva, contarCupo } = require(path.join(__dirname, 'mini_postgrest.js'));

const [carpeta, interceptor] = process.argv.slice(2);
const req = m => require(path.join(carpeta, 'node_modules', m));
const bcrypt = req('bcryptjs');
const jwt = req('jsonwebtoken');
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-super-' + Date.now() + '.log');
fs.writeFileSync(brevoLog, '');

const CLAVE_ADMIN = 'clave-admin-de-prueba';
const CLAVE_SUPER = 'clave-super-de-prueba';
const SECRETO = 'secreto-de-prueba';

// ---------- Fechas ----------
const hoyAsu = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion' }).format(new Date());
const masDias = n => { const d = new Date(hoyAsu() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const [anioHoy, mesHoy] = hoyAsu().split('-').map(Number);

// ---------- Base simulada ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const reserva = (id, estado, extra = {}) => ({ id, espacio_id: 3, nombre_solicitante: 'Prueba ' + id, contacto: '0981000000 | prueba' + id + '@example.com',
  fecha: masDias(10), hora_inicio: '07:00:00', hora_fin: '10:00:00', estado, motivo: 'test', codigo_cancelacion: null,
  codigo_cancelacion_hash: sha('COD' + id), created_at: '2026-10-11T08:41:05.123456', updated_at: '2026-10-11T08:41:05.123456',
  reservado_por_admin: false, cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, ...extra });
const db = {
  reservas: [reserva(1, 'activa'), reserva(2, 'cancelada'), reserva(3, 'cancelada'), reserva(4, 'activa', { hora_inicio: '10:00:00', hora_fin: '13:00:00' }),
    reserva(5, 'activa', { hora_inicio: '14:00:00', hora_fin: '18:00:00' }), reserva(6, 'activa', { fecha: masDias(11) })],
  espacios: [{ id: 1, nombre: 'Altillo', publico: false, aviso: 'Se reserva con planilla' }, { id: 2, nombre: 'Sala de Reuniones', publico: false, aviso: null },
    { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }],
  reportes_errores: [{ id: 10, mensaje: 'prueba 1', url: null, navegador: null, leido: false, created_at: hoyAsu() + 'T08:41:00' },
    { id: 11, mensaje: 'prueba 2', url: null, navegador: null, leido: true, created_at: hoyAsu() + 'T09:00:00' }],
  registro_actividad: [],
  meses_habilitados: [{ id: 1, anio: anioHoy, mes: mesHoy, habilitado: true }],
  bloqueos: []
};
const siguiente = {};
const nuevoId = t => (siguiente[t] = Math.max(siguiente[t] || 0, ...db[t].map(f => Number(f.id) || 0)) + 1);

function cumple(fila, col, expr) {
  const m = expr.match(/^(not\.)?(eq|neq|in|is|gte|lte|gt|lt)\.(.*)$/s);
  if (!m) throw new Error('Filtro no soportado por el simulador: ' + col + '=' + expr);
  const [, no, op, val] = m;
  const v = fila[col];
  let r;
  if (op === 'eq') r = String(v) === val;
  else if (op === 'neq') r = String(v) !== val;
  else if (op === 'in') r = val.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).includes(String(v));
  else if (op === 'is') r = val === 'null' ? v === null || v === undefined : String(v) === val;
  else if (op === 'gte') r = String(v) >= val; else if (op === 'lte') r = String(v) <= val;
  else if (op === 'gt') r = String(v) > val; else r = String(v) < val;
  return no ? !r : r;
}
const NO_FILTROS = ['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'];
function aplicarFiltros(filas, params) {
  return filas.filter(f => [...params].every(([k, v]) => NO_FILTROS.includes(k) || cumple(f, k, v)));
}
function proyectar(filas, select) {
  if (!select || select === '*') return filas.map(f => ({ ...f }));
  const cols = select.split(',').map(c => c.trim());
  return filas.map(f => Object.fromEntries(cols.map(c => [c, f[c] === undefined ? null : f[c]])));
}

const pedidos = [];
let falloInsertActividad = false;
const supa = http.createServer((rq, rs) => {
  let cuerpo = '';
  rq.on('data', c => cuerpo += c);
  rq.on('end', () => {
    const url = new URL(rq.url, 'http://x');
    const tabla = url.pathname.replace('/rest/v1/', '');
    const p = url.searchParams;
    const prefer = rq.headers.prefer || '';
    pedidos.push(`${rq.method} ${tabla}?${p}`);
    const enviar = (st, datos) => { rs.writeHead(st, { 'content-type': 'application/json' }); rs.end(datos === undefined ? '' : JSON.stringify(datos)); };
    try {
      // Reservas públicas: función crear_reserva_con_cupo de la base (cuenta el límite y guarda)
      if (tabla === 'rpc/crear_reserva_con_cupo') {
        const a = JSON.parse(cuerpo);
        const n = contarCupo(db.reservas, a);
        if (n !== null && n >= a.p_limite) return enviar(400, { code: 'CEQ03', message: String(n) });
        const fila = { ...filaDesdeRpcReserva(a), id: nuevoId('reservas'), reservado_por_admin: false };
        db.reservas.push(fila);
        return enviar(200, [{ ...fila }]);
      }
      if (!db[tabla]) return enviar(404, { code: '42P01', message: `relation "public.${tabla}" does not exist` });
      const representar = filas => prefer.includes('return=representation') ? enviar(rq.method === 'POST' ? 201 : 200, proyectar(filas, p.get('select'))) : enviar(rq.method === 'POST' ? 201 : 204);
      if (rq.method === 'GET' || rq.method === 'HEAD') {
        let filas = aplicarFiltros(db[tabla], p);
        if (p.get('order')) {
          const [col, dir] = p.get('order').split(',')[0].split('.');
          filas = [...filas].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        if (p.get('limit')) filas = filas.slice(0, Number(p.get('limit')));
        const salida = proyectar(filas, p.get('select'));
        if ((rq.headers.accept || '').includes('vnd.pgrst.object')) return salida.length === 1 ? enviar(200, salida[0]) : enviar(406, { code: 'PGRST116', message: 'no rows' });
        return enviar(200, salida);
      }
      if (rq.method === 'POST') {
        if (tabla === 'registro_actividad' && falloInsertActividad) return enviar(500, { code: 'XX000', message: 'falla simulada' });
        const nuevas = [].concat(JSON.parse(cuerpo));
        const resultado = [];
        for (const n of nuevas) {
          const conflicto = p.get('on_conflict');
          const existente = conflicto && db[tabla].find(f => String(f[conflicto]) === String(n[conflicto]));
          if (existente && prefer.includes('merge-duplicates')) { Object.assign(existente, n); resultado.push(existente); continue; }
          const fila = { ...n };
          if (tabla !== 'configuracion' && fila.id === undefined) fila.id = nuevoId(tabla);
          if (tabla === 'registro_actividad') fila.creado_en = new Date().toISOString().replace('Z', '+00:00');
          db[tabla].push(fila); resultado.push(fila);
        }
        return representar(resultado);
      }
      if (rq.method === 'PATCH') {
        const cambios = JSON.parse(cuerpo);
        const filas = aplicarFiltros(db[tabla], p);
        filas.forEach(f => Object.assign(f, cambios));
        return representar(filas);
      }
      if (rq.method === 'DELETE') {
        const filas = aplicarFiltros(db[tabla], p);
        db[tabla] = db[tabla].filter(f => !filas.includes(f));
        return representar(filas);
      }
      enviar(405, { message: 'método no soportado' });
    } catch (e) { console.error('SIMULADOR:', e.message); enviar(500, { code: 'XX000', message: e.message }); }
  });
});

// ---------- Utilidades de la prueba ----------
const esperar = ms => new Promise(r => setTimeout(r, ms));
const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const API = 'http://127.0.0.1:3998';
let ipN = 1;
const ip = () => `203.0.113.${ipN++}`;

async function arrancar(env) {
  const hijo = spawn(process.execPath, ['--require', interceptor, path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3998', SUPABASE_URL: 'http://127.0.0.1:54328', SUPABASE_KEY: 'clave-de-prueba', BREVO_API_KEY: 'clave-de-prueba',
      JWT_SECRET: SECRETO, EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, NODE_OPTIONS: '', ...env }
  });
  let salida = '';
  hijo.stdout.on('data', d => salida += d);
  hijo.stderr.on('data', d => salida += d);
  hijo.on('exit', c => salida += '\nterminó con código ' + c);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('El servidor no arrancó:\n' + salida);
  hijo.salida = () => salida;
  return hijo;
}

function cookiesDe(res) {
  const c = {};
  for (const linea of res.headers.getSetCookie()) { const [par] = linea.split(';'); const i = par.indexOf('='); c[par.slice(0, i)] = par.slice(i + 1); }
  return c;
}
async function login(password, direccion = ip()) {
  const res = await fetch(API + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': direccion }, body: JSON.stringify({ password }) });
  const cuerpo = await res.json().catch(() => ({}));
  return { status: res.status, cuerpo, cookies: cookiesDe(res), setCookie: res.headers.getSetCookie() };
}
const sesion = (token, csrf = 'csrf-prueba') => ({ cookie: `admin_token=${token}; csrf_token=${csrf}`, 'x-csrf-token': csrf, 'content-type': 'application/json' });
async function llamar(metodo, ruta, token, cuerpo, { sinCsrf = false } = {}) {
  const headers = token ? sesion(token) : { 'content-type': 'application/json' };
  if (sinCsrf) delete headers['x-csrf-token'];
  const res = await fetch(API + ruta, { method: metodo, headers: { ...headers, 'cf-connecting-ip': ip() }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const datos = await res.json().catch(() => ({}));
  return { status: res.status, datos };
}
const actividad = () => db.registro_actividad.map(a => `${a.rol}|${a.accion}|${a.detalle || ''}`);
const ultimaActividad = () => actividad().slice(-1)[0];

(async () => {
  await new Promise(r => supa.listen(54328, '127.0.0.1', r));
  const env = { ADMIN_PASSWORD_HASH: bcrypt.hashSync(CLAVE_ADMIN, 10), SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(CLAVE_SUPER, 10) };
  let hijo = await arrancar(env);

  // ===== A. Inicio de sesión =====
  const sup = await login(CLAVE_SUPER);
  const tokSuper = sup.cookies.admin_token;
  anotar('Login con la contraseña del admin supremo: 200 y rol superadmin', sup.status === 200 && sup.cuerpo.rol === 'superadmin' && !!tokSuper && !!sup.cookies.csrf_token, `${sup.status} ${JSON.stringify(sup.cuerpo)}`);
  const pSup = jwt.decode(tokSuper || '') || {};
  anotar('El token del admin supremo lleva rol y versión de sesiones 1', pSup.rol === 'superadmin' && pSup.v === 1, JSON.stringify(pSup));
  const adm = await login(CLAVE_ADMIN);
  const tokAdmin = adm.cookies.admin_token;
  anotar('Login con la contraseña del admin: 200 y rol admin', adm.status === 200 && adm.cuerpo.rol === 'admin' && (jwt.decode(tokAdmin || '') || {}).rol === 'admin', `${adm.status} ${JSON.stringify(adm.cuerpo)}`);
  const mal = await login('otra-cosa');
  await esperar(150);
  anotar('Contraseña incorrecta: 401', mal.status === 401, String(mal.status));
  anotar('El intento fallido queda en el registro de actividad (sin la contraseña)', actividad().includes('-|Intento de inicio de sesión fallido|') && !JSON.stringify(db.registro_actividad).includes('otra-cosa'), ultimaActividad());
  anotar('Los inicios de sesión quedan registrados con su rol', actividad().includes('superadmin|Inicio de sesión|') && actividad().includes('admin|Inicio de sesión|'), actividad().join(' ; '));
  let r1 = await login(12345), r2 = await login('x'.repeat(201)), r3 = await login({ a: 1 });
  anotar('Contraseña que no es texto o de más de 200 caracteres: 400', [r1.status, r2.status, r3.status].every(s => s === 400), [r1.status, r2.status, r3.status].join(','));

  let r = await llamar('GET', '/api/admin/verificar-sesion', tokSuper);
  anotar('verificar-sesion devuelve rol superadmin', r.status === 200 && r.datos.rol === 'superadmin', JSON.stringify(r.datos));
  r = await llamar('GET', '/api/admin/verificar-sesion', tokAdmin);
  anotar('verificar-sesion devuelve rol admin', r.status === 200 && r.datos.rol === 'admin', JSON.stringify(r.datos));
  const tokViejo = jwt.sign({ adminId: 'admin', timestamp: Date.now() }, SECRETO, { expiresIn: '1h', algorithm: 'HS256' });
  r = await llamar('GET', '/api/admin/verificar-sesion', tokViejo);
  anotar('Sesión abierta antes del cambio (token sin rol ni v): sigue andando como admin', r.status === 200 && r.datos.rol === 'admin', `${r.status} ${JSON.stringify(r.datos)}`);
  const tokFalso = jwt.sign({ adminId: 'admin', rol: 'superadmin', v: 1 }, 'otro-secreto', { expiresIn: '1h', algorithm: 'HS256' });
  r = await llamar('GET', '/api/superadmin/actividad', tokFalso);
  anotar('Token de admin supremo firmado con otra clave: rechazado', r.status === 403 || r.status === 401, String(r.status));

  // ===== B. Permisos =====
  const intentos = [
    ['POST', '/api/superadmin/espacios/1', { publico: true }], ['POST', '/api/superadmin/reservas/eliminar', { ids: [2] }],
    ['POST', '/api/superadmin/reportes/eliminar', { ids: [10] }], ['GET', '/api/superadmin/actividad'], ['POST', '/api/superadmin/cerrar-sesiones', {}]
  ];
  const codAdmin = [], codViejo = [], codNadie = [];
  for (const [m, ruta, c] of intentos) {
    codAdmin.push((await llamar(m, ruta, tokAdmin, c)).status);
    codViejo.push((await llamar(m, ruta, tokViejo, c)).status);
    codNadie.push((await llamar(m, ruta, null, c)).status);
  }
  anotar('El admin normal recibe 403 en las 5 acciones del admin supremo', codAdmin.every(s => s === 403), codAdmin.join(','));
  anotar('Una sesión vieja (sin rol) también recibe 403', codViejo.every(s => s === 403), codViejo.join(','));
  anotar('Sin sesión: 401 en todas', codNadie.every(s => s === 401), codNadie.join(','));
  anotar('Nada cambió en la base por esos intentos', db.reservas.find(x => x.id === 2) && db.reportes_errores.length === 2 && db.espacios[0].publico === false && db.configuracion[0].valor === '1');
  r = await llamar('POST', '/api/superadmin/espacios/1', tokSuper, { publico: true }, { sinCsrf: true });
  anotar('Admin supremo sin token CSRF: 403 y no cambia nada', r.status === 403 && db.espacios[0].publico === false, `${r.status} ${JSON.stringify(r.datos)}`);

  // ===== C. Espacios =====
  const fetchPublico = await fetch(API + '/api/espacios'); const listaEsp = await fetchPublico.json();
  anotar('GET /api/espacios devuelve publico y aviso de cada espacio', fetchPublico.status === 200 && listaEsp.length === 3 && listaEsp.every(e => 'publico' in e && 'aviso' in e), JSON.stringify(listaEsp));
  const reservar = espacio_id => fetch(API + '/api/reservas', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() },
    body: JSON.stringify({ espacio_id, nombre_solicitante: 'Ana', contacto: '0981123456 | ana@example.com', fecha: '2020-01-06', hora_inicio: '09:00', hora_fin: '10:00', motivo: 'estudio' }) })
    .then(async x => ({ status: x.status, datos: await x.json() }));
  r = await reservar(1);
  anotar('Reservar el Altillo cerrado (directo a la API): 400 "no se puede reservar por el momento"', r.status === 400 && r.datos.error === 'Ese espacio no se puede reservar por el momento', JSON.stringify(r.datos));
  r = await reservar(2);
  anotar('Reservar la Sala de Reuniones (cerrada): 400', r.status === 400 && r.datos.error === 'Ese espacio no se puede reservar por el momento', JSON.stringify(r.datos));
  r = await reservar(99); const r99 = r; r = await reservar('abc');
  anotar('Espacio inexistente o no numérico: 400 "Espacio inválido"', r99.status === 400 && r99.datos.error === 'Espacio inválido' && r.status === 400 && r.datos.error === 'Espacio inválido', `${JSON.stringify(r99.datos)} ${JSON.stringify(r.datos)}`);
  r = await reservar(3);
  anotar('Frente (abierto) pasa el control de espacio (la frena otra regla: fecha pasada)', r.status === 400 && r.datos.error !== 'Ese espacio no se puede reservar por el momento' && r.datos.error !== 'Espacio inválido', JSON.stringify(r.datos));

  r = await llamar('POST', '/api/superadmin/espacios/1', tokSuper, { publico: true, aviso: '  Aviso nuevo  ' });
  await esperar(150);
  anotar('Admin supremo habilita el Altillo: 200 y queda guardado (aviso sin espacios sobrantes)', r.status === 200 && db.espacios[0].publico === true && db.espacios[0].aviso === 'Aviso nuevo' && r.datos.espacio.publico === true, `${r.status} ${JSON.stringify(r.datos)}`);
  anotar('Registro: "Habilitó un espacio para el público — Altillo"', ultimaActividad() === 'superadmin|Habilitó un espacio para el público|Altillo', ultimaActividad());
  r = await reservar(1);
  anotar('Con el Altillo habilitado, la reserva pasa el control de espacio', r.status === 400 && r.datos.error !== 'Ese espacio no se puede reservar por el momento', JSON.stringify(r.datos));
  r = await llamar('POST', '/api/superadmin/espacios/1', tokSuper, { publico: true, aviso: '' });
  await esperar(150);
  anotar('Guardar sin cambiar el estado: aviso vacío queda null y el registro dice "Guardó el aviso"', r.status === 200 && db.espacios[0].aviso === null && ultimaActividad() === 'superadmin|Guardó el aviso de un espacio|Altillo', ultimaActividad());
  r = await llamar('POST', '/api/superadmin/espacios/1', tokSuper, { publico: false, aviso: 'Con planilla' });
  await esperar(150);
  anotar('Deshabilitar el Altillo: queda cerrado y registrado', r.status === 200 && db.espacios[0].publico === false && ultimaActividad() === 'superadmin|Deshabilitó un espacio para el público|Altillo', ultimaActividad());
  r = await llamar('POST', '/api/superadmin/espacios/3', tokSuper, { publico: false, aviso: 'Vacaciones' });
  const rFrente = await reservar(3);
  await llamar('POST', '/api/superadmin/espacios/3', tokSuper, { publico: true, aviso: null });
  anotar('Cerrar el Frente también funciona (y se vuelve a abrir)', r.status === 200 && rFrente.datos.error === 'Ese espacio no se puede reservar por el momento' && db.espacios[2].publico === true, JSON.stringify(rFrente.datos));
  const invalidos = [
    ['/api/superadmin/espacios/2', { publico: true }], ['/api/superadmin/espacios/abc', { publico: true }], ['/api/superadmin/espacios/1', { publico: 'true' }],
    ['/api/superadmin/espacios/1', {}], ['/api/superadmin/espacios/1', { publico: true, aviso: 'x'.repeat(1001) }], ['/api/superadmin/espacios/1', { publico: true, aviso: 5 }]
  ];
  const codInv = [];
  for (const [ruta, c] of invalidos) codInv.push((await llamar('POST', ruta, tokSuper, c)).status);
  anotar('Datos inválidos (Sala, id no numérico, publico no booleano o ausente, aviso largo o no texto): 400', codInv.every(s => s === 400) && db.espacios[1].publico === false, codInv.join(','));

  // ===== D. Datos de cancelación =====
  r = await fetch(API + '/api/cancelar-por-codigo', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() }, body: JSON.stringify({ codigo: 'cod1' }) }).then(async x => ({ status: x.status, datos: await x.json() }));
  const c1 = db.reservas.find(x => x.id === 1);
  anotar('Cancelación con código: guarda cuándo y "usuario"', r.status === 200 && c1.estado === 'cancelada' && c1.cancelada_por === 'usuario' && !isNaN(Date.parse(c1.cancelada_en)), `${r.status} ${JSON.stringify(r.datos)} ${c1.cancelada_en} ${c1.cancelada_por}`);
  r = await llamar('POST', '/api/admin/cancelar/4', tokSuper, { motivo: 'Pedido por WhatsApp' });
  const c4 = db.reservas.find(x => x.id === 4);
  anotar('Cancelación del admin supremo: "admin supremo" + motivo', r.status === 200 && c4.cancelada_por === 'admin supremo' && c4.motivo_cancelacion === 'Pedido por WhatsApp' && !!c4.cancelada_en, JSON.stringify(c4));
  r = await llamar('POST', '/api/admin/cancelar/5', tokAdmin, {});
  await esperar(150);
  const c5 = db.reservas.find(x => x.id === 5);
  anotar('Cancelación del admin: "moderador", sin motivo queda null', r.status === 200 && c5.cancelada_por === 'moderador' && c5.motivo_cancelacion === null, JSON.stringify(c5));
  anotar('Registro: "Canceló una reserva" con el rol de quien la canceló', actividad().some(a => a.startsWith('admin|Canceló una reserva|#5')) && actividad().some(a => a.startsWith('superadmin|Canceló una reserva|#4')), actividad().filter(a => a.includes('Canceló')).join(' ; '));
  r = await llamar('GET', '/api/admin/reservas', tokAdmin);
  anotar('El listado del panel trae created_at y los datos de cancelación', r.status === 200 && r.datos.some(x => x.id === 4 && x.cancelada_por === 'admin supremo' && x.created_at), '');

  // ===== E. Eliminar reservas =====
  r = await llamar('POST', '/api/superadmin/reservas/eliminar', tokSuper, { ids: [2, 3, 6, 999, 3] });
  await esperar(150);
  anotar('Eliminar [2, 3, 6 (activa), 999 (no existe), 3 repetido]: borra 2 e ignora 2', r.status === 200 && r.datos.eliminadas === 2 && r.datos.ignoradas === 2, JSON.stringify(r.datos));
  anotar('Las canceladas 2 y 3 ya no están; la activa 6 sigue', !db.reservas.some(x => x.id === 2 || x.id === 3) && db.reservas.some(x => x.id === 6 && x.estado === 'activa'));
  anotar('Registro: "Eliminó 2 reservas canceladas — #2, #3"', ultimaActividad() === 'superadmin|Eliminó 2 reservas canceladas|#2, #3', ultimaActividad());
  const cuantasAntes = db.registro_actividad.length;
  r = await llamar('POST', '/api/superadmin/reservas/eliminar', tokSuper, { ids: [6] });
  await esperar(150);
  anotar('Intentar eliminar solo una activa: 0 eliminadas y no se registra nada', r.status === 200 && r.datos.eliminadas === 0 && db.registro_actividad.length === cuantasAntes && db.reservas.some(x => x.id === 6), JSON.stringify(r.datos));
  const listasMalas = [[], 'abc', [0], [-1], [1.5], ['x'], Array.from({ length: 501 }, (_, i) => i + 1), undefined];
  const codListas = [];
  for (const ids of listasMalas) codListas.push((await llamar('POST', '/api/superadmin/reservas/eliminar', tokSuper, { ids })).status);
  anotar('Listas inválidas (vacía, texto, 0, negativo, decimal, no numérica, 501 ids, sin ids): 400', codListas.every(s => s === 400), codListas.join(','));

  // ===== F. Eliminar reportes =====
  r = await llamar('POST', '/api/superadmin/reportes/eliminar', tokSuper, { ids: [10, 12345] });
  await esperar(150);
  anotar('Eliminar reportes [10, 12345]: borra 1', r.status === 200 && r.datos.eliminados === 1 && db.reportes_errores.map(x => x.id).join() === '11', JSON.stringify(r.datos));
  anotar('Registro: "Eliminó 1 reporte — #10"', ultimaActividad() === 'superadmin|Eliminó 1 reporte|#10', ultimaActividad());

  // ===== G. Registro de actividad =====
  r = await llamar('GET', '/api/superadmin/actividad', tokSuper);
  const ids = (r.datos || []).map(a => a.id);
  anotar('GET actividad: lista ordenada del más nuevo al más viejo', r.status === 200 && ids.length === db.registro_actividad.length && ids.every((v, i) => i === 0 || ids[i - 1] > v), ids.slice(0, 5).join(','));
  anotar('Muestra "Admin supremo", "Admin" y "-" como quién', ['Admin supremo', 'Admin', '-'].every(n => r.datos.some(a => a.rol === n)) && !r.datos.some(a => a.rol === 'superadmin'), [...new Set(r.datos.map(a => a.rol))].join(','));
  falloInsertActividad = true;
  r = await llamar('POST', '/api/admin/reportes/11/leer', tokAdmin, {});
  falloInsertActividad = false;
  anotar('Si falla guardar el registro, la acción igual se hace', r.status === 200 && db.reportes_errores[0].leido === true, `${r.status} ${JSON.stringify(r.datos)}`);

  // ===== H. Cerrar todas las sesiones =====
  const otraSup = await login(CLAVE_SUPER);
  r = await fetch(API + '/api/superadmin/cerrar-sesiones', { method: 'POST', headers: { ...sesion(otraSup.cookies.admin_token), 'cf-connecting-ip': ip() } });
  const borra = r.headers.getSetCookie().join(' | ');
  await esperar(150);
  anotar('Cerrar todas las sesiones: 200, versión 2 en la base y borra las cookies', r.status === 200 && db.configuracion[0].valor === '2' && /admin_token=;/.test(borra) && /csrf_token=;/.test(borra), `${r.status} ${db.configuracion[0].valor} ${borra}`);
  anotar('Registro: "Cerró todas las sesiones del panel"', ultimaActividad() === 'superadmin|Cerró todas las sesiones del panel|', ultimaActividad());
  const despues = [];
  for (const t of [tokSuper, tokAdmin, tokViejo, otraSup.cookies.admin_token]) despues.push(await llamar('GET', '/api/admin/verificar-sesion', t));
  anotar('Todas las sesiones anteriores quedan afuera (401 con mensaje claro)', despues.every(x => x.status === 401 && x.datos.error === 'La sesión fue cerrada por un administrador'), despues.map(x => x.status).join(','));
  r = await llamar('GET', '/api/admin/reservas', tokAdmin);
  anotar('...también para leer datos del panel', r.status === 401, String(r.status));
  const nueva = await login(CLAVE_ADMIN);
  r = await llamar('GET', '/api/admin/verificar-sesion', nueva.cookies.admin_token);
  anotar('Volviendo a iniciar sesión se entra normalmente (token con v 2)', r.status === 200 && (jwt.decode(nueva.cookies.admin_token) || {}).v === 2, `${r.status} ${JSON.stringify(jwt.decode(nueva.cookies.admin_token || ''))}`);

  // ===== I. Reinicio del servidor: la versión se vuelve a leer de la base =====
  hijo.kill(); await esperar(300);
  hijo = await arrancar(env);
  const tras = [await llamar('GET', '/api/admin/verificar-sesion', tokSuper), await llamar('GET', '/api/admin/verificar-sesion', nueva.cookies.admin_token)];
  anotar('Después de reiniciar el servidor, las sesiones cerradas siguen afuera y la nueva sigue adentro', tras[0].status === 401 && tras[1].status === 200, tras.map(x => x.status).join(','));
  hijo.kill(); await esperar(300);

  // ===== J. Sin SUPERADMIN_PASSWORD_HASH (como hasta ahora) =====
  hijo = await arrancar({ ADMIN_PASSWORD_HASH: env.ADMIN_PASSWORD_HASH, SUPERADMIN_PASSWORD_HASH: '' });
  const s1 = await login(CLAVE_SUPER), s2 = await login(CLAVE_ADMIN);
  anotar('Sin la variable del admin supremo: esa contraseña no entra y la del admin sí', s1.status === 401 && s2.status === 200 && s2.cuerpo.rol === 'admin', `${s1.status} ${s2.status}`);
  hijo.kill(); await esperar(300);

  // ===== K. Sin las tablas nuevas (si se sube el servidor antes de la migración) =====
  const guardada = db.configuracion; delete db.configuracion;
  hijo = await arrancar(env);
  const sinTabla = await login(CLAVE_ADMIN);
  anotar('Sin la migración, el login falla con error genérico (por eso la migración va ANTES)', sinTabla.status === 500, `${sinTabla.status} ${JSON.stringify(sinTabla.cuerpo)}`);
  db.configuracion = guardada;
  hijo.kill();

  supa.close();
  const avisos = hijo.salida().split('\n').filter(l => /DeprecationWarning|ExperimentalWarning/i.test(l));
  anotar('Sin avisos de funciones obsoletas de Node', avisos.length === 0, avisos.join(' | '));
  for (const x of resultados) console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.detalle && !x.ok ? '  ->  ' + x.detalle : ''}`);
  console.log(`\n${resultados.filter(x => x.ok).length}/${resultados.length} pruebas correctas`);
  fs.unlinkSync(brevoLog);
  process.exit(0);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
