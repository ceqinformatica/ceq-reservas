// Prueba las funciones del panel de octubre de 2026: salir de la lista de espera, bloqueos de
// varios días, estados de los reportes y correos que no salieron. Con el server.js real,
// Supabase simulado, Brevo interceptado y un reloj falso.
// Uso: node probar_panel.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-panel-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-panel-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const hasta = async (condicion, ms = 6000) => { for (let i = 0; i < ms / 100 && !condicion(); i++) await esperar(100); return condicion(); };
const SECRETO = 'secreto-panel';

const db = {
  reservas: [
    { id: 501, espacio_id: 1, nombre_solicitante: 'Ana Altillo', contacto: '0981 111 222 | ana@example.com', fecha: '2026-11-19', hora_inicio: '15:00:00', hora_fin: '16:00:00',
      estado: 'activa', motivo: 'Estudiar', reservado_por_admin: false, acompanantes: [], created_at: '2026-11-01T12:00:00' }
  ],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 2, nombre: 'Sala', publico: false, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }],
  registro_actividad: [], lista_espera: [],
  bloqueos: [{ id: 701, espacio_id: 1, fecha: '2026-11-24', hora_inicio: '14:00:00', hora_fin: '16:00:00', motivo: 'Ya estaba', lote: null }],
  reportes_errores: [
    { id: 801, mensaje: 'No me deja reservar', url: '/', navegador: 'x', leido: false, estado: 'nuevo', nota: null, created_at: '2026-11-16T10:00:00' },
    { id: 802, mensaje: 'Otro', url: '/', navegador: 'x', leido: false, estado: 'nuevo', nota: null, created_at: '2026-11-16T11:00:00' }
  ],
  correos_pendientes: [
    { id: 901, destinatarios: ['perdido@example.com'], asunto: 'Confirmación perdida', html: '<p>Tu código es ABC</p>', texto: null, responder_a: null,
      estado: 'fallido', intentos: 6, proximo_intento: '2026-11-16T10:00:00Z', reclamado_hasta: null, ultimo_error: 'Brevo 500: caído', creado_en: '2026-11-16T09:00:00Z', enviado_en: null },
    { id: 902, destinatarios: [], asunto: 'Ya enviado', html: '', texto: null, responder_a: null,
      estado: 'enviado', intentos: 1, proximo_intento: '2026-11-16T10:00:00Z', reclamado_hasta: null, ultimo_error: null, creado_en: '2026-11-16T09:00:00Z', enviado_en: '2026-11-16T09:00:01Z' }
  ]
};
const mini = crearMiniPostgrest(db, {
  unicas: { bloqueos: [['espacio_id', 'fecha', 'hora_inicio']] },
  porDefecto: { correos_pendientes: () => ({ intentos: 0, creado_en: new Date(Date.now() + desfase).toISOString(), reclamado_hasta: null, ultimo_error: null, enviado_en: null }) }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3989', SUPABASE_URL: 'http://127.0.0.1:54330', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo,
      INTERVALO_TAREAS_MS: '600000', INTERVALO_COLA_CORREOS_MS: '400', EMAILS_SIN_LIMITE: '', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3989';
let ipN = 1;
async function pedir(metodo, ruta, cuerpo, { admin = false } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ipN++ % 250}` };
  if (admin) {
    const ahora = Math.floor((Date.now() + desfase) / 1000);
    const token = jwt.sign({ adminId: 'admin', rol: 'admin', v: 1, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
    Object.assign(headers, { cookie: `admin_token=${token}; csrf_token=csrf`, 'x-csrf-token': 'csrf' });
  }
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: res.status, datos: await res.json().catch(() => ({})) };
}

(async () => {
  await new Promise(ok => mini.servidor.listen(54330, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  const hijo = await arrancar();
  await esperar(800);

  // ===== 1. Lista de espera: confirmación con enlace para salir =====
  let r = await pedir('POST', '/api/lista-espera', { espacio_id: 3, email: 'Espera@Example.com' });
  await hasta(() => correos().some(c => c.subject.includes('lista de espera')));
  const conf = correos().find(c => c.subject === 'Te anotaste en la lista de espera del Frente');
  const enlace = conf && (conf.textContent.match(/https:\/\/reservas\.ceq-una\.com\/lista-espera\.html\?\S+/) || [])[0];
  anotar('Al anotarse llega una confirmación', r.status === 201 && !!conf, `${r.status} ${correos().map(c => c.subject).join(' | ')}`);
  anotar('La confirmación es solo texto (sin HTML) y trae el enlace para salir', conf && conf.htmlContent === undefined && !!enlace, conf && conf.textContent);
  const q = enlace ? new URL(enlace).searchParams : new URLSearchParams();
  anotar('El enlace lleva el espacio, el correo en minúsculas y una firma', q.get('s') === '3' && q.get('e') === 'espera@example.com' && (q.get('t') || '').length === 32, enlace);

  r = await pedir('POST', '/api/lista-espera/baja', { s: '3', e: 'espera@example.com', t: 'x'.repeat(32) });
  anotar('Con una firma inventada no se sale (400) y sigue anotado', r.status === 400 && db.lista_espera.length === 1, `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/lista-espera/baja', { s: '1', e: 'espera@example.com', t: q.get('t') });
  anotar('La firma del Frente no sirve para el Altillo (400)', r.status === 400, String(r.status));
  r = await pedir('POST', '/api/lista-espera/baja', { s: '3', e: 'otro@example.com', t: q.get('t') });
  anotar('La firma de un correo no sirve para otro (400)', r.status === 400, String(r.status));
  r = await pedir('POST', '/api/lista-espera/baja', { s: q.get('s'), e: q.get('e'), t: q.get('t') });
  anotar('Con el enlace del correo sale de la lista', r.status === 200 && db.lista_espera.length === 0 && /saliste de la lista de espera del Frente/.test(r.datos.mensaje), `${r.status} ${r.datos.mensaje}`);
  r = await pedir('POST', '/api/lista-espera/baja', { s: q.get('s'), e: q.get('e'), t: q.get('t') });
  anotar('Usar el enlace otra vez responde lo mismo (sin error)', r.status === 200, String(r.status));

  // ===== 2. Bloqueos de varios días =====
  const lote = { espacio_id: 1, desde: '2026-11-16', hasta: '2026-11-27', dias: [2, 4], hora_inicio: '14:00', hora_fin: '16:00', motivo: 'Clases' };
  r = await pedir('POST', '/api/bloqueos/lote', lote);
  anotar('Sin sesión no se puede (401)', r.status === 401, String(r.status));
  r = await pedir('POST', '/api/bloqueos/lote', lote, { admin: true });
  anotar('Vista previa: martes y jueves del 16 al 27/11 → 17 y 26 se bloquean', r.status === 200 && JSON.stringify(r.datos.fechas) === '["2026-11-17","2026-11-26"]', JSON.stringify(r.datos));
  anotar('...el 19 no, porque hay una reserva en ese horario (y dice cuál)', r.datos.conflictos && r.datos.conflictos.length === 1 && r.datos.conflictos[0].fecha === '2026-11-19' && r.datos.conflictos[0].reservas[0].nombre === 'Ana Altillo');
  anotar('...el 24 ya estaba bloqueado', JSON.stringify(r.datos.ya_bloqueadas) === '["2026-11-24"]');
  anotar('...y la vista previa no crea nada', db.bloqueos.length === 1);
  r = await pedir('POST', '/api/bloqueos/lote', { ...lote, confirmar: true }, { admin: true });
  const nuevos = db.bloqueos.filter(b => b.lote);
  anotar('Al confirmar se crean los 2, con el mismo lote', r.status === 201 && r.datos.creados === 2 && nuevos.length === 2 && nuevos.every(b => b.lote === r.datos.lote && b.motivo === 'Clases'), JSON.stringify(r.datos));
  await hasta(() => db.registro_actividad.some(a => a.accion === 'Creó bloqueos de varios días'), 2000);
  anotar('...y queda en el registro de actividad', db.registro_actividad.some(a => a.accion === 'Creó bloqueos de varios días'));
  r = await pedir('POST', '/api/bloqueos/lote', { ...lote, confirmar: true }, { admin: true });
  anotar('Repetir la misma serie no duplica nada (no queda ningún día)', r.status === 400 && db.bloqueos.length === 3, `${r.status} ${r.datos.error}`);

  const malos = [
    [{ ...lote, dias: [] }, 'sin días'],
    [{ ...lote, dias: [6] }, 'sábado'],
    [{ ...lote, desde: '2026-11-27', hasta: '2026-11-16' }, 'al revés'],
    [{ ...lote, hasta: '2027-06-30' }, 'más de 6 meses'],
    [{ ...lote, hora_inicio: '18:00', hora_fin: '20:00' }, 'Altillo hasta las 20'],
    [{ ...lote, desde: '2026-11-13' }, 'fecha pasada'],
    [{ ...lote, espacio_id: 2 }, 'espacio 2'],
    [{ ...lote, desde: '2026-02-30' }, 'fecha inexistente']
  ];
  const estados = [];
  for (const [cuerpo] of malos) estados.push((await pedir('POST', '/api/bloqueos/lote', cuerpo, { admin: true })).status);
  anotar('Datos inválidos (sin días, sábado, al revés, más de 6 meses, fuera de horario, pasado…): 400', estados.every(s => s === 400), malos.map(([, n], i) => `${n}=${estados[i]}`).join(', '));

  r = await pedir('POST', '/api/bloqueos/lote', { espacio_id: 3, desde: '2026-11-30', hasta: '2026-12-04', dias: [1, 2, 3, 4, 5], hora_inicio: '00:00:00', hora_fin: '23:59:00', confirmar: true }, { admin: true });
  anotar('Frente todo el día, una semana entera: 5 bloqueos', r.status === 201 && r.datos.creados === 5, JSON.stringify(r.datos));
  const loteFrente = r.datos.lote;

  r = await pedir('DELETE', `/api/bloqueos/lote/${nuevos[0].lote}`, null, { admin: true });
  anotar('Eliminar la serie del Altillo borra sus 2 días y nada más', r.status === 200 && r.datos.eliminados === 2 && db.bloqueos.some(b => b.id === 701) && db.bloqueos.filter(b => b.lote === loteFrente).length === 5, JSON.stringify(r.datos));
  r = await pedir('DELETE', '/api/bloqueos/lote/no-es-un-lote', null, { admin: true });
  const r404 = await pedir('DELETE', `/api/bloqueos/lote/${nuevos[0].lote}`, null, { admin: true });
  anotar('Lote inválido: 400; lote que ya no existe: 404', r.status === 400 && r404.status === 404, `${r.status} ${r404.status}`);

  // ===== 3. Estados de los reportes =====
  r = await pedir('POST', '/api/admin/reportes/801/estado', { estado: 'en_revision', nota: '  Lo estoy mirando  ' }, { admin: true });
  const rep = db.reportes_errores.find(x => x.id === 801);
  anotar('Pasar un reporte a "en revisión" con una nota', r.status === 200 && rep.estado === 'en_revision' && rep.nota === 'Lo estoy mirando' && rep.leido === true, JSON.stringify(rep));
  r = await pedir('POST', '/api/admin/reportes/801/estado', { estado: 'resuelto', nota: 'Era el navegador viejo' }, { admin: true });
  anotar('Marcarlo como resuelto', r.status === 200 && rep.estado === 'resuelto' && rep.nota === 'Era el navegador viejo');
  r = await pedir('POST', '/api/admin/reportes/801/estado', { estado: 'nuevo' }, { admin: true });
  anotar('Volver a "nuevo" lo deja como no leído', r.status === 200 && rep.estado === 'nuevo' && rep.leido === false);
  const malosRep = [await pedir('POST', '/api/admin/reportes/801/estado', { estado: 'archivado' }, { admin: true }),
    await pedir('POST', '/api/admin/reportes/801/estado', { estado: 'resuelto', nota: 'x'.repeat(501) }, { admin: true }),
    await pedir('POST', '/api/admin/reportes/abc/estado', { estado: 'resuelto' }, { admin: true })];
  anotar('Estado inventado, nota de más de 500 caracteres o id inválido: 400', malosRep.every(m => m.status === 400), malosRep.map(m => m.status).join(','));
  r = await pedir('POST', '/api/admin/reportes/9999/estado', { estado: 'resuelto' }, { admin: true });
  anotar('Reporte que no existe: 404', r.status === 404);
  r = await pedir('POST', '/api/admin/reportes/802/leer', {}, { admin: true });
  await hasta(() => db.reportes_errores.find(x => x.id === 802).estado === 'en_revision', 2000);
  anotar('"Marcar leído" (botón viejo) pasa un reporte nuevo a "en revisión"', r.status === 200 && db.reportes_errores.find(x => x.id === 802).estado === 'en_revision');

  // ===== 4. Correos que no salieron =====
  r = await pedir('GET', '/api/admin/correos', null, { admin: true });
  const lista = Array.isArray(r.datos) ? r.datos : [];
  anotar('El panel ve los correos sin enviar (no los ya enviados)', r.status === 200 && lista.some(c => c.id === 901) && !lista.some(c => c.id === 902), JSON.stringify(lista.map(c => [c.id, c.estado])));
  anotar('...sin el contenido (que tiene códigos de cancelación)', lista.every(c => !('html' in c) && !('texto' in c)));
  r = await pedir('GET', '/api/admin/correos');
  anotar('Sin sesión no se ven (401)', r.status === 401);
  r = await pedir('POST', '/api/admin/correos/902/reintentar', {}, { admin: true });
  anotar('No se puede "reintentar" uno que ya salió (404)', r.status === 404);
  r = await pedir('POST', '/api/admin/correos/901/reintentar', {}, { admin: true });
  const salio = await hasta(() => correos().some(c => c.subject === 'Confirmación perdida'));
  await hasta(() => db.correos_pendientes.find(c => c.id === 901).estado === 'enviado');
  const c901 = db.correos_pendientes.find(c => c.id === 901);
  anotar('Reintentar un correo perdido: vuelve a la cola, sale y se borra su contenido', r.status === 200 && salio && c901.estado === 'enviado' && c901.html === '', JSON.stringify({ estado: c901.estado, html: c901.html }));

  hijo.kill();
  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
