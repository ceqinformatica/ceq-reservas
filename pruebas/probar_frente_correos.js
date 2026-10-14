// Prueba los correos de confirmación (regla de cancelación + Google Calendar) con el server.js real.
// El servidor corre con un reloj falso fijo en el lunes 12/10/2026 10:00 (Paraguay), así la prueba no depende del día real.
// Uso: node probar_frente_correos.js <carpeta con node_modules> <server.js> <interceptar_brevo.js> <reloj_falso.js>
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { filaDesdeRpcReserva, contarCupo } = require(path.join(__dirname, 'mini_postgrest.js'));
const [carpeta, serverOriginal, interceptor, reloj] = process.argv.slice(2);
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-frente-' + Date.now() + '.json');
fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: Date.parse('2026-10-12T13:00:00Z') - Date.now() }));

const codigo = fs.readFileSync(serverOriginal, 'utf8');
// Con el Altillo habilitado, para comprobar también que a él no se le agrega la regla del Frente
const archivoServidor = path.join(carpeta, 'server-correos-prueba.js');
fs.writeFileSync(archivoServidor, codigo); // el Altillo se habilita en la base simulada (espacios.publico)

const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-frente-' + Date.now() + '.log');
fs.writeFileSync(brevoLog, '');
let siguienteId = 700;
const supa = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => cuerpo += c);
  req.on('end', () => {
    const enviar = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url.startsWith('/rest/v1/meses_habilitados')) return enviar(200, [{ habilitado: true }]);
    if (req.url.startsWith('/rest/v1/espacios')) return enviar(200, [{ publico: true }]);
    if (req.url.startsWith('/rest/v1/rpc/crear_reserva_con_cupo') && req.method === 'POST') return enviar(200, [{ id: siguienteId++, ...filaDesdeRpcReserva(JSON.parse(cuerpo)) }]);
    if (req.url.startsWith('/rest/v1/reservas') && req.method === 'POST') return enviar(201, [{ id: siguienteId++, ...JSON.parse(cuerpo)[0] }]);
    return enviar(200, []);
  });
});

