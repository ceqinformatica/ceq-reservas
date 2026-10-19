// Prueba el editor de los Términos y condiciones y de la Política de privacidad (admin supremo):
// el texto público, los comodines que siguen a las Reglas, la seguridad del formato (sin HTML ni
// enlaces peligrosos), las correcciones, las versiones nuevas con su historial y que todo siga
// después de reiniciar. Con el server.js real, Supabase simulado, Brevo interceptado y reloj falso.
// Uso: node probar_legal.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-legal-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-legal-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const SECRETO = 'secreto-legal';

const db = {
  reservas: [], espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }],
  registro_actividad: [], reportes_errores: [], bloqueos: [], lista_espera: [], correos_pendientes: []
};
const mini = crearMiniPostgrest(db, {
  unicas: { configuracion: [['clave']] },
  porDefecto: {
    registro_actividad: () => ({ creado_en: new Date(Date.now() + desfase).toISOString() }),
    correos_pendientes: () => ({ intentos: 0, creado_en: new Date(Date.now() + desfase).toISOString(), reclamado_hasta: null, ultimo_error: null, enviado_en: null })
  }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3982', SUPABASE_URL: 'http://127.0.0.1:54334', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '600000', INTERVALO_COLA_CORREOS_MS: '300',
      NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3982';
let ipN = 1;
async function pedir(metodo, ruta, cuerpo, rol) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${ipN++ % 250}` };
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
const REGLAS = (cambio = {}) => ({
  reglas: {
    3: { dias: [1, 2, 3, 4, 5], plazo_cancelacion_dias: 2, recordatorio: true, recordatorio_dias: 2, anticipacion_min_dias: 0, anticipacion_max_dias: 0, limite_por_persona_mes: 0, normas: '', ...(cambio[3] || {}) },
    1: { dias: [1, 2, 3, 4, 5], plazo_cancelacion_dias: 0, recordatorio: true, recordatorio_dias: 2, anticipacion_min_dias: 0, anticipacion_max_dias: 0, limite_por_persona_mes: 0, normas: '', ...(cambio[1] || {}) }
  }, max_reservas_por_persona_mes: 2
});

(async () => {
  await new Promise(ok => mini.servidor.listen(54334, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  const hijo = await arrancar();
  await esperar(800);

  // ===== Permisos =====
  const prohibidas = [await pedir('GET', '/api/superadmin/legal', null, 'admin'), await pedir('POST', '/api/superadmin/legal/terminos', { publicar: 'correccion' }, 'admin'),
    await pedir('POST', '/api/superadmin/legal/vista-previa', { doc: 'terminos' }, 'admin'), await pedir('GET', '/api/superadmin/legal/terminos/historial/0', null, 'admin')];
  anotar('El admin común no puede ver ni editar los textos legales (403)', prohibidas.every(p => p.status === 403), prohibidas.map(p => p.status).join(','));

  // ===== Texto público de siempre =====
  let t = await pedir('GET', '/api/legal/terminos');
  let p = await pedir('GET', '/api/legal/privacidad');
  const noExiste = await pedir('GET', '/api/legal/otro');
  anotar('Público: Términos v1.3 y Privacidad v1.2 con el texto de siempre (y un documento que no existe da 404)',
    t.status === 200 && t.datos.version === '1.3' && t.datos.html.startsWith('<p class="fecha">Versión 1.3 · Vigente desde el 16 de octubre de 2026</p>') &&
    t.datos.html.includes('<h2>Artículo 18.') && p.status === 200 && p.datos.version === '1.2' && p.datos.html.includes('<h2>Artículo 16. Contacto</h2>') && noExiste.status === 404,
    `${t.status} ${t.datos.version} ${p.status} ${p.datos.version} ${noExiste.status}`);
  anotar('...los comodines salen con las reglas de hoy (2 días, de lunes a viernes, 07:00 a 19:00, 4 acompañantes, 6 meses)',
    t.datos.html.includes('es posible hasta dos (2) días calendario antes de la fecha de la Reserva.') && t.datos.html.includes('Las Reservas se realizan de lunes a viernes,') &&
    t.datos.html.includes('entre las 07:00 y las 19:00 (el primer bloque comienza a las 07:00 y el último, a las 18:00), con una duración mínima de una (1) hora y máxima de dos (2) horas por Reserva') &&
    t.datos.html.includes('Dos (2) días antes de la fecha, el Sistema enviará un recordatorio al correo registrado.') && t.datos.html.includes('hasta cuatro (4) acompañantes') &&
    p.datos.html.includes('seis (6) meses') && !/\{[a-z_]+\}/.test(t.datos.html + p.datos.html), '');
  anotar('...el correo con mensaje armado sale como enlace mailto con asunto y mensaje', /<a href="mailto:reservas@ceq-una\.com\?subject=Consulta%20sobre%20los%20T%C3%A9rminos[^"]*&amp;body=Hola%2C/.test(t.datos.html) &&
    /subject=Solicitud%20sobre%20mis%20datos/.test(p.datos.html), '');

  // ===== Editor =====
  let ed = await pedir('GET', '/api/superadmin/legal', null, 'superadmin');
  const term = ed.datos.documentos.terminos;
  anotar('El editor recibe los dos documentos, sus correos con mensaje armado, los comodines con su valor y qué comodines usa cada uno',
    ed.status === 200 && term.articulos.length === 18 && term.plantillas.consulta && ed.datos.documentos.privacidad.plantillas.derechos &&
    ed.datos.comodines.some(c => c.clave === 'plazo_cancelacion_frente' && c.valor.startsWith('hasta dos (2)')) && term.comodines_usados.includes('recordatorio') && term.historial.length === 0,
    `${ed.status}`);

  // ===== Los comodines siguen a las Reglas =====
  await pedir('POST', '/api/superadmin/reglas', REGLAS({ 3: { plazo_cancelacion_dias: 3, recordatorio_dias: 3 }, 1: { recordatorio_dias: 3, dias: [1, 2, 3, 4, 5, 6] } }), 'superadmin');
  await pedir('POST', '/api/superadmin/configuracion', { altillo_hora_hasta: 20 }, 'superadmin');
  t = await pedir('GET', '/api/legal/terminos');
  anotar('Al cambiar las Reglas, los Términos cambian solos (3 días, recordatorio 3 días, sábados en el Altillo, Altillo hasta las 20:00)',
    t.datos.html.includes('hasta tres (3) días calendario antes') && t.datos.html.includes('Tres (3) días antes de la fecha, el Sistema enviará') &&
    t.datos.html.includes('en el Frente, de lunes a viernes, y en el Altillo, de lunes a sábado') && t.datos.html.includes('entre las 07:00 y las 20:00 (el primer bloque comienza a las 07:00 y el último, a las 19:00)'),
    t.datos.html.match(/7\.2\.[^<]*<\/strong>[^<]*/) && t.datos.html.match(/7\.2\.[^<]*<\/strong>[^<]*/)[0]);
  await pedir('POST', '/api/superadmin/reglas', REGLAS({ 3: { recordatorio: false } , 1: { recordatorio: false } }), 'superadmin');
  t = await pedir('GET', '/api/legal/terminos');
  anotar('...y si se apaga el recordatorio, la frase lo dice', t.datos.html.includes('El Sistema no envía recordatorios'), '');
  await pedir('POST', '/api/superadmin/reglas', REGLAS(), 'superadmin');
  await pedir('POST', '/api/superadmin/configuracion', { altillo_hora_hasta: 19 }, 'superadmin');

  // ===== Vista previa y seguridad del formato =====
  const base = { doc: 'terminos', intro: term.intro, articulos: term.articulos.map(a => ({ ...a })), plantillas: term.plantillas };
  const conArticulo1 = texto => ({ ...base, articulos: base.articulos.map((a, i) => (i === 0 ? { ...a, texto } : a)) });
  let r = await pedir('POST', '/api/superadmin/legal/vista-previa', conArticulo1('Texto con **negrita**, un [enlace](https://ceq-una.com) y una lista:\n- uno\n- dos\n\na) primera\nb) segunda'), 'superadmin');
  anotar('Vista previa: negrita, enlace, lista con viñetas y lista con letras', r.status === 200 && r.datos.html.includes('<strong>negrita</strong>') &&
    r.datos.html.includes('<a href="https://ceq-una.com">enlace</a>') && r.datos.html.includes('<ul>\n  <li>uno</li>\n  <li>dos</li>\n</ul>') && r.datos.html.includes('<ul class="letras">\n  <li>a) primera</li>'), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/superadmin/legal/vista-previa', { ...conArticulo1('Hola <script>alert(1)</script> <img src=x onerror=alert(1)>'), articulos: [{ titulo: '<b>Título</b>', texto: 'x "y" \'z\'' }] }, 'superadmin');
  anotar('Nada de HTML: <script>, <img> y etiquetas en el título salen como texto (escapados)', r.status === 200 && !r.datos.html.includes('<script>') && !r.datos.html.includes('<b>') &&
    r.datos.html.includes('&lt;b&gt;Título&lt;/b&gt;'), r.datos.html && r.datos.html.slice(-200));
  r = await pedir('POST', '/api/superadmin/legal/vista-previa', { ...conArticulo1('x'), articulos: [{ titulo: 'Uno', texto: 'Hola <script>alert(1)</script>' }] }, 'superadmin');
  anotar('...también en el texto', r.status === 200 && !r.datos.html.includes('<script>') && r.datos.html.includes('&lt;script&gt;'), '');
  const malos = [
    await pedir('POST', '/api/superadmin/legal/vista-previa', conArticulo1('[clic](javascript:alert(1))'), 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/vista-previa', conArticulo1('[clic](http://sitio-inseguro.com)'), 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/vista-previa', conArticulo1('[escribinos](plantilla:no_existe)'), 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/vista-previa', conArticulo1('Plazo: {plazo_inventado}'), 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/vista-previa', { ...base, articulos: [] }, 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/vista-previa', { ...base, articulos: [{ titulo: 'Ok', texto: '' }] }, 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/vista-previa', { ...base, plantillas: { 'Mala Clave': { para: 'a@b.com', asunto: 'x', cuerpo: '' } } }, 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/vista-previa', { ...base, plantillas: { ...base.plantillas, otra: { para: 'no-es-correo', asunto: 'x', cuerpo: '' } } }, 'superadmin')
  ];
  anotar('Rechaza (400 con el motivo): enlace javascript:, enlace http sin s, plantilla que no existe, comodín inventado, sin artículos, artículo vacío, nombre de plantilla inválido, correo inválido',
    malos.every(m => m.status === 400 && m.datos.error), malos.map(m => `${m.status} ${m.datos.error}`).join(' | '));
  anotar('...y el error del comodín dice cuáles se pueden usar', /\{plazo_inventado\}/.test(malos[3].datos.error) && /\{plazo_cancelacion_frente\}/.test(malos[3].datos.error), malos[3].datos.error);

  // ===== Corrección (misma versión) =====
  r = await pedir('POST', '/api/superadmin/legal/terminos', { ...conArticulo1(base.articulos[0].texto), publicar: 'correccion' }, 'superadmin');
  anotar('Corrección sin cambios: "No había cambios"', r.status === 200 && r.datos.mensaje === 'No había cambios', JSON.stringify(r.datos));
  const textoCorregido = base.articulos[0].texto.replace('A los efectos de estos Términos, se entiende por:', 'A los efectos de estos Términos, se entiende por (corregido):');
  r = await pedir('POST', '/api/superadmin/legal/terminos', { ...conArticulo1(textoCorregido), publicar: 'correccion' }, 'superadmin');
  t = await pedir('GET', '/api/legal/terminos');
  anotar('Corrección: se ve en la página y queda la misma versión y fecha', r.status === 200 && t.datos.version === '1.3' && t.datos.vigente_desde === '2026-10-16' && t.datos.html.includes('se entiende por (corregido):'), `${r.status} ${r.datos.error || ''} ${t.datos.version}`);

  // ===== Versión nueva =====
  const nuevoTexto = { ...conArticulo1(textoCorregido), articulos: [...conArticulo1(textoCorregido).articulos, { titulo: 'Artículo 19. Disposición de prueba', texto: '19.1. Texto nuevo con **negrita** y [contacto](plantilla:consulta).' }] };
  const malasVersiones = [
    await pedir('POST', '/api/superadmin/legal/terminos', { ...nuevoTexto, publicar: 'menor', resumen: '' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/terminos', { ...nuevoTexto, publicar: 'menor', resumen: 'Agrega el artículo 19', vigente_desde: '2026-11-10' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/legal/terminos', { ...nuevoTexto, publicar: 'otra cosa' }, 'superadmin')
  ];
  anotar('Versión nueva sin resumen, con fecha pasada o con un tipo inválido: 400', malasVersiones.every(m => m.status === 400), malasVersiones.map(m => `${m.status} ${m.datos.error}`).join(' | '));
  r = await pedir('POST', '/api/superadmin/legal/terminos', { ...nuevoTexto, publicar: 'menor', resumen: 'Agrega el artículo 19 de prueba', vigente_desde: '2026-11-20' }, 'superadmin');
  t = await pedir('GET', '/api/legal/terminos');
  anotar('Versión nueva (menor): 1.3 -> 1.4, con su fecha de vigencia, el artículo nuevo y su enlace al correo con mensaje armado',
    r.status === 200 && r.datos.version === '1.4' && t.datos.html.startsWith('<p class="fecha">Versión 1.4 · Vigente desde el 20 de noviembre de 2026</p>') &&
    t.datos.html.includes('<h2>Artículo 19. Disposición de prueba</h2>') && /19\.1\. Texto nuevo con <strong>negrita<\/strong> y <a href="mailto:reservas@ceq-una\.com\?subject=/.test(t.datos.html), `${r.status} ${r.datos.error || ''}`);
  ed = await pedir('GET', '/api/superadmin/legal', null, 'superadmin');
  const h = ed.datos.documentos.terminos.historial;
  const anterior = await pedir('GET', '/api/superadmin/legal/terminos/historial/0', null, 'superadmin');
  anotar('...la 1.3 queda en el historial con su resumen y su texto, que se puede ver', h.length === 1 && h[0].version === '1.3' && h[0].resumen === 'Agrega el artículo 19 de prueba' && h[0].reemplazada_en === '2026-11-16' &&
    h[0].tiene_texto && anterior.status === 200 && anterior.datos.html.startsWith('<p class="fecha">Versión 1.3') && !anterior.datos.html.includes('Artículo 19.'), JSON.stringify(h));
  r = await pedir('POST', '/api/superadmin/legal/terminos', { ...nuevoTexto, publicar: 'mayor', resumen: 'Reescritura general de prueba' }, 'superadmin');
  anotar('Versión nueva (mayor): 1.4 -> 2.0, vigente desde hoy si no se elige fecha', r.status === 200 && r.datos.version === '2.0' && r.datos.vigente_desde === '2026-11-16', JSON.stringify(r.datos));
  await esperar(300);
  anotar('El registro de actividad anota las correcciones y las versiones publicadas', db.registro_actividad.some(a => a.accion === 'Corrigió Términos y condiciones') &&
    db.registro_actividad.some(a => a.accion === 'Publicó Términos y condiciones v1.4' && /20\/11\/2026/.test(a.detalle)) && db.registro_actividad.some(a => a.accion === 'Publicó Términos y condiciones v2.0'), '');

  // ===== Correo con mensaje armado editado =====
  const plantillas = { ...base.plantillas, consulta: { ...base.plantillas.consulta, asunto: 'Asunto nuevo de prueba' } };
  r = await pedir('POST', '/api/superadmin/legal/terminos', { ...nuevoTexto, plantillas, publicar: 'correccion' }, 'superadmin');
  t = await pedir('GET', '/api/legal/terminos');
  anotar('Cambiar el asunto del correo con mensaje armado cambia todos sus enlaces', r.status === 200 && t.datos.html.includes('subject=Asunto%20nuevo%20de%20prueba') && !t.datos.html.includes('subject=Consulta%20sobre%20los'), `${r.status} ${r.datos.error || ''}`);

  // ===== La Privacidad no se tocó y todo sigue después de reiniciar =====
  hijo.kill();
  await esperar(500);
  const hijo2 = await arrancar();
  await esperar(800);
  t = await pedir('GET', '/api/legal/terminos');
  p = await pedir('GET', '/api/legal/privacidad');
  ed = await pedir('GET', '/api/superadmin/legal', null, 'superadmin');
  anotar('Después de reiniciar: Términos 2.0 con sus cambios e historial (1.4 y 1.3); Privacidad sigue en 1.2', t.datos.version === '2.0' && t.datos.html.includes('Artículo 19.') &&
    ed.datos.documentos.terminos.historial.map(x => x.version).join() === '1.4,1.3' && p.datos.version === '1.2', `${t.datos.version} ${ed.datos.documentos.terminos.historial.map(x => x.version)} ${p.datos.version}`);

  hijo2.kill();
  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
