// Prueba la copia completa y la restauración (AUD-06), de punta a punta: el server.js real arma la
// copia (la que se baja del panel y la que va adjunta a la copia mensual), restaurar.js la convierte
// en SQL, y ese SQL se carga en un PostgreSQL de verdad (PGlite) creado con esquema-base-de-datos.sql.
// Uso: node probar_restaurar.js <carpeta del repo (server.js, restaurar.js, esquema y node_modules)> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const [carpeta, ayudantes] = process.argv.slice(2);
const req = createRequire(path.join(carpeta, 'package.json'));
const jwt = req('jsonwebtoken');
const { PGlite } = req('@electric-sql/pglite');
const { btree_gist } = req('@electric-sql/pglite/contrib/btree_gist');
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const { leerCopia, armarSql } = require(path.join(carpeta, 'restaurar.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-rest-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-rest-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const hasta = async (condicion, ms = 8000) => { for (let i = 0; i < ms / 100 && !condicion(); i++) await esperar(100); return condicion(); };
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const SECRETO = 'secreto-restaurar';

// Filas con las mismas columnas que la base de verdad (como las devuelve Supabase con select *)
const reserva = (id, extra = {}) => ({
  id, espacio_id: 3, nombre_solicitante: `Persona ${id}`, contacto: `0981 000 ${id} | persona${id}@example.com`, fecha: '2026-11-25', hora_inicio: '07:00:00', hora_fin: '10:00:00',
  estado: 'activa', motivo: 'Actividad Personal', codigo_cancelacion: null, created_at: '2026-11-10T12:00:00', updated_at: '2026-11-10T12:00:00',
  horario: '["2026-11-25 07:00:00","2026-11-25 10:00:00")', codigo_cancelacion_hash: 'hash' + id, reservado_por_admin: false, cancelada_en: null, cancelada_por: null,
  motivo_cancelacion: null, recordatorio_enviado_en: null, asistencia: null, acompanantes: [], ...extra
});
const db = {
  espacios: [
    { id: 1, nombre: 'Altillo', descripcion: 'Espacio arriba', created_at: '2026-05-10T00:00:00', publico: true, aviso: null },
    { id: 2, nombre: 'Sala de Reuniones', descripcion: 'Sala principal', created_at: '2026-05-10T00:00:00', publico: false, aviso: null },
    { id: 3, nombre: 'Frente', descripcion: 'Espacio frente', created_at: '2026-05-10T00:00:00', publico: true, aviso: 'Aviso "con comillas" y $signos$' }
  ],
  meses_habilitados: [{ id: 7, anio: 2026, mes: 11, habilitado: true, created_at: '2026-10-01T00:00:00', updated_at: '2026-10-01T00:00:00', abrir_en: null },
    { id: 8, anio: 2026, mes: 12, habilitado: false, created_at: '2026-10-01T00:00:00', updated_at: '2026-10-01T00:00:00', abrir_en: '2026-11-25T11:00:00+00:00' }],
  configuracion: [
    { clave: 'version_sesiones', valor: '3' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }, { clave: 'email_alertas', valor: 'alertas@example.com' },
    { clave: 'admin_password_hash', valor: '$2a$12$abcdefghijklmnopqrstuuvwxyz0123456789ABCDEFGHIJKLMNOPQ' },
    { clave: 'motivos_frente', valor: '["Actividad Personal","Otro motivo"]' }
  ],
  reservas: [
    reserva(150, { acompanantes: [{ nombre: "O'Higgins \\ Barra", celular: '0981 222 333' }], espacio_id: 1, hora_inicio: '09:00:00', hora_fin: '11:00:00', horario: '["2026-11-25 09:00:00","2026-11-25 11:00:00")' }),
    reserva(151, { estado: 'cancelada', cancelada_en: '2026-11-11T10:00:00+00:00', cancelada_por: 'moderador', motivo_cancelacion: 'Lluvia' }),
    reserva(152, { estado: 'activa', hora_inicio: '07:00:00', hora_fin: '10:00:00', fecha: '2026-11-26', horario: '["2026-11-26 07:00:00","2026-11-26 10:00:00")', reservado_por_admin: true }),
    reserva(160, { nombre_solicitante: '', contacto: '', fecha: '2026-04-01', horario: '["2026-04-01 07:00:00","2026-04-01 10:00:00")', motivo: '' }) // anonimizada
  ],
  bloqueos: [{ id: 30, espacio_id: 3, fecha: '2026-11-27', hora_inicio: '00:00:00', hora_fin: '23:59:00', motivo: 'Feriado', created_at: '2026-11-01T00:00:00', lote: 'abc' }],
  lista_espera: [{ id: 40, espacio_id: 3, email: 'espera@example.com', nombre: 'Lola Espera', mes: '2026-11', creado_en: '2026-11-12T10:00:00+00:00', avisado_en: null }],
  reportes_errores: [{ id: 50, mensaje: 'No carga\nel calendario', url: 'https://reservas.ceq-una.com/', navegador: 'Mozilla', leido: false, created_at: '2026-11-13T10:00:00', estado: 'nuevo', nota: null }],
  registro_actividad: [{ id: 60, creado_en: '2026-11-14T10:00:00+00:00', rol: 'admin', accion: 'Canceló una reserva', detalle: '#151' }],
  correos_pendientes: [{ id: 70, destinatarios: ['x@example.com'], asunto: 'Pendiente con código', html: 'Código: ABC', texto: null, responder_a: null, estado: 'pendiente', intentos: 0,
    proximo_intento: '2030-01-01T00:00:00+00:00', reclamado_hasta: null, ultimo_error: null, creado_en: '2026-11-15T10:00:00+00:00', enviado_en: null }]
};
const mini = crearMiniPostgrest(db, {
  unicas: { configuracion: [['clave']] },
  porDefecto: {
    registro_actividad: () => ({ creado_en: new Date(Date.now() + desfase).toISOString() }),
    correos_pendientes: () => ({ intentos: 0, reclamado_hasta: null, ultimo_error: null, enviado_en: null })
  }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3979', SUPABASE_URL: 'http://127.0.0.1:54337', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO, ADMIN_PASSWORD_HASH: 'x',
      EMAIL_MODERADOR: 'moderador@example.com', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, BREVO_RECHAZAR: path.join(os.tmpdir(), `ceq-rechazar-${marca}`), INTERVALO_TAREAS_MS: '1000', INTERVALO_COLA_CORREOS_MS: '600000', NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}

async function cargarEnBaseNueva(sql) {
  const base = new PGlite({ extensions: { btree_gist } });
  await base.exec(fs.readFileSync(path.join(carpeta, 'esquema-base-de-datos.sql'), 'utf8'));
  await base.exec(sql);
  return base;
}
const intentar = async (base, sql) => { try { await base.query(sql); return 'ok'; } catch (e) { return e.code || e.message; } };

(async () => {
  await new Promise(ok => mini.servidor.listen(54337, '127.0.0.1', ok));
  ponerHora('2026-11-20T13:00:00Z');
  const hijo = await arrancar();
  await esperar(800);

  // ===== La copia que se baja del panel =====
  const ahora = Math.floor((Date.now() + desfase) / 1000);
  const token = rol => jwt.sign({ adminId: 'admin', rol, v: 3, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
  let res = await fetch('http://127.0.0.1:3979/api/superadmin/copia?formato=json', { headers: { cookie: `admin_token=${token('admin')}` } });
  anotar('El admin común no puede bajar la copia completa (403)', res.status === 403, String(res.status));
  res = await fetch('http://127.0.0.1:3979/api/superadmin/copia?formato=json', { headers: { cookie: `admin_token=${token('superadmin')}` } });
  const copia = await res.json();
  anotar('El admin supremo la baja como archivo .json', res.status === 200 && /attachment; filename="reservas-ceq-\d{4}-\d{2}-\d{2}-completa\.json"/.test(res.headers.get('content-disposition') || ''), String(res.status));
  anotar('Trae las 8 tablas con todas sus filas', copia.formato === 'copia-ceq-reservas' && copia.version === 1 &&
    ['espacios', 'meses_habilitados', 'configuracion', 'reservas', 'bloqueos', 'lista_espera', 'reportes_errores', 'registro_actividad'].every(t => Array.isArray(copia.tablas[t])) &&
    copia.tablas.reservas.length === 4 && copia.tablas.bloqueos.length === 1, JSON.stringify(Object.keys(copia.tablas || {})));
  anotar('No trae la contraseña de los admins ni la cola de correos', !copia.tablas.configuracion.some(f => f.clave === 'admin_password_hash') && !copia.tablas.correos_pendientes &&
    !JSON.stringify(copia).includes('$2a$12$'), '');
  anotar('Las reservas llevan su código cifrado (así los códigos siguen sirviendo)', copia.tablas.reservas.every(f => f.codigo_cancelacion_hash), '');

  // ===== restaurar.js + una base nueva =====
  const archivoJson = path.join(os.tmpdir(), `ceq-copia-${marca}.json`);
  fs.writeFileSync(archivoJson, JSON.stringify(copia));
  const { sql, resumen } = armarSql(leerCopia(archivoJson));
  anotar('restaurar.js arma el SQL y dice cuántas filas hay por tabla', /begin;[\s\S]*commit;/.test(sql) && resumen.includes('reservas: 4'), resumen.join(', '));
  let base;
  try {
    base = await cargarEnBaseNueva(sql);
    anotar('El SQL se carga sin errores en una base nueva (después de esquema-base-de-datos.sql)', true);
  } catch (e) {
    anotar('El SQL se carga sin errores en una base nueva (después de esquema-base-de-datos.sql)', false, e.message);
  }
  if (base) {
    const uno = async q => (await base.query(q)).rows;
    const cuenta = async t => (await uno(`select count(*)::int n from public.${t}`))[0].n;
    const cuentas = {};
    for (const t of ['espacios', 'meses_habilitados', 'reservas', 'bloqueos', 'lista_espera', 'reportes_errores', 'registro_actividad']) cuentas[t] = await cuenta(t);
    anotar('Quedan todas las filas (3 espacios, 2 meses, 4 reservas, 1 bloqueo, 1 en la lista, 1 reporte, 1 registro)',
      JSON.stringify(cuentas) === JSON.stringify({ espacios: 3, meses_habilitados: 2, reservas: 4, bloqueos: 1, lista_espera: 1, reportes_errores: 1, registro_actividad: 1 }), JSON.stringify(cuentas));
    const reservas = await uno('select id, estado, codigo_cancelacion_hash, cancelada_por, acompanantes, reservado_por_admin, horario::text h from public.reservas order by id');
    anotar('Los números de reserva, los códigos cifrados y las cancelaciones quedan iguales', reservas.map(r => r.id).join() === '150,151,152,160' &&
      reservas.every(r => r.codigo_cancelacion_hash === 'hash' + r.id) && reservas[1].cancelada_por === 'moderador' && reservas[2].reservado_por_admin === true, JSON.stringify(reservas));
    anotar('Los acompañantes (con comillas y barras) y el horario calculado quedan bien', reservas[0].acompanantes[0].nombre === "O'Higgins \\ Barra" && reservas[0].h.includes('09:00:00'), JSON.stringify(reservas[0]));
    const espacios = await uno('select id, publico, aviso from public.espacios order by id');
    anotar('Los espacios quedan como en la copia (Altillo abierto, aviso del Frente con comillas y $)', espacios[0].publico === true && espacios[2].aviso === 'Aviso "con comillas" y $signos$', JSON.stringify(espacios));
    const conf = Object.fromEntries((await uno('select clave, valor from public.configuracion')).map(f => [f.clave, f.valor]));
    anotar('La configuración de la copia reemplaza a la inicial, sin la contraseña de los admins', conf.version_sesiones === '3' && conf.motivos_frente === '["Actividad Personal","Otro motivo"]' &&
      !('admin_password_hash' in conf) && conf.email_alertas === 'alertas@example.com', JSON.stringify(conf));
    const reporte = await uno('select mensaje from public.reportes_errores');
    anotar('Los saltos de línea de los textos quedan', reporte[0].mensaje === 'No carga\nel calendario', JSON.stringify(reporte));
    const nueva = await uno(`insert into public.reservas (espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, codigo_cancelacion_hash) values (3, 'Nueva', '0981 | n@example.com', '2026-12-01', '07:00', '10:00', 'nuevo') returning id`);
    anotar('Una reserva nueva recibe el número siguiente al más alto de la copia (161)', nueva[0].id === 161, JSON.stringify(nueva));
    anotar('Las reglas de la base siguen activas: superposición (23P01), reserva sobre bloqueo (CEQ01), bloqueo sobre reserva (CEQ02)',
      await intentar(base, `insert into public.reservas (espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin) values (3, 'X', 'x', '2026-11-26', '07:00', '10:00')`) === '23P01' &&
      await intentar(base, `insert into public.reservas (espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin) values (3, 'X', 'x', '2026-11-27', '07:00', '10:00')`) === 'CEQ01' &&
      await intentar(base, `insert into public.bloqueos (espacio_id, fecha, hora_inicio, hora_fin) values (3, '2026-11-26', '08:00', '09:00')`) === 'CEQ02', '');
    const triggers = await uno(`select tgname, tgenabled from pg_trigger where tgname like 'trg_verificar%' order by tgname`);
    anotar('Los dos triggers quedan prendidos', triggers.length === 2 && triggers.every(t => t.tgenabled === 'O'), JSON.stringify(triggers));
  }

  // Si algo falla en el medio, no queda nada cargado (todo va en una transacción)
  const rota = JSON.parse(JSON.stringify(copia));
  rota.tablas.bloqueos.push({ ...rota.tablas.bloqueos[0], id: 31, fecha: 'no-es-fecha' });
  const base2 = new PGlite({ extensions: { btree_gist } });
  await base2.exec(fs.readFileSync(path.join(carpeta, 'esquema-base-de-datos.sql'), 'utf8'));
  let fallo = '';
  try { await base2.exec(armarSql(rota).sql); } catch (e) { fallo = e.message; }
  if (fallo) await base2.exec('rollback');
  const reservasTrasFallo = (await base2.query('select count(*)::int n from public.reservas')).rows[0].n;
  anotar('Con un dato roto la carga falla y la base queda vacía (no a medias)', !!fallo && reservasTrasFallo === 0, `${fallo} · ${reservasTrasFallo} reservas`);
  let error = '';
  const archivoMalo = path.join(os.tmpdir(), `ceq-copia-mala-${marca}.json`);
  fs.writeFileSync(archivoMalo, JSON.stringify({ reservas: [] }));
  try { leerCopia(archivoMalo); } catch (e) { error = e.message; }
  anotar('Un archivo que no es una copia del sistema se rechaza con un mensaje claro', /no es una copia completa/.test(error), error);

  // Las copias viejas (.json.gz, de antes del 23/10) se siguen leyendo
  const archivoGzViejo = path.join(os.tmpdir(), `ceq-copia-vieja-${marca}.json.gz`);
  fs.writeFileSync(archivoGzViejo, zlib.gzipSync(Buffer.from(JSON.stringify(copia))));
  anotar('restaurar.js también lee una copia vieja en .json.gz', leerCopia(archivoGzViejo).tablas.reservas.length === 4);
  fs.unlinkSync(archivoGzViejo);

  // ===== "Mandarme la copia ahora" (desde el panel) =====
  const enviarDesdePanel = () => fetch('http://127.0.0.1:3979/api/superadmin/copia/enviar', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `admin_token=${token('superadmin')}; csrf_token=c`, 'x-csrf-token': 'c' } });
  res = await fetch('http://127.0.0.1:3979/api/superadmin/copia/enviar', { method: 'POST', headers: { cookie: `admin_token=${token('admin')}; csrf_token=c`, 'x-csrf-token': 'c' } });
  anotar('"Mandarme la copia ahora": el admin común no puede (403)', res.status === 403, String(res.status));
  res = await enviarDesdePanel();
  let datosPanel = await res.json();
  await hasta(() => correos().some(c => /pedida desde el panel/.test(c.subject)));
  const desdePanel = correos().find(c => /pedida desde el panel/.test(c.subject));
  anotar('...el supremo la recibe en el momento, con el CSV y la copia completa (.zip)', res.status === 200 && datosPanel.completa === true && desdePanel &&
    (desdePanel.attachment || []).map(a => a.name.replace(/\d{4}-\d{2}/, 'AAAA-MM')).join() === 'reservas-ceq-AAAA-MM.csv,reservas-ceq-AAAA-MM-completa.zip', `${res.status} ${datosPanel.mensaje || datosPanel.error}`);
  // Si Brevo rechazara el .zip, sale igual el CSV solo (y se avisa)
  const archivoRechazar = path.join(os.tmpdir(), `ceq-rechazar-${marca}`);
  fs.writeFileSync(archivoRechazar, 'zip');
  const antesSoloCsv = correos().length;
  res = await enviarDesdePanel();
  datosPanel = await res.json();
  fs.unlinkSync(archivoRechazar);
  await hasta(() => correos().length > antesSoloCsv);
  const soloCsv = correos().slice(antesSoloCsv).find(c => /pedida desde el panel/.test(c.subject));
  anotar('...si Brevo rechaza la copia completa, sale igual el CSV y el panel lo dice', res.status === 200 && datosPanel.completa === false && /Salió solo el CSV/.test(datosPanel.mensaje) &&
    soloCsv && (soloCsv.attachment || []).length === 1 && soloCsv.htmlContent.includes('La copia completa no se pudo adjuntar'), `${res.status} ${datosPanel.mensaje || datosPanel.error}`);

  // ===== La copia mensual trae también la copia completa comprimida (.zip) =====
  ponerHora('2026-12-01T11:30:00Z'); // 1/12, 08:30 en Paraguay
  await hasta(() => correos().some(c => /Copia de seguridad de las reservas: diciembre 2026/.test(c.subject) && !/panel/.test(c.subject)), 10000);
  const mensual = correos().find(c => /Copia de seguridad de las reservas: diciembre 2026/.test(c.subject) && !/panel/.test(c.subject));
  const adjuntos = (mensual && mensual.attachment) || [];
  const zip = adjuntos.find(a => a.name === 'reservas-ceq-2026-12-completa.zip');
  anotar('La copia mensual trae el CSV y la copia completa (.zip, que Brevo sí acepta)', adjuntos.some(a => a.name === 'reservas-ceq-2026-12.csv') && !!zip && adjuntos.length === 2, adjuntos.map(a => a.name).join(', '));
  if (zip) {
    const archivoZip = path.join(os.tmpdir(), `ceq-copia-${marca}.zip`);
    fs.writeFileSync(archivoZip, Buffer.from(zip.content, 'base64'));
    // El .zip lo abre un programa común (unzip o tar), no solo restaurar.js
    const { spawnSync } = require('child_process');
    const abrir = [['unzip', ['-p', archivoZip]], ['tar', ['-xOf', archivoZip]]].map(([cmd, args]) => spawnSync(cmd, args, { maxBuffer: 50 * 1024 * 1024 }))
      .find(r => r.status === 0 && r.stdout && r.stdout.length);
    anotar('El .zip lo abre un programa común (unzip o tar) y adentro está la copia en JSON', !!abrir && JSON.parse(abrir.stdout.toString('utf8')).formato === 'copia-ceq-reservas', abrir ? 'ok' : 'ni unzip ni tar lo abrieron');
    let base3;
    try { base3 = await cargarEnBaseNueva(armarSql(leerCopia(archivoZip)).sql); } catch (e) { anotar('La copia del correo (.zip) se restaura', false, e.message); }
    if (base3) {
      const n = (await base3.query('select count(*)::int n from public.reservas')).rows[0].n;
      anotar('La copia del correo (.zip) se restaura con todas las reservas', n === 4, String(n));
    }
    fs.unlinkSync(archivoZip);
  }
  anotar('El correo explica los dos archivos y la limpieza (guarda las 2 copias más nuevas)', mensual && mensual.htmlContent.includes('restaurar.js') && mensual.htmlContent.includes('2 copias más nuevas'), '');
  anotar('La copia del mes queda anotada como enviada, sin errores', db.configuracion.find(f => f.clave === 'copia_mensual_enviada').valor === '2026-12' &&
    !((db.configuracion.find(f => f.clave === 'copia_mensual_error') || {}).valor), JSON.stringify(db.configuracion.filter(f => /copia/.test(f.clave))));

  // ===== Si la copia del mes no sale: alerta, "Estado del sistema" en rojo y reintento por hora =====
  fs.writeFileSync(archivoRechazar, 'zip csv');
  ponerHora('2027-01-01T11:30:00Z'); // 1/1, 08:30 en Paraguay
  const errorCopia = () => { try { return JSON.parse((db.configuracion.find(f => f.clave === 'copia_mensual_error') || {}).valor || 'null'); } catch (e) { return null; } };
  await hasta(() => errorCopia() && errorCopia().mes === '2027-01', 10000);
  const estado = await fetch('http://127.0.0.1:3979/api/superadmin/estado', { headers: { cookie: `admin_token=${jwt.sign({ adminId: 'admin', rol: 'superadmin', v: 3, iat: Math.floor((Date.now() + desfase) / 1000), exp: Math.floor((Date.now() + desfase) / 1000) + 3600 }, SECRETO, { algorithm: 'HS256' })}` } }).then(r => r.json());
  anotar('Si Brevo rechaza la copia: queda anotado el problema y "Estado del sistema" lo muestra', /^No salió/.test((errorCopia() || {}).problema || '') &&
    estado.copia_mensual_error && /^No salió/.test(estado.copia_mensual_error.problema) && db.configuracion.find(f => f.clave === 'copia_mensual_enviada').valor === '2026-12', JSON.stringify(estado.copia_mensual_error));
  await hasta(() => correos().some(c => c.to[0].email === 'alertas@example.com' && /Copia de seguridad de 2027-01/.test(c.htmlContent)), 10000);
  anotar('...y llega una alerta al correo de alertas', correos().some(c => c.to[0].email === 'alertas@example.com' && /Copia de seguridad de 2027-01: No salió/.test(c.htmlContent)), '');
  const intentosAntes = correos().length;
  await esperar(3000);
  anotar('...no reintenta cada 5 minutos (espera una hora)', db.configuracion.find(f => f.clave === 'copia_mensual_enviada').valor === '2026-12' && !correos().slice(intentosAntes).some(c => /enero 2027/.test(c.subject)), '');
  fs.unlinkSync(archivoRechazar);
  ponerHora('2027-01-01T12:35:00Z'); // una hora después
  await hasta(() => correos().some(c => /Copia de seguridad de las reservas: enero 2027/.test(c.subject)), 10000);
  anotar('...pasada la hora vuelve a intentar, sale y se borra el aviso', correos().some(c => /Copia de seguridad de las reservas: enero 2027/.test(c.subject)) &&
    db.configuracion.find(f => f.clave === 'copia_mensual_enviada').valor === '2027-01' && !errorCopia(), JSON.stringify(db.configuracion.filter(f => /copia/.test(f.clave))));

  hijo.kill(); mini.servidor.close();
  [brevoLog, relojArchivo, archivoJson, archivoMalo].forEach(f => { try { fs.unlinkSync(f); } catch (e) { /* ya no está */ } });
  let ok = 0;
  for (const x of resultados) { console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + String(x.detalle).slice(0, 400)}`); if (x.ok) ok++; }
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
