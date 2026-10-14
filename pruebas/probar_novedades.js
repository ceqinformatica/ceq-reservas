// Prueba la ventana de novedades (la escribe el admin supremo) y deshabilitar un espacio sin
// aviso, con el server.js real, Supabase simulado y Brevo interceptado.
// Uso: node probar_novedades.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-novedades-' + Date.now() + '.log');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const SECRETO = 'secreto-novedades';

const db = {
  reservas: [],
  espacios: [
    { id: 1, nombre: 'Altillo', publico: false, aviso: 'Por el momento el Altillo se reserva con planilla.' },
    { id: 2, nombre: 'Sala', publico: false, aviso: null },
    { id: 3, nombre: 'Frente', publico: true, aviso: null }
  ],
  meses_habilitados: [],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }],
  registro_actividad: [], lista_espera: [], bloqueos: [], reportes_errores: []
};
const mini = crearMiniPostgrest(db);

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3992', SUPABASE_URL: 'http://127.0.0.1:54327', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, INTERVALO_TAREAS_MS: '60000', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3992';
const token = rol => jwt.sign({ adminId: 'admin', rol, v: 1 }, SECRETO, { expiresIn: '1h', algorithm: 'HS256' });
let ipN = 1;
async function llamar(metodo, ruta, cuerpo, rol) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ipN++}` };
  if (rol) Object.assign(headers, { cookie: `admin_token=${token(rol)}; csrf_token=csrf-prueba`, 'x-csrf-token': 'csrf-prueba' });
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const datos = await res.json().catch(() => ({}));
  // El registro de actividad se guarda después de responder: se espera a que llegue
  if (metodo === 'POST' && res.status === 200) {
    const antes = db.registro_actividad.length;
    for (let i = 0; i < 50 && db.registro_actividad.length === antes; i++) await esperar(20);
  }
  return { status: res.status, datos };
}
const valorConfig = clave => (db.configuracion.find(c => c.clave === clave) || {}).valor;
const ultimaActividad = () => db.registro_actividad[db.registro_actividad.length - 1] || {};
const VENTANA = {
  titulo: 'Novedades de noviembre',
  intro: 'Hola:\n\nEsto cambió.',
  bloques: [{ titulo: 'Turnos nuevos', texto: 'Ahora hay turno de noche.' }, { titulo: '', texto: 'Leé la Política de privacidad.' }],
  cierre: 'Gracias.'
};

(async () => {
  await new Promise(ok => mini.servidor.listen(54327, '127.0.0.1', ok));
  let hijo = await arrancar();

  // ===== Ventana de novedades =====
  let r = await llamar('GET', '/api/configuracion');
  const inicial = r.datos.ventana_novedades;
  anotar('Sin nada guardado, la página recibe la ventana inicial (activa, versión 2026-10, 3 bloques)',
    inicial && inicial.version === '2026-10' && inicial.bloques.length === 3 && /Actualizamos/.test(inicial.titulo), JSON.stringify(inicial).slice(0, 120));

  r = await llamar('POST', '/api/superadmin/novedades', { ...VENTANA, activa: true, volver_a_mostrar: true });
  anotar('Sin sesión no se puede cambiar (401)', r.status === 401, String(r.status));
  r = await llamar('POST', '/api/superadmin/novedades', { ...VENTANA, activa: true, volver_a_mostrar: true }, 'admin');
  anotar('El admin común no puede (403)', r.status === 403, String(r.status));

  r = await llamar('POST', '/api/superadmin/novedades', { ...VENTANA, activa: true, volver_a_mostrar: true }, 'superadmin');
  const v1 = r.datos.ventana_novedades || {};
  anotar('El admin supremo publica: 200 y versión nueva', r.status === 200 && /^v\d+$/.test(v1.version) && v1.version !== '2026-10', `${r.status} ${v1.version}`);
  const guardada = JSON.parse(valorConfig('ventana_novedades') || '{}');
  anotar('Queda guardada en la tabla configuracion', guardada.titulo === VENTANA.titulo && guardada.bloques.length === 2 && guardada.activa === true);
  r = await llamar('GET', '/api/configuracion');
  anotar('La página recibe la ventana nueva tal cual', r.datos.ventana_novedades && r.datos.ventana_novedades.titulo === VENTANA.titulo &&
    r.datos.ventana_novedades.intro === VENTANA.intro && r.datos.ventana_novedades.bloques[1].titulo === '' && r.datos.ventana_novedades.version === v1.version);
  anotar('Queda en el registro de actividad', ultimaActividad().accion === 'Publicó la ventana de novedades' && ultimaActividad().detalle === VENTANA.titulo, JSON.stringify(ultimaActividad()));

  r = await llamar('POST', '/api/superadmin/novedades', { ...VENTANA, titulo: 'Novedades de noviembre (corregido)', activa: true, volver_a_mostrar: false }, 'superadmin');
  anotar('Corregir sin volver a mostrar conserva la versión', r.status === 200 && r.datos.ventana_novedades.version === v1.version && r.datos.ventana_novedades.titulo.includes('corregido'),
    `${r.status} ${r.datos.ventana_novedades && r.datos.ventana_novedades.version}`);
  anotar('...y se registra como corrección', ultimaActividad().accion === 'Corrigió la ventana de novedades');

  await esperar(5);
  r = await llamar('POST', '/api/superadmin/novedades', { ...VENTANA, activa: true, volver_a_mostrar: true }, 'superadmin');
  anotar('Publicar de nuevo cambia la versión (la vuelven a ver todos)', r.status === 200 && r.datos.ventana_novedades.version !== v1.version);

  r = await llamar('POST', '/api/superadmin/novedades', { ...VENTANA, activa: false }, 'superadmin');
  const quitada = await llamar('GET', '/api/configuracion');
  anotar('Quitar de la página: la página ya no recibe ventana', r.status === 200 && quitada.datos.ventana_novedades === null, JSON.stringify(quitada.datos.ventana_novedades));
  anotar('...pero el texto queda guardado para el panel', JSON.parse(valorConfig('ventana_novedades')).titulo === VENTANA.titulo && ultimaActividad().accion === 'Quitó la ventana de novedades');

  const invalidos = [
    [{ ...VENTANA, titulo: '   ', activa: true }, 'sin título'],
    [{ ...VENTANA, titulo: 'x'.repeat(81), activa: true }, 'título largo'],
    [{ ...VENTANA, bloques: Array(7).fill({ titulo: 'a', texto: 'b' }), activa: true }, '7 bloques'],
    [{ ...VENTANA, bloques: [{ titulo: '', texto: '' }], activa: true }, 'bloque vacío'],
    [{ ...VENTANA, bloques: [{ titulo: 'a', texto: 'x'.repeat(401) }], activa: true }, 'bloque largo'],
    [{ ...VENTANA, cierre: 'x'.repeat(601), activa: true }, 'cierre largo'],
    [{ ...VENTANA, activa: 'si' }, 'activa no booleano']
  ];
  const estados = [];
  for (const [cuerpo] of invalidos) estados.push((await llamar('POST', '/api/superadmin/novedades', cuerpo, 'superadmin')).status);
  anotar('Rechaza datos inválidos con 400 (sin título, largos, 7 bloques, bloque vacío, activa no booleano)', estados.every(s => s === 400), estados.join(','));
  anotar('Un rechazo no cambia lo guardado', JSON.parse(valorConfig('ventana_novedades')).activa === false);

  r = await llamar('POST', '/api/superadmin/novedades', { titulo: '<img src=x onerror=alert(1)>', bloques: [], activa: true, volver_a_mostrar: true }, 'superadmin');
  anotar('Un título con HTML se guarda como texto (la página lo muestra con textContent)', r.status === 200 && r.datos.ventana_novedades.titulo === '<img src=x onerror=alert(1)>');

  r = await llamar('POST', '/api/superadmin/configuracion', { ventana_novedades: { titulo: 'x' }, avisos_ocultos: [1] }, 'superadmin');
  anotar('La ruta general de configuración no toca la ventana ni los avisos', r.status === 400, String(r.status));

  // Sobrevive a un reinicio (se lee de la base)
  hijo.kill(); await esperar(300);
  hijo = await arrancar();
  await esperar(800); // la configuración se lee de la base al arrancar, sin bloquear el arranque
  r = await llamar('GET', '/api/configuracion');
  anotar('Después de reiniciar el servidor, sigue la última ventana', r.datos.ventana_novedades && r.datos.ventana_novedades.titulo === '<img src=x onerror=alert(1)>');

  // ===== Deshabilitar un espacio sin aviso =====
  r = await llamar('GET', '/api/espacios');
  const alt = () => r.datos.find(e => e.id === 1) || {};
  anotar('Por defecto, cada espacio muestra su aviso (mostrar_aviso true)', r.datos.every(e => e.mostrar_aviso === true));

  r = await llamar('POST', '/api/superadmin/espacios/1', { publico: false, aviso: 'Por el momento el Altillo se reserva con planilla.', mostrar_aviso: false }, 'superadmin');
  anotar('Guardar el Altillo deshabilitado sin aviso: 200', r.status === 200 && r.datos.espacio.mostrar_aviso === false, `${r.status} ${JSON.stringify(r.datos)}`);
  anotar('Se guarda en configuracion (avisos_ocultos = [1])', valorConfig('avisos_ocultos') === '[1]', valorConfig('avisos_ocultos'));
  r = await llamar('GET', '/api/espacios');
  anotar('La página recibe el Altillo con mostrar_aviso false y el texto intacto', alt().mostrar_aviso === false && alt().aviso === 'Por el momento el Altillo se reserva con planilla.' && alt().publico === false);
  anotar('El Frente no se toca', r.datos.find(e => e.id === 3).mostrar_aviso === true);
  anotar('El registro dice "sin aviso al entrar"', ultimaActividad().detalle === 'Altillo (sin aviso al entrar)', JSON.stringify(ultimaActividad()));

  r = await llamar('POST', '/api/superadmin/espacios/1', { publico: false, aviso: 'Por el momento el Altillo se reserva con planilla.', mostrar_aviso: 'no' }, 'superadmin');
  anotar('mostrar_aviso que no es true/false: 400', r.status === 400);

  r = await llamar('POST', '/api/superadmin/espacios/1', { publico: false, aviso: 'Por el momento el Altillo se reserva con planilla.' }, 'superadmin');
  r = await llamar('GET', '/api/espacios');
  anotar('Guardar sin el campo (panel viejo) deja la elección como estaba', alt().mostrar_aviso === false);

  r = await llamar('POST', '/api/superadmin/espacios/1', { publico: false, aviso: 'Por el momento el Altillo se reserva con planilla.', mostrar_aviso: true }, 'superadmin');
  r = await llamar('GET', '/api/espacios');
  anotar('Volver a marcar "mostrar aviso" lo vuelve a mostrar', alt().mostrar_aviso === true && valorConfig('avisos_ocultos') === '[]', valorConfig('avisos_ocultos'));

  r = await llamar('POST', '/api/superadmin/espacios/1', { publico: false, aviso: 'x', mostrar_aviso: false }, 'admin');
  anotar('El admin común no puede (403)', r.status === 403);

  hijo.kill();
  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
