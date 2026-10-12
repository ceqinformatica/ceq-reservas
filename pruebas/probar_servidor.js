// Prueba del server.js real con Node 24: Supabase simulado (servidor HTTP local) y Brevo interceptado.
// Uso: node probar_servidor.js <carpeta con server.js y node_modules> <interceptar_brevo.js>
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, interceptor] = process.argv.slice(2);
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-' + Date.now() + '.log');
fs.writeFileSync(brevoLog, '');

// ---- Supabase simulado ----
let baseCaida = false;
let reportesGuardados = [];
let siguienteId = 77;
const pedidosSupabase = [];
const supa = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => cuerpo += c);
  req.on('end', () => {
    pedidosSupabase.push(`${req.method} ${req.url}`);
    const enviar = (status, datos) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(datos)); };
    if (baseCaida) return enviar(500, { message: 'base caida', code: 'XX000' });
    if (req.url.startsWith('/rest/v1/meses_habilitados')) return enviar(200, [{ mes: 10 }]);
    if (req.url.startsWith('/rest/v1/reportes_errores') && req.method === 'POST') {
      const filas = JSON.parse(cuerpo);
      if (filas[0].mensaje === 'FALLA-BASE') return enviar(500, { message: 'insert fallido', code: 'XX000' });
      const id = siguienteId++;
      reportesGuardados.push({ id, ...filas[0] });
      return enviar(201, [{ id }]);
    }
    return enviar(200, []);
  });
});

const esperar = ms => new Promise(r => setTimeout(r, ms));
const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });

