// Prueba el server.js real (Node 24) con el Altillo habilitado: Supabase simulado, Brevo interceptado
// y el reloj del servidor puesto el martes 20/10/2026 a las 11:30 de Asunción.
// Cubre: horario del Altillo 07-19 con máximo 2 horas, bloque en curso, motivos del Frente y acompañantes.
// Uso: node probar_altillo_servidor.js <carpeta con node_modules> <server.js> <interceptar_brevo.js> <reloj_falso.js>
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { filaDesdeRpcReserva, contarCupo } = require(path.join(__dirname, 'mini_postgrest.js'));
const [carpeta, serverOriginal, interceptor, reloj] = process.argv.slice(2);

const archivoServidor = path.join(carpeta, 'server-altillo-prueba.js');
fs.writeFileSync(archivoServidor, fs.readFileSync(serverOriginal, 'utf8'));

const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-altillo-' + Date.now() + '.log');
fs.writeFileSync(brevoLog, '');
// 20/10/2026 11:30 en Asunción (UTC-3) = 14:30 UTC
const archivoReloj = path.join(os.tmpdir(), 'ceq-reloj-altillo-' + Date.now() + '.json');
fs.writeFileSync(archivoReloj, JSON.stringify({ desfase_ms: Date.parse('2026-10-20T14:30:00Z') - Date.now() }));
const HOY = '2026-10-20';
const OTRO_DIA = '2026-10-22';

let siguienteId = 500;
const insertados = [];
const pedidos = [];
const supa = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => cuerpo += c);
  req.on('end', () => {
    pedidos.push(req.method + ' ' + decodeURIComponent(req.url));
    const enviar = (status, datos) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(datos)); };
    if (req.url.startsWith('/rest/v1/meses_habilitados')) return enviar(200, [{ habilitado: true }]);
    if (req.url.startsWith('/rest/v1/espacios')) {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      return enviar(200, [{ publico: id !== 'eq.2' }]);
    }
    // Las reservas públicas se guardan con la función crear_reserva_con_cupo de la base
    if (req.url.startsWith('/rest/v1/rpc/crear_reserva_con_cupo') && req.method === 'POST') {
      const args = JSON.parse(cuerpo);
      const fila = filaDesdeRpcReserva(args);
      insertados.push({ ...fila, limite: args.p_limite });
      return enviar(200, [{ id: siguienteId++, ...fila }]);
    }
    if (req.url.startsWith('/rest/v1/reservas') && req.method === 'POST') {
      const fila = JSON.parse(cuerpo)[0];
      insertados.push(fila);
      return enviar(201, [{ id: siguienteId++, ...fila }]);
    }
    return enviar(200, []);
  });
});

const esperar = ms => new Promise(r => setTimeout(r, ms));
const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });

