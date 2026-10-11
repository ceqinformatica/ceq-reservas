// Prueba la sincronización con Google Sheets de punta a punta (sin Google ni Supabase reales):
//  A) server.js real (Node 24) contra un mini PostgREST con 2500 reservas que, como Supabase,
//     corta en 1000 filas por pedido: ruta /api/sincronizacion/reservas y /api/admin/reservas.
//  B) el script de Apps Script real (sincronizar-reservas.gs) corriendo en Node con un simulador
//     de las partes de Google que usa, alimentado con la respuesta real del servidor.
// Uso: node probar_sincronizacion.js <carpeta server+node_modules> <interceptar_brevo.js> <sincronizar-reservas.gs>
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawn } = require('child_process');

const [carpeta, interceptor, archivoGs] = process.argv.slice(2);
const jwt = require(path.join(carpeta, 'node_modules', 'jsonwebtoken'));
const CLAVE = 'clave-de-sincronizacion-de-prueba-0123456789abcdef'; // 50 caracteres
const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));

// ---------- Datos: 2500 reservas ----------
const reservas = [];
const turnos = [['07:00:00', '10:00:00'], ['10:00:00', '13:00:00'], ['14:00:00', '18:00:00']];
for (let i = 1; i <= 2500; i++) {
  const dia = new Date(Date.UTC(2026, 6, 1) + Math.floor((i - 1) / 4) * 86400000).toISOString().slice(0, 10);
  const altillo = i % 4 === 3;
  const [hi, hf] = altillo ? ['08:00:00', '10:00:00'] : turnos[i % 3];
  const cancelada = i % 5 === 0;
  reservas.push({
    id: 5000 - i, // ids desordenados respecto de la fecha, para probar el orden
    espacio_id: altillo ? 1 : 3, fecha: dia, hora_inicio: hi, hora_fin: hf,
    nombre_solicitante: i === 7 ? '=HYPERLINK("http://malo")' : `Persona ${i}`,
    contacto: i === 8 ? '0981123456' : `09810000${String(i).padStart(2, '0')} | persona${i % 300}@example.com`,
    motivo: i === 9 ? '+595 llamada' : 'Estudio', estado: cancelada ? 'cancelada' : 'activa',
    codigo_cancelacion_hash: 'secreto' + i, codigo_cancelacion: null,
    reservado_por_admin: i % 50 === 0,
    created_at: '2026-06-30T23:30:00.123456', updated_at: '2026-06-30T23:30:00',
    cancelada_en: cancelada && i % 10 === 0 ? '2026-07-01T02:15:00+00:00' : null,
    cancelada_por: cancelada && i % 10 === 0 ? 'usuario' : null,
    motivo_cancelacion: cancelada && i % 10 === 0 ? 'No puedo ir' : null,
    asistencia: !cancelada && i % 7 === 0 ? (i % 14 === 0 ? 'no_vino' : 'vino') : null,
    acompanantes: i === 12 ? [{ nombre: 'Ana Pérez', celular: '0981 111 222' }, { nombre: 'Luis', celular: '0982 333 444' }] : []
  });
}
const db = { reservas, configuracion: [{ clave: 'version_sesiones', valor: '1' }], registro_actividad: [], espacios: [], meses_habilitados: [], bloqueos: [], reportes_errores: [] };

