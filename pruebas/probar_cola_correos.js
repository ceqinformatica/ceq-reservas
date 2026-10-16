// Prueba la cola de correos con reintentos (CEQ-06), con el server.js real, Supabase simulado,
// Brevo interceptado (que se puede "caer" a pedido) y un reloj falso.
// Uso: node probar_cola_correos.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-cola-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-cola-' + marca + '.json');
const brevoCaido = path.join(os.tmpdir(), 'ceq-brevo-caido-' + marca);
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const adelantar = minutos => { desfase += minutos * 60000; fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const caerBrevo = () => fs.writeFileSync(brevoCaido, '1');
const levantarBrevo = () => { try { fs.unlinkSync(brevoCaido); } catch (e) { /* ya estaba */ } };
const hasta = async (condicion, ms = 8000) => { for (let i = 0; i < ms / 100 && !condicion(); i++) await esperar(100); return condicion(); };

let fallarCola = false;
const db = {
  reservas: [],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'email_alertas', valor: 'alertas@example.com' }],
  registro_actividad: [], bloqueos: [], reportes_errores: [], lista_espera: [],
  correos_pendientes: []
};
const mini = crearMiniPostgrest(db, {
  porDefecto: {
    reservas: () => ({ created_at: new Date(Date.now() + desfase).toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false }),
    correos_pendientes: () => ({ intentos: 0, creado_en: new Date(Date.now() + desfase).toISOString(), reclamado_hasta: null, ultimo_error: null, enviado_en: null })
  },
  fallar: (tabla, metodo) => fallarCola && tabla === 'correos_pendientes' && metodo === 'POST'
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3990', SUPABASE_URL: 'http://127.0.0.1:54329', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: 'secreto-cola',
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: 'moderador@example.com', EMAIL_MODERADOR_FRENTE: 'frente@example.com', BREVO_LOG: brevoLog,
      BREVO_CAIDO: brevoCaido, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '1500', INTERVALO_COLA_CORREOS_MS: '400', EMAILS_SIN_LIMITE: '', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  hijo.salida = () => salida;
  return hijo;
}
const API = 'http://127.0.0.1:3990';
let n = 0;
const reservar = async (fecha, email) => {
  const r = await fetch(API + '/api/reservas', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${++n}` },
    body: JSON.stringify({ espacio_id: 3, nombre_solicitante: 'Persona ' + n, contacto: `0981 100 ${String(n).padStart(3, '0')} | ${email}`, fecha, hora_inicio: '07:00', hora_fin: '10:00', motivo: 'Actividad Personal' }) });
  return { status: r.status, datos: await r.json().catch(() => ({})) };
};
const delCorreo = email => correos().filter(c => c.to.some(t => t.email === email));
const filasDe = email => db.correos_pendientes.filter(c => c.asunto && JSON.stringify(c).includes(email) || c._para === email);

(async () => {
  await new Promise(ok => mini.servidor.listen(54329, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11, 10:00 en Paraguay
  let hijo = await arrancar();
  await esperar(1000);

  // ===== 1. Camino normal =====
  let r = await reservar('2026-11-17', 'ana@example.com');
  // CEQ-06: cuando llega el 201, los dos correos ya están guardados en la cola
  anotar('Al responder 201 los dos correos ya están en la cola', r.status === 201 && db.correos_pendientes.length === 2, String(db.correos_pendientes.length));
  const llego = await hasta(() => delCorreo('ana@example.com').length === 1 && delCorreo('frente@example.com').length === 1);
  anotar('Reserva normal: llegan la confirmación y el aviso al moderador', r.status === 201 && llego, `${r.status} ${correos().map(c => c.subject).join(' | ')}`);
  await hasta(() => db.correos_pendientes.length >= 2 && db.correos_pendientes.every(c => c.estado === 'enviado'));
  anotar('Los dos correos pasaron por la cola y quedaron "enviado"', db.correos_pendientes.length === 2 && db.correos_pendientes.every(c => c.estado === 'enviado' && c.intentos === 1),
    JSON.stringify(db.correos_pendientes.map(c => [c.estado, c.intentos])));
  anotar('Al enviarse se borra el contenido (código de cancelación) y los destinatarios', db.correos_pendientes.every(c => c.html === '' && c.texto === null && Array.isArray(c.destinatarios) && c.destinatarios.length === 0),
    JSON.stringify(db.correos_pendientes.map(c => [c.html.length, c.destinatarios])));

  // ===== 2. Brevo caído: queda pendiente y se reintenta =====
  caerBrevo();
  const antes = db.correos_pendientes.length;
  r = await reservar('2026-11-18', 'beto@example.com');
  await hasta(() => db.correos_pendientes.slice(antes).length === 2 && db.correos_pendientes.slice(antes).every(c => c.intentos === 1));
  const nuevas = db.correos_pendientes.slice(antes);
  anotar('Con Brevo caído la reserva se guarda igual (201)', r.status === 201, String(r.status));
  anotar('Los correos quedan pendientes, con 1 intento, el error y el próximo intento en 1 minuto',
    nuevas.length === 2 && nuevas.every(c => c.estado === 'pendiente' && c.intentos === 1 && /Brevo 500/.test(c.ultimo_error || '') && c.html.length > 0),
    JSON.stringify(nuevas.map(c => [c.estado, c.intentos, c.ultimo_error])));
  await esperar(1500);
  anotar('Antes de que pase el minuto no se reintenta', nuevas.every(c => c.intentos === 1) && delCorreo('beto@example.com').length === 0);
  levantarBrevo();
  adelantar(2);
  const reintento = await hasta(() => delCorreo('beto@example.com').length === 1);
  await hasta(() => nuevas.every(c => c.estado === 'enviado'));
  anotar('Cuando Brevo vuelve y pasa el minuto, se reintenta y llega', reintento && nuevas.every(c => c.estado === 'enviado' && c.intentos === 2 && c.html === ''),
    JSON.stringify(nuevas.map(c => [c.estado, c.intentos])));
  const confirmacionBeto = delCorreo('beto@example.com')[0];
  anotar('La confirmación reintentada tiene el código de cancelación', confirmacionBeto && /[0-9A-F]{16}/.test(confirmacionBeto.htmlContent), confirmacionBeto && confirmacionBeto.subject);

  // ===== 3. Brevo caído todo el tiempo: después de 6 intentos se da por perdido =====
  caerBrevo();
  const antes3 = db.correos_pendientes.length;
  await reservar('2026-11-19', 'caro@example.com');
  await hasta(() => db.correos_pendientes.slice(antes3).length === 2 && db.correos_pendientes.slice(antes3).every(c => c.intentos === 1));
  const perdidas = db.correos_pendientes.slice(antes3);
  const pasos = [];
  for (const minutos of [2, 6, 16, 61, 181]) {
    const intentosAntes = perdidas.map(c => c.intentos);
    adelantar(minutos);
    // Se espera a que los DOS correos hayan hecho su intento (y guardado el resultado)
    await hasta(() => perdidas.every((c, i) => c.intentos > intentosAntes[i] && c.estado !== 'enviando'), 6000);
    pasos.push(perdidas.map(c => `${c.estado}:${c.intentos}`).join('/'));
  }
  console.log('   pasos:', pasos.join('  '));
  await hasta(() => perdidas.every(c => c.estado === 'fallido'));
  anotar('Con Brevo caído siempre: 6 intentos (1, 5, 15, 60 y 180 min) y queda "fallido"', perdidas.every(c => c.estado === 'fallido' && c.intentos === 6),
    JSON.stringify(perdidas.map(c => [c.estado, c.intentos])));
  anotar('El fallido conserva a quién, el asunto y el contenido (para poder reintentarlo desde el panel)', perdidas.every(c => c.html.length > 0 && c.destinatarios.length > 0 && c.asunto),
    JSON.stringify(perdidas.map(c => [c.html.length, c.destinatarios])));
  levantarBrevo();

  // ===== 4. Se reinicia el servidor con un correo a medio enviar =====
  hijo.kill(); await esperar(400);
  db.correos_pendientes.push({ id: 900, destinatarios: ['dani@example.com'], asunto: 'Correo a medio enviar', html: '<p>hola</p>', texto: null, responder_a: null,
    estado: 'enviando', intentos: 0, proximo_intento: new Date(Date.now() + desfase - 60000).toISOString(), reclamado_hasta: new Date(Date.now() + desfase - 1000).toISOString(),
    ultimo_error: null, creado_en: new Date(Date.now() + desfase).toISOString(), enviado_en: null });
  hijo = await arrancar();
  const retomado = await hasta(() => delCorreo('dani@example.com').length === 1);
  await hasta(() => db.correos_pendientes.find(c => c.id === 900).estado === 'enviado');
  anotar('Después de un reinicio se retoma el que quedó "enviando"', retomado && db.correos_pendientes.find(c => c.id === 900).estado === 'enviado');
  anotar('...y no se manda dos veces', (await esperar(1500), delCorreo('dani@example.com').length === 1));

  // ===== 5. Si la cola no está disponible, se manda directo como antes =====
  fallarCola = true;
  const filasAntes = db.correos_pendientes.length;
  r = await reservar('2026-11-20', 'eli@example.com');
  const directo = await hasta(() => delCorreo('eli@example.com').length === 1);
  anotar('Si no se puede guardar en la cola, el correo sale directo', r.status === 201 && directo && db.correos_pendientes.length === filasAntes);
  fallarCola = false;

  // ===== 6. Limpieza: las filas resueltas de hace más de 7 días se borran =====
  const totalAntes = db.correos_pendientes.length;
  adelantar(8 * 24 * 60);
  await hasta(() => db.correos_pendientes.length < totalAntes, 6000);
  anotar('A los 7 días se borran las filas enviadas y fallidas', db.correos_pendientes.filter(c => ['enviado', 'fallido'].includes(c.estado)).length === 0,
    `${totalAntes} -> ${db.correos_pendientes.length}`);

  // ===== 7. Recordatorios: primero a la cola, después se marca (CEQ-06) =====
  ponerHora('2026-11-25T13:00:00Z'); // miércoles 25/11, 10:00 en Paraguay → recordatorios del 27
  const resRec = (id, email) => ({ id, espacio_id: 3, nombre_solicitante: 'Rec ' + id, contacto: `0981 200 ${id % 1000} | ${email}`, fecha: '2026-11-27',
    hora_inicio: '07:00:00', hora_fin: '10:00:00', estado: 'activa', motivo: 'Actividad Personal', reservado_por_admin: false, acompanantes: [],
    asistencia: null, recordatorio_enviado_en: null, created_at: '2026-11-20T12:00:00', cancelada_en: null, cancelada_por: null, motivo_cancelacion: null });
  db.reservas.push(resRec(9502, 'rec2@example.com'));
  const llegoRec = await hasta(() => delCorreo('rec2@example.com').some(c => c.subject.includes('Recordatorio')), 8000);
  const filaRec = db.reservas.find(x => x.id === 9502);
  anotar('El recordatorio sale y la reserva queda marcada', llegoRec && !!filaRec.recordatorio_enviado_en, String(filaRec.recordatorio_enviado_en));
  // Simula un reinicio justo después de guardar en la cola: el correo ya está, la reserva sin marcar
  const asuntoRec = (db.correos_pendientes.find(c => (c.asunto || '').includes('CEQ #9502')) || {}).asunto || '';
  db.correos_pendientes.push({ id: 9601, destinatarios: [], asunto: asuntoRec.replace('#9502', '#9501'), html: '', texto: null, responder_a: null, estado: 'enviado', intentos: 1,
    proximo_intento: new Date(Date.now() + desfase).toISOString(), reclamado_hasta: null, ultimo_error: null, creado_en: new Date(Date.now() + desfase).toISOString(), enviado_en: new Date(Date.now() + desfase).toISOString() });
  db.reservas.push(resRec(9501, 'rec1@example.com'));
  await hasta(() => !!db.reservas.find(x => x.id === 9501).recordatorio_enviado_en, 8000);
  await esperar(1500);
  anotar('Si el recordatorio ya estaba en la cola, solo se marca la reserva (no se manda dos veces)',
    asuntoRec && !!db.reservas.find(x => x.id === 9501).recordatorio_enviado_en && delCorreo('rec1@example.com').length === 0, asuntoRec);

  anotar('El servidor dice su NODE_ENV al arrancar', /NODE_ENV: /.test(hijo.salida()), (hijo.salida().match(/.*NODE_ENV.*/) || [''])[0]);
  hijo.kill();
  levantarBrevo();
  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
