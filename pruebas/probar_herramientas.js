// Prueba las herramientas del admin supremo (octubre 2026): editar una reserva, reenviar su
// confirmación, historial, pausar las reservas, cambiar la contraseña de los admins, estado del
// sistema y copia de seguridad en el momento. Con el server.js real, Supabase simulado, Brevo
// interceptado y un reloj falso.
// Uso: node probar_herramientas.js <carpeta server+node_modules> <carpeta de ayudantes>
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
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-herramientas-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-herramientas-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const hasta = async (condicion, ms = 6000) => { for (let i = 0; i < ms / 100 && !condicion(); i++) await esperar(100); return condicion(); };
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const SECRETO = 'secreto-herramientas';
const CLAVE_ADMIN_VIEJA = 'clave-vieja-de-prueba';
const CLAVE_SUPER = 'clave-supremo-de-prueba';
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

const reserva = extra => ({ espacio_id: 3, fecha: '2026-11-18', hora_inicio: '07:00:00', hora_fin: '10:00:00', estado: 'activa', motivo: 'Actividad Personal',
  reservado_por_admin: false, acompanantes: [], asistencia: null, created_at: '2026-11-10T12:00:00', cancelada_en: null, cancelada_por: null,
  motivo_cancelacion: null, recordatorio_enviado_en: null, ...extra });