// ---------- Mini PostgREST (como Supabase: máximo 1000 filas por respuesta) ----------
const pedidos = [];
function cumple(f, col, expr) {
  const m = expr.match(/^(eq|neq|in|is|gte|lte)\.(.*)$/s);
  if (!m) throw new Error('filtro no soportado ' + col + '=' + expr);
  const v = String(f[col]);
  if (m[1] === 'eq') return v === m[2]; if (m[1] === 'neq') return v !== m[2];
  if (m[1] === 'in') return m[2].replace(/^\(|\)$/g, '').split(',').includes(v);
  if (m[1] === 'is') return m[2] === 'null' ? f[col] == null : v === m[2];
  if (m[1] === 'gte') return v >= m[2]; return v <= m[2];
}
const supa = http.createServer((rq, rs) => {
  let cuerpo = ''; rq.on('data', c => cuerpo += c);
  rq.on('end', () => {
    const url = new URL(rq.url, 'http://x'); const tabla = url.pathname.replace('/rest/v1/', ''); const p = url.searchParams;
    pedidos.push(`${rq.method} ${tabla} ${p.toString()}`);
    const enviar = (s, d) => { rs.writeHead(s, { 'content-type': 'application/json' }); rs.end(d === undefined ? '' : JSON.stringify(d)); };
    if (!db[tabla]) return enviar(404, { message: 'no existe' });
    if (rq.method === 'POST') { db[tabla].push(JSON.parse(cuerpo)); return enviar(201); }
    let filas = db[tabla].filter(f => [...p].every(([k, v]) => ['select', 'order', 'limit', 'offset'].includes(k) || cumple(f, k, v)));
    if (p.get('order')) {
      const criterios = p.get('order').split(',').map(o => o.split('.'));
      filas = [...filas].sort((a, b) => { for (const [c, dir] of criterios) { if (a[c] !== b[c]) return (a[c] > b[c] ? 1 : -1) * (dir === 'desc' ? -1 : 1); } return 0; });
    }
    const offset = Number(p.get('offset') || 0);
    const limite = Math.min(Number(p.get('limit') || 1000), 1000); // tope de Supabase
    filas = filas.slice(offset, offset + limite);
    const sel = p.get('select');
    if (sel && sel !== '*') filas = filas.map(f => Object.fromEntries(sel.split(',').map(c => [c, f[c] ?? null])));
    enviar(200, filas);
  });
});

async function arrancar(env, puerto) {
  const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-sinc.log'); fs.writeFileSync(brevoLog, '');
  const hijo = spawn(process.execPath, ['--require', interceptor, path.join(carpeta, 'server.js')], {
    cwd: carpeta, env: { ...process.env, PORT: String(puerto), SUPABASE_URL: 'http://127.0.0.1:54326', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x',
      JWT_SECRET: 'secreto', ADMIN_PASSWORD_HASH: 'x', BREVO_LOG: brevoLog, NODE_OPTIONS: '', ...env } });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Sincronización con Google Sheets'); i++) await esperar(100);
  hijo.salida = () => salida;
  return hijo;
}