(async () => {
  await new Promise(r => supa.listen(54331, '127.0.0.1', r));
  const hijo = spawn(process.execPath, ['--require', reloj, '--require', interceptor, archivoServidor], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3998', SUPABASE_URL: 'http://127.0.0.1:54331', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: 'x', ADMIN_PASSWORD_HASH: 'x',
      EMAIL_MODERADOR: '', EMAIL_MODERADOR_FRENTE: 'frente@ejemplo.com', EMAILS_SIN_LIMITE: '', BREVO_LOG: brevoLog, RELOJ_FALSO: archivoReloj, INTERVALO_TAREAS_MS: '3600000' }
  });
  let salida = '';
  hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) { console.log('NO ARRANCÓ:\n' + salida); process.exit(1); }

  let n = 1;
  const reservar = async (espacio, ini, fin, extra = {}) => {
    n++;
    const cuerpo = { espacio_id: espacio, nombre_solicitante: 'Prueba', contacto: `0981 00${n} 000 | persona${n}@ejemplo.com`, fecha: OTRO_DIA,
      hora_inicio: ini, hora_fin: fin, motivo: espacio === 3 ? 'Actividad Personal' : 'Estudiar', ...extra };
    const r = await fetch('http://127.0.0.1:3998/api/reservas', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${n}` }, body: JSON.stringify(cuerpo) });
    return { status: r.status, cuerpo: await r.json() };
  };
  const emails = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const ok201 = r => r.status === 201;
  const err = (r, texto) => r.status === 400 && String(r.cuerpo.error).includes(texto);
  const det = r => `${r.status} ${r.cuerpo.error || ''}`;

  // --- /api/configuracion publica lo que necesita la página ---
  const conf = await (await fetch('http://127.0.0.1:3998/api/configuracion')).json();
  anotar('Configuración: 5 motivos del Frente', Array.isArray(conf.motivos_frente) && conf.motivos_frente.length === 5 && conf.motivos_frente[0] === 'Actividad Personal', JSON.stringify(conf.motivos_frente));
  anotar('Configuración: Altillo 07-19, máximo 2 horas', conf.altillo && conf.altillo.hora_desde === 7 && conf.altillo.hora_hasta === 19 && conf.altillo.max_horas === 2, JSON.stringify(conf.altillo));
  anotar('Configuración: hasta 4 acompañantes', conf.max_acompanantes === 4);

  // --- Altillo: horario y duración ---
  let r = await reservar(1, '08:00', '09:00'); await esperar(300);
  anotar('Altillo 1 hora (08-09): aceptada', ok201(r) && insertados.at(-1)?.espacio_id === 1, det(r));
  const aUsuario = emails().find(c => c.to.some(t => t.email.startsWith('persona')));
  anotar('Confirmación al usuario con el horario del Altillo', aUsuario && aUsuario.htmlContent.includes('08:00 - 09:00'));
  anotar('Sin acompañantes: el correo no muestra la línea', aUsuario && !aUsuario.htmlContent.includes('Acompañantes'));
  anotar('Sin acompañantes: se guarda la lista vacía', Array.isArray(insertados.at(-1).acompanantes) && insertados.at(-1).acompanantes.length === 0);
  r = await reservar(1, '10:00', '12:00'); anotar('Altillo 2 horas: aceptada', ok201(r), det(r));
  r = await reservar(1, '18:00', '19:00'); anotar('Altillo 18:00-19:00: aceptada (nuevo)', ok201(r), det(r));
  r = await reservar(1, '17:00', '19:00', { fecha: OTRO_DIA }); anotar('Altillo 17:00-19:00 (último bloque de 2 horas): aceptada', ok201(r), det(r));
  r = await reservar(1, '19:00', '20:00'); anotar('Altillo 19:00-20:00: rechazada (cierra a las 19:00)', err(r, 'fuera de rango'), det(r));
  r = await reservar(1, '18:00', '20:00'); anotar('Altillo 18:00-20:00: rechazada', err(r, 'fuera de rango'), det(r));
  r = await reservar(1, '08:00', '11:00'); anotar('Altillo 3 horas: rechazada', err(r, 'entre 1 y 2 horas'), det(r));
  r = await reservar(1, '08:30', '09:00'); anotar('Altillo 30 minutos: rechazada', err(r, 'horas completas'), det(r));
  r = await reservar(1, '08:30', '10:00'); anotar('Altillo 08:30-10:00 (no es hora completa): rechazada', err(r, 'horas completas'), det(r));
  r = await reservar(1, '09:00', '10:30'); anotar('Altillo 09:00-10:30 (no es hora completa): rechazada', err(r, 'horas completas'), det(r));
  r = await reservar(1, '07:00', '08:00'); anotar('Altillo 07:00-08:00 (primer bloque): aceptada', ok201(r), det(r));
  r = await reservar(1, '06:00', '07:00'); anotar('Altillo antes de las 07:00: rechazada', err(r, 'fuera de rango'), det(r));

  // --- Altillo hoy a las 11:30: el bloque en curso todavía se puede tomar ---
  r = await reservar(1, '11:00', '13:00', { fecha: HOY }); anotar('Hoy 11:30: 11:00-13:00 aceptada (el bloque de 11 no terminó)', ok201(r), det(r));
  r = await reservar(1, '11:00', '12:00', { fecha: HOY }); anotar('Hoy 11:30: 11:00-12:00 aceptada', ok201(r), det(r));
  r = await reservar(1, '10:00', '12:00', { fecha: HOY }); anotar('Hoy 11:30: 10:00-12:00 rechazada (el bloque de 10 ya terminó)', err(r, 'ya pasó'), det(r));
  r = await reservar(1, '12:00', '13:00', { fecha: HOY }); anotar('Hoy 11:30: 12:00-13:00 aceptada', ok201(r), det(r));
  fs.writeFileSync(archivoReloj, JSON.stringify({ desfase_ms: Date.parse('2026-10-20T15:00:00Z') - Date.now() })); await esperar(100);
  r = await reservar(1, '11:00', '12:00', { fecha: HOY }); anotar('Hoy 12:00: 11:00-12:00 rechazada (ya terminó)', err(r, 'ya pasó'), det(r));
  r = await reservar(1, '12:00', '14:00', { fecha: HOY }); anotar('Hoy 12:00: 12:00-14:00 aceptada', ok201(r), det(r));
  // El Frente no cambia: a las 12:00 el Almuerzo (10-13) ya empezó y no se puede
  r = await reservar(3, '10:00', '13:00', { fecha: HOY }); anotar('Frente hoy 12:00: Almuerzo ya empezado, rechazado', err(r, 'ya pasó'), det(r));
  r = await reservar(3, '14:00', '18:00', { fecha: HOY }); anotar('Frente hoy 12:00: Merienda aceptada', ok201(r), det(r));

  // --- Motivos del Frente ---
  for (const motivo of conf.motivos_frente) {
    r = await reservar(3, '07:00', '10:00', { motivo });
    anotar(`Frente con motivo "${motivo}": aceptada`, ok201(r) && insertados.at(-1).motivo === motivo, det(r));
  }
  r = await reservar(3, '07:00', '10:00', { motivo: 'Cumpleaños' }); anotar('Frente con motivo libre: rechazado', err(r, 'Elegí el motivo de la lista'), det(r));
  r = await reservar(3, '07:00', '10:00', { motivo: '' }); anotar('Frente sin motivo: rechazado', r.status === 400, det(r));
  r = await reservar(3, '07:00', '10:00', { motivo: '  Actividad Personal ' }); anotar('Frente motivo con espacios de más: aceptado y limpio', ok201(r) && insertados.at(-1).motivo === 'Actividad Personal', det(r));
  r = await reservar(1, '08:00', '09:00', { motivo: 'Reunión de estudio de Orgánica' }); anotar('Altillo sigue con motivo libre', ok201(r), det(r));

  // --- Acompañantes ---
  const cuatro = [
    { nombre: 'Ana Pérez', celular: '0981 111 222' }, { nombre: 'Luis Gómez', celular: '0982 333 444' },
    { nombre: 'Sofía Benítez', celular: '+595 983 555 666' }, { nombre: 'Marco <b>Ruiz</b>', celular: '0984-777-888' }
  ];
  r = await reservar(1, '08:00', '10:00', { acompanantes: cuatro }); await esperar(300);
  anotar('4 acompañantes: aceptada y guardados', ok201(r) && JSON.stringify(insertados.at(-1).acompanantes) === JSON.stringify(cuatro), det(r));
  const ultimos = emails().slice(-3);
  const correoUsuario = ultimos.find(c => c.to.some(t => t.email.startsWith('persona')));
  const correoModerador = ultimos.findLast(c => c.subject.includes('Nueva Reserva (Altillo)'));
  anotar('Correo al usuario lista los acompañantes', correoUsuario && correoUsuario.htmlContent.includes('Ana Pérez (0981 111 222)') && correoUsuario.htmlContent.includes('Luis Gómez'));
  anotar('Correo al moderador lista los acompañantes', correoModerador && correoModerador.htmlContent.includes('Sofía Benítez (+595 983 555 666)'), ultimos.map(c => c.subject + ' -> ' + c.to.map(t => t.email) + ' :: ' + (c.htmlContent.match(/Acompa[^<]*<\/strong>[^<]*/) || [''])[0]).join(' || '));
  anotar('El nombre con HTML se escapa en el correo', correoUsuario && correoUsuario.htmlContent.includes('Marco &lt;b&gt;Ruiz&lt;/b&gt;') && !correoUsuario.htmlContent.includes('<b>Ruiz'));
  r = await reservar(1, '08:00', '09:00', { acompanantes: [{ nombre: '  Ana  ', celular: ' 0981111222 ' }] });
  anotar('1 acompañante en el Altillo: aceptada y sin espacios de más', ok201(r) && insertados.at(-1).acompanantes[0].nombre === 'Ana' && insertados.at(-1).acompanantes[0].celular === '0981111222', det(r));
  r = await reservar(1, '08:00', '10:00', { acompanantes: [...cuatro, { nombre: 'Quinto', celular: '0985 000 000' }] });
  anotar('5 acompañantes: rechazada', err(r, 'hasta 4 acompañantes'), det(r));
  r = await reservar(1, '08:00', '10:00', { acompanantes: [{ nombre: 'Ana', celular: '' }] }); anotar('Acompañante sin celular: rechazada', err(r, 'celular válido para el acompañante 1'), det(r));
  r = await reservar(1, '08:00', '10:00', { acompanantes: [{ nombre: 'Ana', celular: '0981 111 222' }, { nombre: '', celular: '0981 111 222' }] });
  anotar('Acompañante 2 sin nombre: rechazada', err(r, 'nombre del acompañante 2'), det(r));
  r = await reservar(1, '08:00', '10:00', { acompanantes: [{ nombre: 'Ana', celular: 'abc' }] }); anotar('Celular sin números: rechazada', err(r, 'celular válido'), det(r));
  r = await reservar(1, '08:00', '10:00', { acompanantes: [{ nombre: 'Ana', celular: '0981 111 222 333 444 555 666 777 888' }] }); anotar('Celular de más de 30 caracteres: rechazada', err(r, 'celular válido'), det(r));
  r = await reservar(1, '08:00', '10:00', { acompanantes: 'Ana' }); anotar('Acompañantes que no son lista: rechazada', err(r, 'hasta 4 acompañantes'), det(r));
  r = await reservar(1, '08:00', '10:00', { acompanantes: [] }); anotar('Lista vacía: aceptada', ok201(r), det(r));

  r = await reservar(3, '07:00', '10:00', { acompanantes: [{ nombre: 'Ana Pérez', celular: '0981 111 222' }] }); anotar('Frente con acompañantes: rechazada', err(r, 'solo en las reservas del Altillo'), det(r));
  r = await reservar(3, '07:00', '10:00', { acompanantes: [] }); anotar('Frente sin acompañantes (lista vacía): aceptada', ok201(r) && insertados.at(-1).acompanantes.length === 0, det(r));

  // --- Lo demás sigue igual ---
  r = await reservar(3, '08:00', '11:00'); anotar('El Frente sigue rechazando horarios que no son turnos', r.status === 400, det(r));
  r = await reservar(2, '08:00', '09:00'); anotar('La Sala de Reuniones sigue cerrada', r.status === 400 && r.cuerpo.error === 'Ese espacio no se puede reservar por el momento', det(r));

  // --- El listado público no muestra acompañantes ---
  const antes = pedidos.length;
  const rp = await fetch('http://127.0.0.1:3998/api/reservas');
  const lecturas = pedidos.slice(antes).filter(p => p.startsWith('GET /rest/v1/reservas'));
  anotar('El listado público no pide acompañantes a la base', rp.ok && lecturas.length > 0 && lecturas.every(p => p.includes('select=') && !p.includes('acompanantes') && !p.includes('select=*')), lecturas.join(' | '));

  hijo.kill(); supa.close(); fs.unlinkSync(brevoLog); fs.unlinkSync(archivoServidor); fs.unlinkSync(archivoReloj);
  for (const x of resultados) console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.detalle && !x.ok ? '  ->  ' + x.detalle : ''}`);
  console.log(`\n${resultados.filter(x => x.ok).length}/${resultados.length} pruebas correctas`);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