const esperar = ms => new Promise(r => setTimeout(r, ms));
const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const hoy = '2026-10-12'; // el "hoy" del reloj falso del servidor
const masDias = n => { const d = new Date(hoy + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const esHabil = f => ![0, 6].includes(new Date(f + 'T00:00:00Z').getUTCDay());
const ddmmaaaa = f => f.split('-').reverse().join('/');

(async () => {
  await new Promise(r => supa.listen(54332, '127.0.0.1', r));
  const hijo = spawn(process.execPath, ['--require', reloj, '--require', interceptor, archivoServidor], { cwd: carpeta,
    env: { ...process.env, PORT: '3997', SUPABASE_URL: 'http://127.0.0.1:54332', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: 'secreto-prueba', ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', EMAILS_SIN_LIMITE: '', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo } });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) { console.log('NO ARRANCÓ:\n' + salida); process.exit(1); }

  let n = 0;
  const reservar = async (espacio, fecha, ini, fin) => {
    n++;
    const r = await fetch('http://127.0.0.1:3997/api/reservas', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${n}` },
      body: JSON.stringify({ espacio_id: espacio, nombre_solicitante: 'Prueba', contacto: `0981 00${n} 000 | persona${n}@ejemplo.com`, fecha, hora_inicio: ini, hora_fin: fin, motivo: 'Actividad Personal' }) });
    await esperar(300);
    const correo = fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(c => c.to.some(t => t.email === `persona${n}@ejemplo.com`));
    return { status: r.status, correo };
  };
  const enlaceCalendario = html => { const m = html.match(/href="(https:\/\/calendar\.google\.com[^"]+)"/); return m ? new URL(m[1].replace(/&amp;/g, '&')) : null; };

  // 1. Frente con más de 2 días de anticipación
  let r = await reservar(3, '2026-10-20', '14:00', '18:00');
  let html = r.correo ? r.correo.htmlContent : '';
  anotar('Frente 20/10: reserva creada y correo enviado', r.status === 201 && !!r.correo, String(r.status));
  anotar('El correo dice hasta cuándo se cancela gratis: 18/10/2026', html.includes('hasta el <strong>18/10/2026</strong> (2 días antes)'));
  anotar('Incluye el enlace de WhatsApp del Frente', html.includes('href="https://wa.me/595972753471"'));
  const url = enlaceCalendario(html);
  anotar('Incluye el botón de Google Calendar', !!url, url && url.origin + url.pathname);
  anotar('Evento: título, día y horario correctos (en hora de Paraguay)', url && url.searchParams.get('text') === 'Reserva del Frente - CEQ' && url.searchParams.get('dates') === '20261020T140000/20261020T180000' && url.searchParams.get('ctz') === 'America/Asuncion',
    url && `${url.searchParams.get('text')} | ${url.searchParams.get('dates')} | ${url.searchParams.get('ctz')}`);
  anotar('El evento incluye el turno y cómo cancelar, pero no el código', url && url.searchParams.get('details').includes('Merienda (14:00 - 18:00)') && url.searchParams.get('details').includes('cancelar.html') && !url.searchParams.get('details').match(/[0-9A-F]{16}/));
  anotar('El enlace está bien escrito dentro del correo (& como &amp;)', /href="https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&amp;text=/.test(html));

  // 2. Frente para mañana y para pasado mañana (si son días hábiles)
  const manana = masDias(1), pasado = masDias(2);
  if (esHabil(manana)) {
    r = await reservar(3, manana, '14:00', '18:00');
    anotar(`Frente para mañana (${ddmmaaaa(manana)}): avisa que ya no se cancela con el código`, r.status === 201 && r.correo.htmlContent.includes('faltan menos de 2 días'), String(r.status));
  }
  if (esHabil(pasado)) {
    r = await reservar(3, pasado, '14:00', '18:00');
    anotar(`Frente para pasado mañana (${ddmmaaaa(pasado)}): se cancela gratis hasta hoy`, r.status === 201 && r.correo.htmlContent.includes(`hasta el <strong>${ddmmaaaa(hoy)}</strong>`), String(r.status));
  }

  // 3. Altillo (si se reactiva): sin la regla del Frente, con Google Calendar
  r = await reservar(1, '2026-10-20', '08:00', '10:00');
  html = r.correo ? r.correo.htmlContent : '';
  const urlAlt = enlaceCalendario(html);
  anotar('Altillo: sin la regla del Frente', r.status === 201 && !html.includes('cancelarla gratis') && !html.includes('faltan menos de 2 días'));
  anotar('Altillo: con Google Calendar de 08:00 a 10:00', urlAlt && urlAlt.searchParams.get('text') === 'Reserva del Altillo - CEQ' && urlAlt.searchParams.get('dates') === '20261020T080000/20261020T100000', urlAlt && urlAlt.searchParams.get('dates'));

  // 4. Reserva de prioridad (panel admin)
  const jwt = require(path.join(carpeta, 'node_modules', 'jsonwebtoken'));
  // Vence según el reloj falso del servidor (no según la hora real)
  const iat = Math.floor(Date.parse('2026-10-12T13:00:00Z') / 1000);
  const token = jwt.sign({ adminId: 'admin', iat, exp: iat + 2 * 3600 }, 'secreto-prueba', { algorithm: 'HS256' });
  const rp = await fetch('http://127.0.0.1:3997/api/admin/reservas', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `admin_token=${token}; csrf_token=abc`, 'x-csrf-token': 'abc' },
    body: JSON.stringify({ espacio_id: 3, nombre_solicitante: 'Comisión', contacto: '0981 999 999 | comision@ejemplo.com', fecha: '2026-10-21', hora_inicio: '07:00', hora_fin: '10:00', motivo: 'Prioridad' }) });
  await esperar(300);
  const cp = fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(c => c.to.some(t => t.email === 'comision@ejemplo.com'));
  const urlP = cp && enlaceCalendario(cp.htmlContent);
  anotar('Prioridad 21/10: correo con regla (hasta el 19/10/2026) y Google Calendar', rp.status === 200 && cp && cp.htmlContent.includes('hasta el <strong>19/10/2026</strong>') && urlP && urlP.searchParams.get('dates') === '20261021T070000/20261021T100000', String(rp.status));

  // 5. El aviso al moderador no cambia
  const aviso = fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(c => c.subject.includes('Nueva Reserva (Frente)'));
  anotar('El aviso al moderador sigue igual (sin regla ni calendario)', aviso && !aviso.htmlContent.includes('calendar.google.com') && !aviso.htmlContent.includes('cancelarla gratis'));

  hijo.kill(); supa.close(); fs.unlinkSync(brevoLog); fs.unlinkSync(archivoServidor); fs.unlinkSync(relojArchivo);
  for (const x of resultados) console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.detalle ? '  ->  ' + x.detalle : ''}`);
  console.log(`\n${resultados.filter(x => x.ok).length}/${resultados.length} pruebas correctas`);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