(async () => {
  await new Promise(r => supa.listen(54326, '127.0.0.1', r));
  let hijo = await arrancar({ CLAVE_SINCRONIZACION: CLAVE }, 3996);
  const API = 'http://127.0.0.1:3996';
  anotar('Al arrancar, el log dice "Sincronización con Google Sheets: activada"', hijo.salida().includes('Sincronización con Google Sheets: activada'), hijo.salida().split('\n').slice(0, 3).join(' | '));

  const pedir = (clave, ip = '198.51.100.1') => fetch(API + '/api/sincronizacion/reservas', { headers: { ...(clave !== undefined ? { 'x-clave-sincronizacion': clave } : {}), 'cf-connecting-ip': ip } });
  let r = await pedir(undefined); let j = await r.json();
  anotar('Sin clave: 401', r.status === 401 && j.error === 'Clave de sincronización inválida', `${r.status} ${JSON.stringify(j)}`);
  r = await pedir('otra-clave'); anotar('Clave equivocada: 401', r.status === 401, String(r.status));
  r = await pedir(CLAVE.slice(0, -1)); anotar('Clave casi igual (le falta 1 caracter): 401', r.status === 401, String(r.status));
  r = await pedir(CLAVE.toUpperCase()); anotar('Clave en mayúsculas: 401', r.status === 401, String(r.status));
  r = await fetch(API + '/api/sincronizacion/reservas?clave=' + CLAVE); anotar('Clave en la dirección (no en el header): 401', r.status === 401, String(r.status));
  anotar('Los rechazos quedan en el log de Render', (hijo.salida().match(/Sincronización rechazada/g) || []).length >= 4);

  pedidos.length = 0;
  r = await pedir(CLAVE); const datos = await r.json();
  anotar('Con la clave correcta: 200 y Cache-Control no-store', r.status === 200 && r.headers.get('cache-control') === 'no-store', `${r.status} ${r.headers.get('cache-control')}`);
  anotar('Trae las 2500 reservas aunque Supabase corte en 1000 (3 pedidos de a 1000)', datos.total === 2500 && datos.reservas.length === 2500 && pedidos.filter(x => x.startsWith('GET reservas')).length === 3, `${datos.total} ${datos.reservas.length} pedidos=${pedidos.filter(x => x.startsWith('GET reservas')).length}`);
  const ordenOk = datos.reservas.every((x, i, a) => i === 0 || (a[i - 1].fecha + a[i - 1].hora_inicio + String(a[i - 1].id).padStart(6, '0')) <= (x.fecha + x.hora_inicio + String(x.id).padStart(6, '0')));
  anotar('Ordenadas por fecha y hora', ordenOk);
  anotar('Sin repetidas ni faltantes entre páginas', new Set(datos.reservas.map(x => x.id)).size === 2500);
  const una = datos.reservas.find(x => x.nombre === 'Persona 10');
  anotar('Campos: espacio, turno, horas HH:MM, nombre, motivo y estado', una && una.espacio === 'Frente' && una.turno === 'Almuerzo' && una.hora_inicio === '10:00' && una.hora_fin === '13:00' && una.nombre === 'Persona 10' && una.estado === 'cancelada', JSON.stringify(una));
  const texto = JSON.stringify(datos);
  const camposProhibidos = ['celular', 'email', 'contacto', 'prioridad', 'cancelada_en', 'cancelada_por', 'motivo_cancelacion'];
  anotar('NO manda celulares, correos, prioridad ni datos de cancelación', datos.reservas.every(x => camposProhibidos.every(c => !(c in x))) && !texto.includes('@example.com') && !texto.includes('0981000010') && !texto.includes('No puedo ir'), Object.keys(una).join(','));
  const p12 = datos.reservas.find(x => x.nombre === 'Persona 12');
  anotar('Acompañantes: solo los nombres, sin celular', p12 && p12.acompanantes === 'Ana Pérez, Luis' && una.acompanantes === '' && !texto.includes('0981 111 222'), p12 && JSON.stringify(p12.acompanantes));
  // Código anónimo de persona: mismo correo = mismo código; sin contacto = vacío; no contiene el dato
  const identidad = c => { const [cel = '', em = ''] = String(c || '').split('|').map(p => p.trim()); return em.toLowerCase() || cel.replace(/\D/g, ''); };
  const porId = Object.fromEntries(datos.reservas.map(x => [x.id, x.persona]));
  const grupos = {};
  reservas.forEach(x => { const k = identidad(x.contacto); (grupos[k] = grupos[k] || new Set()).add(porId[x.id]); });
  const codigosPersona = new Set(Object.values(porId));
  anotar('Código de persona: uno por persona, distinto entre personas, de 12 caracteres', Object.values(grupos).every(s => s.size === 1) && codigosPersona.size === Object.keys(grupos).length && [...codigosPersona].every(c => /^[A-Za-z0-9_-]{12}$/.test(c)), `personas=${Object.keys(grupos).length} codigos=${codigosPersona.size}`);
  anotar('created_at sin zona se toma como UTC', una.creada_en === '2026-06-30T23:30:00.123Z', una.creada_en);
  const alt = datos.reservas.find(x => x.espacio === 'Altillo');
  anotar('Altillo: sin nombre de turno', alt.turno === '' && alt.hora_inicio === '08:00', JSON.stringify(alt));
  const sinBarra = datos.reservas.find(x => x.nombre === 'Persona 8');
  anotar('Contacto sin "|" (solo celular): igual tiene código de persona (no se rompe)', /^[A-Za-z0-9_-]{12}$/.test(sinBarra.persona), JSON.stringify(sinBarra));
  anotar('NO manda el código de cancelación', !JSON.stringify(datos).includes('secreto') && !('codigo_cancelacion_hash' in datos.reservas[0]));

  const tokenAdmin = jwt.sign({ adminId: 'admin', rol: 'admin', v: 1 }, 'secreto', { expiresIn: '1h', algorithm: 'HS256' });
  r = await fetch(API + '/api/admin/reservas', { headers: { cookie: `admin_token=${tokenAdmin}` } }); j = await r.json();
  anotar('Panel (/api/admin/reservas): ahora trae las 2500, no solo 1000', r.status === 200 && j.length === 2500 && new Set(j.map(x => x.id)).size === 2500, `${r.status} ${j.length}`);
  anotar('Panel: del más nuevo al más viejo', j[0].fecha >= j[j.length - 1].fecha);

  const codigos = [];
  for (let i = 0; i < 31; i++) codigos.push((await pedir(CLAVE, '198.51.100.77')).status);
  anotar('Límite: 30 por hora por IP, el 31 da 429', codigos.slice(0, 30).every(c => c === 200) && codigos[30] === 429, codigos.slice(-3).join(','));
  hijo.kill(); await esperar(300);

  for (const [env, nombre] of [[{}, 'sin la variable'], [{ CLAVE_SINCRONIZACION: 'corta' }, 'con una clave de menos de 32 caracteres']]) {
    hijo = await arrancar(env, 3995);
    r = await fetch('http://127.0.0.1:3995/api/sincronizacion/reservas', { headers: { 'x-clave-sincronizacion': env.CLAVE_SINCRONIZACION || '' } });
    anotar(`Servidor ${nombre}: la ruta queda apagada (503) y el log lo dice`, r.status === 503 && hijo.salida().includes('desactivada'), `${r.status}`);
    hijo.kill(); await esperar(300);
  }
  supa.close();

  // ===== B) Apps Script con Google simulado =====
  const g = crearGoogleSimulado(datos);
  const contexto = vm.createContext({ ...g.globales, console, Date, JSON, Math, Array, Object, String, Number, Set, Error });
  vm.runInContext(fs.readFileSync(archivoGs, 'utf8'), contexto, { filename: 'sincronizar-reservas.gs' });

  g.propiedades.CLAVE_SINCRONIZACION = undefined;
  let error = null; try { contexto.sincronizar(); } catch (e) { error = e.message; }
  anotar('Script sin clave guardada: error claro', /Falta guardar la clave/.test(error || ''), error);

  g.propiedades.CLAVE_SINCRONIZACION = CLAVE;
  const total = contexto.sincronizar();
  const hoja = g.ss.getSheetByName('Reservas');
  const celdas = hoja._celdas;
  const ENCABEZADO = 'N°,Fecha,Día,Espacio,Turno,Inicio,Fin,Nombre,Motivo,Acompañantes,Estado,Asistencia,Creada';
  anotar('Script: escribe las 2500 reservas + encabezado con solo las 13 columnas pedidas', total === 2500 && celdas.length === 2501 && celdas[0].join(',') === ENCABEZADO, `${total} filas=${celdas.length} ${celdas[0].join(',')}`);
  anotar('La planilla queda en hora de Asunción', g.ss._zona === 'America/Asuncion');
  const filaP10 = celdas.find(f => f[7] === "'Persona 10");
  anotar('Fecha como fecha real (medianoche de Asunción) y día de la semana', filaP10 && filaP10[1] instanceof Date && filaP10[1].toISOString() === una.fecha + 'T03:00:00.000Z' && filaP10[2] === ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][new Date(una.fecha + 'T12:00:00Z').getUTCDay()], filaP10 && String(filaP10[1].toISOString()));
  anotar('Creada como fecha y hora; estado Cancelada', filaP10[12] instanceof Date && filaP10[12].toISOString() === '2026-06-30T23:30:00.123Z' && filaP10[10] === 'Cancelada', `${filaP10[12]} ${filaP10[10]}`);
  const malicioso = celdas.find(f => String(f[7]).includes('HYPERLINK'));
  anotar('Un nombre que empieza con "=" se escribe como texto, no como fórmula', malicioso[7] === "'=HYPERLINK(\"http://malo\")", malicioso[7]);
  anotar('Un motivo "+595..." no se toma como número', celdas.some(f => f[8] === "'+595 llamada"));
  anotar('Ninguna celda tiene correos ni celulares', !celdas.some(f => f.some(x => /@example\.com|0981000010|0981 111 222/.test(String(x)))));
  anotar('Encabezado fijo, con filtro y formatos de fecha', hoja._congeladas === 1 && hoja._filtro === 'A1:M2501' && hoja._formatos['B'] === 'dd/mm/yyyy' && hoja._formatos['M'] === 'dd/mm/yyyy hh:mm', `${hoja._congeladas} ${hoja._filtro} ${JSON.stringify(hoja._formatos)}`);

  const res = g.ss.getSheetByName('Resumen')._celdas;
  const buscar = etiqueta => res.find(f => f && f[0] === etiqueta);
  const activas = datos.reservas.filter(x => x.estado === 'activa').length;
  anotar('Resumen: estado OK y total por espacio coincide', /^OK: 2500 reservas/.test(res[2][1]) && buscar('Total')[1] === activas && buscar('Total')[3] === 2500, `${res[2][1]} ${JSON.stringify(buscar('Total'))}`);
  const turnosSuma = ['Desayuno', 'Almuerzo', 'Merienda'].reduce((s, t) => s + buscar(t)[1], 0);
  anotar('Resumen: turnos del Frente suman las activas del Frente', turnosSuma === buscar('Frente')[1], `${turnosSuma} vs ${buscar('Frente')[1]}`);
  const diasSuma = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'].reduce((s, d) => s + buscar(d)[1], 0);
  anotar('Resumen: días de la semana (lun-vie) contados', diasSuma === datos.reservas.filter(x => x.estado === 'activa' && ![0, 6].includes(new Date(x.fecha + 'T12:00:00Z').getUTCDay())).length, String(diasSuma));
  const activasIds = new Set(datos.reservas.filter(x => x.estado === 'activa').map(x => x.id));
  const personasEsperadas = new Set(reservas.filter(x => activasIds.has(x.id)).map(x => identidad(x.contacto)).filter(Boolean)).size;
  anotar(`Resumen: meses con nombre ("Julio 2026") y personas distintas (${personasEsperadas})`, !!buscar("'Julio 2026") && filaP10[5] === "'10:00" && /^'\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(res[1][1]) && buscar('Personas distintas con reservas activas')[1] === personasEsperadas, JSON.stringify(buscar('Personas distintas con reservas activas')));
  const vinieron = datos.reservas.filter(q => q.estado === 'activa' && q.asistencia === 'vino').length;
  const noVinieron = datos.reservas.filter(q => q.estado === 'activa' && q.asistencia === 'no_vino').length;
  anotar(`Columna Asistencia (Vino/No vino) y totales en el Resumen (${vinieron} / ${noVinieron})`, celdas.filter(f => f[11] === 'Vino').length === vinieron && celdas.filter(f => f[11] === 'No vino').length === noVinieron && buscar('Asistencia marcada: vinieron')[1] === vinieron && buscar('Asistencia marcada: no vinieron')[1] === noVinieron && vinieron > 0, `${celdas.filter(f => f[11] === 'Vino').length}`);
  const filaP12 = celdas.find(f => f[7] === "'Persona 12");
  anotar('Columna Acompañantes: solo nombres separados por coma, vacía si no hay', filaP12 && filaP12[9] === "'Ana Pérez, Luis" && filaP10[9] === '', filaP12 && String(filaP12[9]));
  anotar('El Resumen ya no tiene "Reservas de prioridad"', !buscar('Reservas de prioridad (activas)'));

  // Una copia guardada con la versión anterior (con celular, email, etc.) se limpia sola
  const vieja = g.ss._agregar('Copia 2026-09');
  vieja._celdas = [
    ['N°', 'Fecha', 'Día', 'Espacio', 'Turno', 'Inicio', 'Fin', 'Nombre', 'Celular', 'Email', 'Motivo', 'Acompañantes', 'Estado', 'Prioridad', 'Asistencia', 'Creada', 'Cancelada', 'Cancelada por', 'Motivo de cancelación'],
    [1, 'f', 'Lunes', 'Altillo', '-', "'08:00", "'10:00", "'Juan", "'0981222333", "'juan@example.com", "'Estudio", 'Ana Pérez (0981 111 222), Luis (0982 333 444)' /* Google devuelve el valor sin la comilla */, 'Cancelada', 'No', '', 'c', 'x', 'usuario', "'No puedo"],
    [2, 'f', 'Martes', 'Frente', 'Desayuno', "'07:00", "'10:00", "'Rosa", "'0981444555", "'rosa@example.com", "'Actividad Personal", '', 'Activa', 'Sí', 'Vino', 'c', '', '', '']
  ];
  contexto.sincronizar();
  const limpia = g.ss.getSheetByName('Copia 2026-09')._celdas;
  anotar('Copia vieja: se borran Celular, Email, Prioridad y las 3 de cancelación, y los acompañantes quedan sin celular',
    limpia[0].join(',') === ENCABEZADO && limpia[1][9] === "'Ana Pérez, Luis" && limpia[2][9] === '' && limpia[1][7] === "'Juan" && limpia[2][11] === 'Vino' && !limpia.some(f => f.some(x => /@example|0981/.test(String(x)))),
    limpia.map(f => f.join('|')).join(' // '));
  g.ss.deleteSheet(g.ss.getSheetByName('Copia 2026-09'));
  const nombresHojas = () => g.ss.getSheets().map(h => h.getName());
  const MESES_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const nombreMes = clave => `${MESES_ES[Number(clave.slice(5, 7)) - 1]} ${clave.slice(0, 4)}`;
  const mesesDatos = () => [...new Set(datos.reservas.map(x => x.fecha.slice(0, 7)))].sort().reverse();
  const copiaNombre = `Copia ${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion' }).format(new Date()).slice(0, 7)}`;
  const ordenEsperado = () => ['Resumen', 'Reservas', ...mesesDatos().map(nombreMes), copiaNombre].join(',');
  anotar(`Pestañas: Resumen, Reservas, un mes por pestaña del más nuevo al más viejo (${mesesDatos().length}), la copia al final; sin "Hoja 1"`, nombresHojas().join(',') === ordenEsperado(), nombresHojas().join(','));
  const filasMes = clave => (g.ss.getSheetByName(nombreMes(clave)) || { _celdas: [] })._celdas.length - 1;
  anotar('Cada pestaña de mes tiene exactamente las reservas de ese mes, con encabezado y filtro',
    mesesDatos().every(c => filasMes(c) === datos.reservas.filter(x => x.fecha.startsWith(c)).length && g.ss.getSheetByName(nombreMes(c))._celdas[0][0] === 'N°' && !!g.ss.getSheetByName(nombreMes(c))._filtro),
    mesesDatos().map(c => `${c}:${filasMes(c)}`).slice(0, 4).join(' '));
  const sumaMeses = mesesDatos().reduce((s, c) => s + filasMes(c), 0);
  anotar('Entre todas las pestañas de mes suman las 2500', sumaMeses === 2500, String(sumaMeses));
  const copia = g.ss.getSheetByName(copiaNombre)._celdas.length;
  const movidas = g.movimientos;
  contexto.sincronizar();
  anotar('Una segunda actualización no duplica la copia ni los meses, y no mueve ninguna pestaña', nombresHojas().join(',') === ordenEsperado() && copia === 2501 && g.movimientos === movidas, `${nombresHojas().join(',')} movimientos=${g.movimientos - movidas}`);

  // Un mes que se queda sin reservas pierde su pestaña; un mes nuevo aparece después de "Reservas"
  const respaldo = datos.reservas.slice();
  const masViejo = mesesDatos()[mesesDatos().length - 1];
  datos.reservas = datos.reservas.filter(x => !x.fecha.startsWith(masViejo));
  datos.reservas.push({ ...respaldo[0], id: 99999, fecha: '2029-01-15' });
  contexto.sincronizar();
  anotar(`Se borra la pestaña del mes que quedó vacío (${nombreMes(masViejo)}) y "Enero 2029" aparece primero`,
    !nombresHojas().includes(nombreMes(masViejo)) && nombresHojas()[2] === 'Enero 2029' && nombresHojas().join(',') === ordenEsperado(), nombresHojas().slice(0, 4).join(','));
  datos.reservas = respaldo;
  contexto.sincronizar();

  for (let i = 0; i < 26; i++) g.ss._agregar(`Copia 20${String(i).padStart(2, '0')}-01`); // copias viejas de sobra
  contexto.sincronizar();
  anotar('Se conservan solo las últimas 24 copias', g.ss.getSheets().filter(h => h.getName().startsWith('Copia ')).length === 24 && !nombresHojas().includes('Copia 2000-01'), String(g.ss.getSheets().length));

  g.propiedades.CLAVE_SINCRONIZACION = 'clave-equivocada-de-mas-de-32-caracteres-xx';
  const antes = g.ss.getSheetByName('Reservas')._celdas.length;
  error = null; try { contexto.sincronizar(); } catch (e) { error = e.message; }
  anotar('Clave equivocada: avisa, deja los datos anteriores y anota el error en Resumen', /rechazó la clave/.test(error || '') && g.ss.getSheetByName('Reservas')._celdas.length === antes && /^Error: El servidor rechazó/.test(g.ss.getSheetByName('Resumen')._celdas[2][1]), error);

  g.servidorCaido = 1;
  g.propiedades.CLAVE_SINCRONIZACION = CLAVE;
  contexto.sincronizar();
  anotar('Si el servidor está despertando (502), espera y reintenta una vez', g.reintentos === 1 && g.esperas === 1);

  contexto.activarActualizacionAutomatica(); contexto.activarActualizacionAutomatica();
  anotar('Activar dos veces deja un solo disparador, cada 1 hora, que llama a sincronizar', g.disparadores.length === 1 && g.disparadores[0].horas === 1 && g.disparadores[0].funcion === 'sincronizar', JSON.stringify(g.disparadores));
  contexto.desactivarActualizacionAutomatica();
  anotar('Desactivar lo borra', g.disparadores.length === 0);
  contexto.onOpen();
  anotar('El menú "Reservas CEQ" tiene sus 4 opciones', g.menu.nombre === 'Reservas CEQ' && g.menu.items.length === 4 && g.menu.items.every(([, f]) => typeof contexto[f] === 'function'), JSON.stringify(g.menu));

  for (const x of resultados) console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.detalle && !x.ok ? '  ->  ' + x.detalle : ''}`);
  console.log(`\n${resultados.filter(x => x.ok).length}/${resultados.length} pruebas correctas`);
  process.exit(0);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });

// ---------- Simulador mínimo de Google Apps Script ----------
function crearGoogleSimulado(datosServidor) {
  const g = { propiedades: {}, disparadores: [], menu: null, reintentos: 0, esperas: 0, servidorCaido: 0, movimientos: 0 };
  const letra = c => String.fromCharCode(64 + c);
  function hoja(nombre) {
    const h = { _nombre: nombre, _celdas: [], _formatos: {}, _congeladas: 0, _filtro: null };
    const rango = (fila, col, nf = 1, nc = 1) => {
      const r = {
        setValues(v) { v.forEach((f, i) => f.forEach((x, j) => { (h._celdas[fila - 1 + i] = h._celdas[fila - 1 + i] || [])[col - 1 + j] = x; })); return r; },
        getValues() { return Array.from({ length: nf }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (h._celdas[fila - 1 + i] || [])[col - 1 + j]; return v === undefined ? '' : v; })); },
        setValue(x) { return r.setValues([[x]]); },
        setNumberFormat(f) { h._formatos[letra(col)] = f; return r; },
        setFontWeight() { return r; }, setBackground() { return r; }, setFontColor() { return r; }, setFontSize() { return r; },
        createFilter() { if (h._filtro) throw new Error('ya hay un filtro'); h._filtro = `${letra(col)}${fila}:${letra(col + nc - 1)}${fila + nf - 1}`; return {}; }
      };
      return r;
    };
    Object.assign(h, {
      getName: () => h._nombre, setName(n) { h._nombre = n; return h; },
      getRange(a, b, c, d) {
        if (typeof a === 'string') { const m = a.match(/^([A-Z])(\d+)/); return rango(Number(m[2]), m[1].charCodeAt(0) - 64, 1, 1); }
        return rango(a, b, c, d);
      },
      clear() { h._celdas = []; h._formatos = {}; return h; },
      getFilter: () => h._filtro ? { remove() { h._filtro = null; } } : null,
      setFrozenRows(n) { h._congeladas = n; }, autoResizeColumns() {},
      getLastRow: () => h._celdas.length,
      getLastColumn: () => Math.max(0, ...h._celdas.map(f => (f || []).length)),
      deleteColumn(c) { h._celdas.forEach(f => f && f.splice(c - 1, 1)); return h; },
      copyTo(ss) { const c = hoja('Copia de ' + h._nombre); c._celdas = h._celdas.map(f => f.slice()); ss._hojas.push(c); return c; }
    });
    return h;
  }
  const ss = {
    _hojas: [hoja('Hoja 1')], _zona: 'America/Sao_Paulo',
    getSpreadsheetTimeZone: () => ss._zona, setSpreadsheetTimeZone(z) { ss._zona = z; },
    getSheetByName: n => ss._hojas.find(h => h.getName() === n) || null,
    // Como en Google real: la posición de insertSheet no es confiable (se vio que los meses
    // quedaban antes de "Reservas"); acá se inserta una posición antes de la pedida
    insertSheet(n, pos) { const h = hoja(n); if (pos === undefined) ss._hojas.push(h); else ss._hojas.splice(Math.max(0, pos - 1), 0, h); return h; },
    getSheets: () => ss._hojas.slice(),
    deleteSheet(h) { ss._hojas = ss._hojas.filter(x => x !== h); },
    setActiveSheet(h) { ss._activa = h; return h; },
    moveActiveSheet(p) { // posición desde 1, como en Google
      if (!Number.isInteger(p) || p < 1 || p > ss._hojas.length) throw new Error('posición inválida ' + p);
      ss._hojas = ss._hojas.filter(x => x !== ss._activa); ss._hojas.splice(p - 1, 0, ss._activa); g.movimientos++;
    },
    toast() {}, _agregar(n) { const h = hoja(n); ss._hojas.push(h); return h; }
  };
  g.ss = ss;
  const zona = (d, z) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
  g.globales = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => ({ createMenu(n) { const m = { nombre: n, items: [] }; g.menu = m; const o = { addItem(t, f) { m.items.push([t, f]); return o; }, addSeparator() { return o; }, addToUi() {} }; return o; }, alert() {} })
    },
    UrlFetchApp: {
      fetch(url, op) {
        if (url !== 'https://api.ceq-una.com/api/sincronizacion/reservas') throw new Error('URL inesperada ' + url);
        if (g.servidorCaido > 0) { g.servidorCaido--; return { getResponseCode: () => 502, getContentText: () => '<html>' }; }
        if (g.esperas > 0) g.reintentos++;
        if (op.headers['X-Clave-Sincronizacion'] !== CLAVE) return { getResponseCode: () => 401, getContentText: () => '{"error":"Clave de sincronización inválida"}' };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(datosServidor) };
      }
    },
    Utilities: {
      parseDate(texto, z, formato) { // medianoche de esa fecha en la zona z (Asunción = UTC-3)
        if (formato !== 'yyyy-MM-dd' || z !== 'America/Asuncion') throw new Error('formato no simulado');
        const [a, m, d] = texto.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d, 3, 0));
      },
      formatDate(fecha, z, formato) {
        const p = zona(fecha, z);
        return formato.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
      },
      sleep() { g.esperas++; }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => g.propiedades[k] ?? null, setProperty: (k, v) => { g.propiedades[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      newTrigger(f) { const t = { funcion: f }; const b = { timeBased: () => b, everyHours(h) { t.horas = h; return b; }, create() { g.disparadores.push(t); return t; } }; return b; },
      getProjectTriggers: () => g.disparadores.map(t => ({ getHandlerFunction: () => t.funcion, _t: t })),
      deleteTrigger(x) { g.disparadores = g.disparadores.filter(t => t !== x._t); }
    }
  };
  return g;
}