(async () => {
  await new Promise(r => supa.listen(54329, '127.0.0.1', r));

  const hijo = spawn(process.execPath, ['--require', interceptor, path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3999', SUPABASE_URL: 'http://127.0.0.1:54329', SUPABASE_KEY: 'clave-de-prueba',
      BREVO_API_KEY: 'clave-de-prueba', JWT_SECRET: 'secreto-de-prueba', ADMIN_PASSWORD_HASH: '$2a$10$abcdefghijklmnopqrstuuJ0r8m3Yt8rZbY4bW4bW4bW4bW4bW4bW',
      EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, NODE_OPTIONS: '' }
  });
  let salida = '';
  hijo.stdout.on('data', d => salida += d);
  hijo.stderr.on('data', d => salida += d);
  hijo.on('error', e => salida += 'ERROR AL INICIAR: ' + e.message + '\n');
  hijo.on('exit', c => salida += 'El proceso terminó con código ' + c + '\n');
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) { console.log('EL SERVIDOR NO ARRANCÓ. Salida:\n' + salida); hijo.kill(); supa.close(); process.exit(1); }
  anotar('El servidor arranca con Node ' + process.version, salida.includes('Servidor corriendo'), salida.split('\n')[0]);

  const API = 'http://127.0.0.1:3999';
  const leerEmails = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const reportar = (cuerpo, ip) => fetch(API + '/api/reportes', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(cuerpo) });

  // 1. Health (GET y HEAD)
  let r = await fetch(API + '/api/health'); let j = await r.json();
  anotar('GET /api/health responde 200 con db ok', r.status === 200 && j.db === 'ok', `${r.status} ${JSON.stringify(j)}`);
  r = await fetch(API + '/api/health', { method: 'HEAD' });
  anotar('HEAD /api/health (como UptimeRobot) responde 200', r.status === 200, String(r.status));

  // 2. Reporte normal -> se guarda y llega el aviso al moderador, con el contenido escapado
  r = await reportar({ mensaje: 'No carga el calendario\n<script>alert(1)</script>', url: 'https://reservas.ceq-una.com/', navegador: 'Mozilla/5.0 <b>Prueba</b>' }, '203.0.113.1');
  j = await r.json();
  // Se espera hasta que llegue el aviso (máx. 5 s): el correo sale después de responder
  for (let i = 0; i < 50 && leerEmails().length === 0; i++) await esperar(100);
  await esperar(100);
  let emails = leerEmails();
  const aviso = emails[0];
  anotar('Reporte válido: responde 201', r.status === 201, `${r.status} ${JSON.stringify(j)}`);
  anotar('Reporte válido: se guarda en la base', reportesGuardados.length === 1);
  anotar('Llega 1 aviso a ceq.informatica@gmail.com', emails.length === 1 && aviso.to.length === 1 && aviso.to[0].email === 'ceq.informatica@gmail.com', aviso && JSON.stringify(aviso.to));
  anotar('El asunto lleva el número del reporte (#77)', aviso && aviso.subject.includes('#77'), aviso && aviso.subject);
  anotar('El mensaje del usuario va escapado (no ejecuta HTML)', aviso && aviso.htmlContent.includes('&lt;script&gt;') && !aviso.htmlContent.includes('<script>') && aviso.htmlContent.includes('&lt;b&gt;Prueba'));
  anotar('Los saltos de línea se muestran', aviso && aviso.htmlContent.includes('No carga el calendario<br>&lt;script'));
  anotar('Incluye el enlace al panel de administración', aviso && aviso.htmlContent.includes('https://reservas.ceq-una.com/admin.html'));

  // 3. Reporte inválido -> 400 y sin aviso
  r = await reportar({ url: 'https://reservas.ceq-una.com/' }, '203.0.113.2');
  await esperar(200);
  anotar('Reporte sin mensaje: 400 y sin aviso', r.status === 400 && leerEmails().length === 1, String(r.status));
  r = await reportar({ mensaje: 'hola', url: 'javascript:alert(1)' }, '203.0.113.2');
  await esperar(200);
  anotar('Reporte con URL inválida: 400 y sin aviso', r.status === 400 && leerEmails().length === 1, String(r.status));

  // 4. Falla la base al guardar -> 500 genérico y sin aviso
  r = await reportar({ mensaje: 'FALLA-BASE' }, '203.0.113.3'); j = await r.json();
  await esperar(200);
  anotar('Si la base falla: 500 genérico y sin aviso', r.status === 500 && j.error === 'Error interno del servidor' && leerEmails().length === 1, `${r.status} ${JSON.stringify(j)}`);

  // 5. Tope diario: 25 reportes más desde IPs distintas -> se guardan todos, pero avisos hasta 20 en total
  const antes = reportesGuardados.length;
  for (let i = 0; i < 25; i++) await reportar({ mensaje: 'reporte masivo ' + i }, `198.51.100.${i + 1}`);
  await esperar(500);
  emails = leerEmails();
  anotar('Con 26 reportes en el día se guardan todos', reportesGuardados.length === antes + 25, `${reportesGuardados.length} guardados`);
  anotar('Pero los avisos se cortan en 20 por día', emails.length === 20, `${emails.length} avisos`);

  // 6. El límite por IP sigue funcionando (10 por hora)
  let codigos = [];
  for (let i = 0; i < 11; i++) { const x = await reportar({ mensaje: 'misma ip ' + i }, '192.0.2.50'); codigos.push(x.status); }
  anotar('Límite por IP: el reporte 11 de la misma IP da 429', codigos.slice(0, 10).every(c => c === 201) && codigos[10] === 429, codigos.join(','));

  // 7. Health con la base caída -> 503 (pasados 30 s de caché no se puede esperar acá; se verifica el caché)
  baseCaida = true;
  r = await fetch(API + '/api/health'); j = await r.json();
  anotar('Health reutiliza el resultado durante 30 s (sigue 200 justo después)', r.status === 200, `${r.status} ${JSON.stringify(j)}`);
  baseCaida = false;

  // 7b. Bloqueos (admin): fecha pasada rechazada, hoy y futuro permitidos
  const jwt = require(path.join(carpeta, 'node_modules', 'jsonwebtoken'));
  const token = jwt.sign({ adminId: 'admin' }, 'secreto-de-prueba', { expiresIn: '1h', algorithm: 'HS256' });
  const fechaAsuncion = desplazamiento => {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + desplazamiento); return d.toISOString().slice(0, 10);
  };
  const bloquear = fecha => fetch(API + '/api/bloqueos', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `admin_token=${token}; csrf_token=abc`, 'x-csrf-token': 'abc' },
    body: JSON.stringify({ espacio_id: 3, fecha, hora_inicio: '00:00:00', hora_fin: '23:59:00', motivo: 'prueba' }) });
  r = await bloquear(fechaAsuncion(-1)); j = await r.json();
  anotar('Bloqueo en fecha pasada (ayer): 400', r.status === 400 && j.error === 'No se puede bloquear una fecha que ya pasó', `${r.status} ${JSON.stringify(j)}`);
  r = await bloquear(fechaAsuncion(-200)); j = await r.json();
  anotar('Bloqueo en fecha muy vieja: 400', r.status === 400, `${r.status} ${JSON.stringify(j)}`);
  r = await bloquear(fechaAsuncion(0)); j = await r.json();
  anotar('Bloqueo para hoy: se permite (201)', r.status === 201, `${r.status} ${JSON.stringify(j)}`);
  r = await bloquear(fechaAsuncion(10)); j = await r.json();
  anotar('Bloqueo a futuro: se permite (201)', r.status === 201, `${r.status} ${JSON.stringify(j)}`);
  r = await fetch(API + '/api/bloqueos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ espacio_id: 3, fecha: fechaAsuncion(10), hora_inicio: '00:00:00', hora_fin: '23:59:00' }) });
  anotar('Bloqueo sin sesión de admin: 401', r.status === 401, String(r.status));

  // 8. Otros endpoints públicos siguen respondiendo
  for (const ruta of ['/api/espacios', '/api/reservas', '/api/bloqueos', '/api/meses-habilitados']) {
    r = await fetch(API + ruta);
    anotar(`GET ${ruta} responde 200`, r.status === 200, String(r.status));
  }

  hijo.kill();
  supa.close();
  const avisosDep = salida.split('\n').filter(l => /DeprecationWarning|ExperimentalWarning|EBADENGINE/i.test(l));
  anotar('Sin avisos de funciones obsoletas de Node 24', avisosDep.length === 0, avisosDep.join(' | '));

  for (const x of resultados) console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.detalle ? '  ->  ' + x.detalle : ''}`);
  console.log(`\n${resultados.filter(x => x.ok).length}/${resultados.length} pruebas correctas`);
  fs.unlinkSync(brevoLog);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