const db = {
  reservas: [
    reserva({ id: 701, nombre_solicitante: 'Ana Pérez', contacto: '0981 111 222 | ana@example.com', codigo_cancelacion_hash: sha('CODIGOANAVIEJO') }),
    reserva({ id: 702, nombre_solicitante: 'Beto Ruiz', contacto: '0982 333 444 | beto@example.com', hora_inicio: '10:00:00', hora_fin: '13:00:00', codigo_cancelacion_hash: sha('CODIGOBETO') }),
    reserva({ id: 703, espacio_id: 1, nombre_solicitante: 'Caro Díaz', contacto: '0983 555 666 | caro@example.com', fecha: '2026-11-19', hora_inicio: '08:00:00', hora_fin: '09:00:00', motivo: 'Estudiar', codigo_cancelacion_hash: sha('CODIGOCARO') }),
    reserva({ id: 704, nombre_solicitante: 'Pasada', contacto: '0984 777 888 | pasada@example.com', fecha: '2026-11-13', codigo_cancelacion_hash: sha('CODIGOPASADA') })
  ],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }],
  registro_actividad: [], reportes_errores: [{ id: 1, mensaje: 'x', estado: 'nuevo', leido: false, created_at: '2026-11-16T10:00:00' }],
  bloqueos: [{ id: 801, espacio_id: 3, fecha: '2026-11-20', hora_inicio: '00:00:00', hora_fin: '23:59:00', motivo: 'Evento', lote: null }],
  lista_espera: [], correos_pendientes: []
};
const mini = crearMiniPostgrest(db, {
  unicas: { configuracion: [['clave']] },
  porDefecto: {
    reservas: () => ({ created_at: new Date(Date.now() + desfase).toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false }),
    registro_actividad: () => ({ creado_en: new Date(Date.now() + desfase).toISOString() }),
    correos_pendientes: () => ({ intentos: 0, creado_en: new Date(Date.now() + desfase).toISOString(), reclamado_hasta: null, ultimo_error: null, enviado_en: null })
  }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3984', SUPABASE_URL: 'http://127.0.0.1:54331', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(CLAVE_ADMIN_VIEJA, 4), SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(CLAVE_SUPER, 4),
      EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '600000', INTERVALO_COLA_CORREOS_MS: '300',
      NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3984';
let ipN = 1;
async function pedir(metodo, ruta, cuerpo, rol, version = 1) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ipN++ % 250}` };
  if (rol) {
    const ahora = Math.floor((Date.now() + desfase) / 1000);
    const token = jwt.sign({ adminId: 'admin', rol, v: version, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
    Object.assign(headers, { cookie: `admin_token=${token}; csrf_token=csrf`, 'x-csrf-token': 'csrf' });
  }
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const texto = await res.text();
  let datos = {};
  try { datos = JSON.parse(texto); } catch (e) { datos = { texto }; }
  return { status: res.status, datos, headers: res.headers };
}
const fila = id => db.reservas.find(r => r.id === id);
const delCorreo = email => correos().filter(c => c.to.some(t => t.email === email));

(async () => {
  await new Promise(ok => mini.servidor.listen(54331, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  const hijo = await arrancar();
  await esperar(800);

  // ===== Solo el admin supremo =====
  const prohibidas = [await pedir('POST', '/api/superadmin/reservas/701/reenviar', {}, 'admin'), await pedir('PUT', '/api/superadmin/reservas/701', { fecha: '2026-11-19' }, 'admin'),
    await pedir('GET', '/api/superadmin/reservas/701/historial', null, 'admin'), await pedir('POST', '/api/superadmin/pausa', { activa: false }, 'admin'),
    await pedir('POST', '/api/superadmin/clave-admin', { nueva: 'x'.repeat(12), confirmar: 'x'.repeat(12) }, 'admin'),
    await pedir('GET', '/api/superadmin/estado', null, 'admin'), await pedir('GET', '/api/superadmin/copia', null, 'admin')];
  anotar('El admin común no puede usar ninguna herramienta nueva (403)', prohibidas.every(p => p.status === 403), prohibidas.map(p => p.status).join(','));

  // ===== Reenviar la confirmación =====
  let r = await pedir('POST', '/api/superadmin/reservas/701/reenviar', {}, 'superadmin');
  await hasta(() => delCorreo('ana@example.com').some(c => c.subject.includes('reenvío')));
  const reenvio = delCorreo('ana@example.com').find(c => c.subject.includes('reenvío'));
  const codigoNuevo = reenvio && (reenvio.htmlContent.match(/Código de cancelación:<\/strong> ([0-9A-F]{16})/) || [])[1];
  anotar('Reenviar: llega la confirmación con un código nuevo y el enlace para cancelar',
    r.status === 200 && !!codigoNuevo && reenvio.subject === '✓ Confirmación de Reserva (reenvío) - CEQ #701' && reenvio.htmlContent.includes('cancelar.html?r=701&amp;t=') === false && reenvio.htmlContent.includes('cancelar.html?r=701&t='),
    `${r.status} ${reenvio && reenvio.subject}`);
  const conNuevo = await pedir('POST', '/api/cancelar-por-codigo/consultar', { codigo: codigoNuevo || 'X' });
  const conViejo = await pedir('POST', '/api/cancelar-por-codigo/consultar', { codigo: 'CODIGOANAVIEJO' });
  anotar('...el código nuevo sirve y el viejo ya no', conNuevo.status === 200 && conNuevo.datos.id === 701 && conViejo.status === 404, `${conNuevo.status} ${conViejo.status}`);
  r = await pedir('POST', '/api/superadmin/reservas/704/reenviar', {}, 'superadmin');
  anotar('No se reenvía la de una reserva que ya pasó (400)', r.status === 400, `${r.status} ${r.datos.error}`);

  // ===== Editar =====
  r = await pedir('PUT', '/api/superadmin/reservas/701', { email: 'Ana.Nueva@Example.com', hora_inicio: '14:00', hora_fin: '18:00' }, 'superadmin');
  anotar('Editar: cambia el correo (en minúsculas) y la pasa a la Merienda',
    r.status === 200 && fila(701).contacto === '0981 111 222 | ana.nueva@example.com' && fila(701).hora_inicio === '14:00:00' && fila(701).hora_fin === '18:00:00', `${r.status} ${JSON.stringify(r.datos)} ${fila(701).contacto}`);
  await hasta(() => delCorreo('ana.nueva@example.com').length > 0);
  const aviso = delCorreo('ana.nueva@example.com')[0];
  anotar('...le llega "Tu reserva fue modificada" al correo nuevo, con el horario nuevo y el enlace para cancelar',
    aviso && aviso.subject === 'Tu reserva fue modificada - CEQ #701' && aviso.htmlContent.includes('Merienda (14:00 - 18:00)') && aviso.htmlContent.includes('cancelar.html?r=701&t='), aviso && aviso.subject);
  const malasEdicion = [
    await pedir('PUT', '/api/superadmin/reservas/701', { hora_inicio: '10:00', hora_fin: '13:00' }, 'superadmin'),
    await pedir('PUT', '/api/superadmin/reservas/701', { fecha: '2026-11-20' }, 'superadmin'),
    await pedir('PUT', '/api/superadmin/reservas/701', { hora_inicio: '08:00', hora_fin: '09:00' }, 'superadmin'),
    await pedir('PUT', '/api/superadmin/reservas/701', { email: 'no-es-correo' }, 'superadmin'),
    await pedir('PUT', '/api/superadmin/reservas/701', { fecha: '2026-11-13' }, 'superadmin'),
    await pedir('PUT', '/api/superadmin/reservas/703', { hora_inicio: '08:00', hora_fin: '12:00' }, 'superadmin'),
    await pedir('PUT', '/api/superadmin/reservas/704', { nombre_solicitante: 'Otro' }, 'superadmin')
  ];
  anotar('No deja: turno ocupado (409), día bloqueado (409), horario que no es turno (400), correo inválido (400), día pasado (400), Altillo más de 2 h (400), reserva pasada (400)',
    malasEdicion.map(m => m.status).join() === '409,409,400,400,400,400,400', malasEdicion.map(m => `${m.status} ${m.datos.error}`).join(' | '));
  anotar('...y la reserva queda como estaba', fila(701).hora_inicio === '14:00:00' && fila(701).fecha === '2026-11-18');
  r = await pedir('PUT', '/api/superadmin/reservas/703', { fecha: '2026-11-23', hora_inicio: '09:00', hora_fin: '11:00', avisar: false }, 'superadmin');
  await esperar(500);
  anotar('Altillo: se mueve a otro día y horario sin avisar (avisar: false)', r.status === 200 && fila(703).fecha === '2026-11-23' && fila(703).hora_inicio === '09:00:00' && !delCorreo('caro@example.com').some(c => c.subject.includes('modificada')), `${r.status} ${JSON.stringify(r.datos)}`);
  await esperar(300);
  const actividad = db.registro_actividad.filter(a => a.accion === 'Modificó una reserva');
  anotar('El registro de actividad anota qué se cambió, sin datos personales', actividad.length === 2 && actividad[0].detalle.startsWith('#701 · contacto, día u horario') && !/ana|0981|example/i.test(JSON.stringify(actividad)), JSON.stringify(actividad));

  // ===== Historial =====
  r = await pedir('GET', '/api/superadmin/reservas/701/historial', null, 'superadmin');
  const eventos = (r.datos.eventos || []).map(e => e.que).join(' | ');
  anotar('Historial: creación, reenvío, modificación y los correos de esa reserva', r.status === 200 && /Reserva hecha desde la página/.test(eventos) && /Reenvió la confirmación/.test(eventos) &&
    /Modificó una reserva/.test(eventos) && /Tu reserva fue modificada - CEQ #701/.test(eventos), eventos);
  anotar('...y no mezcla otras reservas con números parecidos', !/#7010|#70[2-9]/.test(eventos), eventos);

  // ===== Pausa =====
  r = await pedir('POST', '/api/superadmin/pausa', { activa: true, mensaje: '' }, 'superadmin');
  anotar('Pausar sin mensaje: 400', r.status === 400, `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/superadmin/pausa', { activa: true, mensaje: 'Volvemos el lunes 23.' }, 'superadmin');
  const conf = await pedir('GET', '/api/configuracion');
  const reservaPausada = await pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Dani Prueba', contacto: '0985 000 111 | dani@example.com', fecha: '2026-11-24', hora_inicio: '07:00', hora_fin: '10:00', motivo: 'Actividad Personal' });
  const esperaPausada = await pedir('POST', '/api/lista-espera', { espacio_id: 3, email: 'dani@example.com', nombre: 'Dani', mes: '2026-11' });
  anotar('Pausado: la página recibe el mensaje y no se puede reservar ni anotarse en la lista de espera (503 con el mensaje)',
    r.status === 200 && conf.datos.pausa_reservas && conf.datos.pausa_reservas.mensaje === 'Volvemos el lunes 23.' && reservaPausada.status === 503 && reservaPausada.datos.error === 'Volvemos el lunes 23.' && esperaPausada.status === 503,
    `${r.status} ${JSON.stringify(conf.datos.pausa_reservas)} ${reservaPausada.status} ${esperaPausada.status}`);
  const canceladaEnPausa = await pedir('POST', '/api/cancelar-por-codigo', { codigo: 'CODIGOBETO' });
  anotar('...pero se puede cancelar igual', canceladaEnPausa.status === 200 && fila(702).estado === 'cancelada', `${canceladaEnPausa.status} ${JSON.stringify(canceladaEnPausa.datos)}`);
  r = await pedir('POST', '/api/superadmin/pausa', { activa: false, mensaje: '' }, 'superadmin');
  const reservaDespues = await pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Dani Prueba', contacto: '0985 000 111 | dani@example.com', fecha: '2026-11-24', hora_inicio: '07:00', hora_fin: '10:00', motivo: 'Actividad Personal' });
  const confDespues = await pedir('GET', '/api/configuracion');
  anotar('Al reanudar se vuelve a reservar normalmente', r.status === 200 && confDespues.datos.pausa_reservas === null && reservaDespues.status === 201, `${r.status} ${reservaDespues.status}`);

  // ===== Estado del sistema y copia =====
  r = await pedir('GET', '/api/superadmin/estado', null, 'superadmin');
  anotar('Estado del sistema: base, correos de hoy, copia, reportes nuevos y pausa', r.status === 200 && r.datos.base === 'ok' && r.datos.correos && r.datos.correos.hoy >= 3 &&
    r.datos.copia_mensual === '2026-11' && r.datos.reportes_nuevos === 1 && r.datos.limite_correos_dia === 300 && r.datos.pausa_reservas.activa === false, JSON.stringify(r.datos));
  r = await pedir('GET', '/api/superadmin/copia', null, 'superadmin');
  anotar('Copia en el momento: un CSV para descargar con todas las reservas', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && /attachment; filename="reservas-ceq-2026-11-16\.csv"/.test(r.headers.get('content-disposition')) &&
    (r.datos.texto || '').includes('"N°"') && (r.datos.texto || '').includes('ana.nueva@example.com'), `${r.status} ${r.headers.get('content-type')}`);

  // ===== Contraseña de los admins =====
  const malasClave = [await pedir('POST', '/api/superadmin/clave-admin', { nueva: 'corta', confirmar: 'corta' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/clave-admin', { nueva: 'una-clave-larga-1', confirmar: 'otra-clave-larga-2' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/clave-admin', { nueva: CLAVE_SUPER, confirmar: CLAVE_SUPER }, 'superadmin')];
  anotar('Contraseña: corta, distinta al repetir o igual a la del admin supremo = 400', malasClave.every(m => m.status === 400), malasClave.map(m => `${m.status} ${m.datos.error}`).join(' | '));
  r = await pedir('POST', '/api/superadmin/clave-admin', { nueva: 'clave-nueva-de-admins', confirmar: 'clave-nueva-de-admins' }, 'superadmin');
  const guardada = (db.configuracion.find(c => c.clave === 'admin_password_hash') || {}).valor || '';
  anotar('Se cambia y se guarda cifrada (nunca en texto)', r.status === 200 && /^\$2[aby]\$12\$/.test(guardada) && !guardada.includes('clave-nueva'), `${r.status} ${guardada.slice(0, 7)}`);
  const sesionVieja = await pedir('GET', '/api/superadmin/estado', null, 'superadmin', 1);
  anotar('...y se cierran todas las sesiones (la anterior ya no sirve: 401)', sesionVieja.status === 401, String(sesionVieja.status));
  const loginNueva = await pedir('POST', '/api/login', { password: 'clave-nueva-de-admins' });
  const loginVieja = await pedir('POST', '/api/login', { password: CLAVE_ADMIN_VIEJA });
  const loginSuper = await pedir('POST', '/api/login', { password: CLAVE_SUPER });
  anotar('Los admins entran con la nueva; la de Render ya no sirve; el admin supremo sigue con la suya',
    loginNueva.status === 200 && loginNueva.datos.rol === 'admin' && loginVieja.status === 401 && loginSuper.status === 200 && loginSuper.datos.rol === 'superadmin',
    `${loginNueva.status} ${loginVieja.status} ${loginSuper.status}`);
  await esperar(300);
  anotar('El registro anota el cambio de contraseña (sin la contraseña)', db.registro_actividad.some(a => a.accion === 'Cambió la contraseña del panel de los admins') && !JSON.stringify(db.registro_actividad).includes('clave-nueva'));

  hijo.kill();
  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
