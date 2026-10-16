// Prueba la copia de seguridad mensual por correo y el "Responder a" de los correos, con el
// server.js real, Supabase simulado, Brevo interceptado y un reloj falso.
// Uso: node probar_copia_y_responder.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-copia-' + Date.now() + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-copia-' + Date.now() + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const ponerHora = isoUtc => fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: Date.parse(isoUtc) - Date.now() }));
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const copias = () => correos().filter(c => c.subject.startsWith('Copia de seguridad'));
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

let id = 100;
const r = extra => ({ id: ++id, espacio_id: 3, nombre_solicitante: 'Persona ' + id, contacto: `0981000${id} | persona${id}@example.com`, fecha: '2026-11-20',
  hora_inicio: '07:00:00', hora_fin: '10:00:00', estado: 'activa', motivo: 'Actividad Personal', codigo_cancelacion_hash: sha('X' + id),
  created_at: '2026-10-30T15:00:00', reservado_por_admin: false, cancelada_en: null, cancelada_por: null, motivo_cancelacion: null,
  recordatorio_enviado_en: '2026-10-30T15:00:00', asistencia: null, acompanantes: [], ...extra });
const db = {
  reservas: [
    r({ nombre_solicitante: 'María José Núñez' }),
    r({ espacio_id: 1, hora_inicio: '08:00:00', hora_fin: '10:00:00', motivo: 'Estudiar "Orgánica"', acompanantes: [{ nombre: 'Ana Pérez', celular: '0981 111 222' }] }),
    r({ nombre_solicitante: '=HYPERLINK("http://malo")', estado: 'cancelada', cancelada_en: '2026-10-31T13:00:00', cancelada_por: 'usuario', motivo_cancelacion: 'No puedo ir' }),
    r({ fecha: '2026-11-25', codigo_cancelacion_hash: sha('CODIGOFRENTE1234'), contacto: '0981999888 | frente@example.com' })
  ],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 2, nombre: 'Sala', publico: false, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }, { id: 2, anio: 2026, mes: 12, habilitado: true, abrir_en: null }],
  configuracion: [
    { clave: 'version_sesiones', valor: '1' },
    { clave: 'contacto_email_frente', valor: 'frente-contacto@example.com' },
    { clave: 'email_alertas', valor: 'alertas@example.com' }
  ],
  registro_actividad: [], lista_espera: [], bloqueos: [], reportes_errores: []
};
const mini = crearMiniPostgrest(db, {
  porDefecto: { reservas: () => ({ created_at: new Date().toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false }) }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3993', SUPABASE_URL: 'http://127.0.0.1:54326', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: 'secreto-copia',
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', EMAIL_MODERADOR_FRENTE: 'moderadora-frente@example.com', BREVO_LOG: brevoLog,
      RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '700', EMAILS_SIN_LIMITE: '', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  hijo.salida = () => salida;
  return hijo;
}
const API = 'http://127.0.0.1:3993';
let ipN = 1;
const post = async (ruta, cuerpo) => {
  const res = await fetch(API + ruta, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ipN++}` }, body: JSON.stringify(cuerpo) });
  return { status: res.status, datos: await res.json().catch(() => ({})) };
};
const valorConfig = clave => (db.configuracion.find(c => c.clave === clave) || {}).valor;

(async () => {
  await new Promise(ok => mini.servidor.listen(54326, '127.0.0.1', ok));
  ponerHora('2026-11-01T10:30:00Z'); // domingo 01/11, 07:30 en Paraguay
  let hijo = await arrancar();
  await esperar(2500);

  // ===== Copia mensual =====
  anotar('Antes de las 08:00 no se manda la copia', copias().length === 0 && valorConfig('copia_mensual_enviada') === undefined);
  ponerHora('2026-11-01T11:05:00Z'); // 08:05
  await esperar(2500);
  const c1 = copias();
  anotar('A las 08:05 del 1° llega UNA copia al correo de alertas', c1.length === 1 && c1[0].to[0].email === 'alertas@example.com', `${c1.length} ${c1[0] && c1[0].to[0].email}`);
  anotar('Asunto con el mes y la cantidad', c1[0] && c1[0].subject === 'Copia de seguridad de las reservas: noviembre 2026 (4 reservas)', c1[0] && c1[0].subject);
  const adj = c1[0] && c1[0].attachment && c1[0].attachment[0];
  anotar('Trae el archivo reservas-ceq-2026-11.csv', adj && adj.name === 'reservas-ceq-2026-11.csv', adj && adj.name);
  const csv = adj ? Buffer.from(adj.content, 'base64').toString('utf8') : '';
  const lineas = csv.replace(/^﻿/, '').trim().split('\r\n');
  anotar('El archivo empieza con BOM (tildes bien en Excel) y usa ";"', csv.startsWith('﻿') && lineas[0].startsWith('"N°";"Fecha";"Espacio"'), lineas[0]);
  anotar('Una fila por reserva (4) más el encabezado', lineas.length === 5, String(lineas.length));
  anotar('Tiene TODOS los datos: celular, correo, acompañantes con celular, cancelación', csv.includes('"persona101@example.com"') && csv.includes('"0981000101"') && csv.includes('Ana Pérez (0981 111 222)') && csv.includes('"No puedo ir"') && csv.includes('"usuario"'));
  anotar('Tildes y comillas bien escritas', csv.includes('"María José Núñez"') && csv.includes('"Estudiar ""Orgánica"""'));
  anotar('Un nombre que empieza con "=" no se toma como fórmula', csv.includes(`"'=HYPERLINK(""http://malo"")"`));
  anotar('Fechas de creación en hora de Paraguay', csv.includes('"30/10/2026 12:00"'));
  anotar('Se anota el mes enviado en la base', valorConfig('copia_mensual_enviada') === '2026-11');
  ponerHora('2026-11-01T15:00:00Z');
  await esperar(1500);
  anotar('Más tarde ese mes no se repite', copias().length === 1);
  hijo.kill(); await esperar(300);
  hijo = await arrancar(); await esperar(2000);
  anotar('Aunque el servidor se reinicie, no se repite', copias().length === 1);
  ponerHora('2026-12-01T11:10:00Z');
  await esperar(2500);
  anotar('El 1° de diciembre llega la de diciembre', copias().length === 2 && copias()[1].subject.includes('diciembre 2026') && valorConfig('copia_mensual_enviada') === '2026-12', copias().map(c => c.subject).join(' | '));
  // Si Brevo falla, no se marca y se reintenta
  db.configuracion.find(c => c.clave === 'email_alertas').valor = 'falla-brevo@example.com';
  await esperar(1500); // relee la configuración
  ponerHora('2027-01-01T11:10:00Z');
  await esperar(2500);
  anotar('Si el envío falla, no sale ninguna copia (y se reintenta después)', !copias().some(c => c.subject.includes('enero 2027')) && (['2026-12', '2027-01'].includes(valorConfig('copia_mensual_enviada')) || /^2027-01\|enviando\|/.test(valorConfig('copia_mensual_enviada'))), valorConfig('copia_mensual_enviada'));
  db.configuracion.find(c => c.clave === 'email_alertas').valor = 'alertas@example.com';
  await esperar(2500);
  anotar('Cuando el correo vuelve a andar, se manda', copias().some(c => c.subject.includes('enero 2027')) && valorConfig('copia_mensual_enviada') === '2027-01', valorConfig('copia_mensual_enviada'));
  // CEQ-06: el servidor se reinició mientras mandaba la copia de febrero (quedó "enviando")
  const fila = db.configuracion.find(c => c.clave === 'copia_mensual_enviada');
  fila.valor = '2027-02|enviando|2027-02-01T11:00:00.000Z';
  ponerHora('2027-02-01T11:10:00Z');
  await esperar(2500);
  anotar('Si la marca "enviando" es reciente (10 min), no se manda otra vez', !copias().some(c => c.subject.includes('febrero 2027')), valorConfig('copia_mensual_enviada'));
  fila.valor = '2027-02|enviando|2027-02-01T10:00:00.000Z';
  await esperar(2500);
  anotar('Si quedó colgada más de 30 minutos, se manda y queda anotado el mes', copias().filter(c => c.subject.includes('febrero 2027')).length === 1 && valorConfig('copia_mensual_enviada') === '2027-02', valorConfig('copia_mensual_enviada'));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11, 10:00
  await esperar(1000);

  // ===== Responder a =====
  const antes = correos().length;
  let x = await post('/api/reservas', { espacio_id: 3, nombre_solicitante: 'Luis', contacto: '0982 123 456 | luis@example.com', fecha: '2026-11-23', hora_inicio: '10:00', hora_fin: '13:00', motivo: 'Actividad Personal' });
  await esperar(500);
  let nuevos = correos().slice(antes);
  const conf = nuevos.find(c => c.subject.startsWith('✓ Confirmación'));
  const aviso = nuevos.find(c => c.subject.startsWith('📌 Nueva Reserva'));
  anotar('Frente: si la persona responde la confirmación, le llega al contacto del Frente', x.status === 201 && conf && conf.replyTo && conf.replyTo.email === 'frente-contacto@example.com', conf && JSON.stringify(conf.replyTo));
  anotar('Aviso al moderador: "Responder" le escribe directo a la persona', aviso && aviso.replyTo && aviso.replyTo.email === 'luis@example.com', aviso && JSON.stringify(aviso.replyTo));
  const antes2 = correos().length;
  x = await post('/api/reservas', { espacio_id: 1, nombre_solicitante: 'Sofi', contacto: '0983 123 456 | sofi@example.com', fecha: '2026-11-23', hora_inicio: '08:00', hora_fin: '09:00', motivo: 'Estudiar' });
  await esperar(500);
  nuevos = correos().slice(antes2);
  const confA = nuevos.find(c => c.subject.startsWith('✓ Confirmación'));
  anotar('Altillo: la respuesta va a reservas@ceq-una.com (el contacto general)', x.status === 201 && confA && confA.replyTo.email === 'reservas@ceq-una.com', confA && JSON.stringify(confA.replyTo));
  const antes3 = correos().length;
  x = await post('/api/cancelar-por-codigo', { codigo: 'CODIGOFRENTE1234' });
  await esperar(500);
  nuevos = correos().slice(antes3);
  const canc = nuevos.find(c => c.subject.startsWith('Cancelación Confirmada'));
  const cancMod = nuevos.find(c => c.subject.startsWith('Cancelación de Reserva'));
  anotar('Cancelación: la persona responde al Frente y el moderador a la persona', x.status === 200 && canc && canc.replyTo.email === 'frente-contacto@example.com' && cancMod && cancMod.replyTo.email === 'frente@example.com', `${x.status} ${canc && canc.replyTo.email} ${cancMod && cancMod.replyTo.email}`);
  // reservas@ceq-una.com recibe desde el 16/10/2026 (reenvío de Cloudflare), así que ahora es un "Responder a" válido
  anotar('Todos los correos enviados tienen un "Responder a" con un correo', correos().every(c => c.replyTo && /@/.test(c.replyTo.email)), correos().filter(c => !c.replyTo).map(c => c.subject).join(' | '));
  anotar('Ningún correo le muestra a la gente el Gmail de la Secretaría (el contacto es reservas@ceq-una.com)',
    correos().every(c => !/ceq\.informatica@gmail\.com/.test(`${c.htmlContent || ''} ${c.textContent || ''}`) || /Copia de seguridad|Alerta|reporte/i.test(c.subject)),
    correos().filter(c => /ceq\.informatica@gmail\.com/.test(`${c.htmlContent || ''} ${c.textContent || ''}`)).map(c => c.subject).join(' | '));
  anotar('Sin errores en el servidor', !/❌|Error interno|TypeError|ReferenceError/.test(hijo.salida()), (hijo.salida().match(/.*(❌|Error).*/g) || []).slice(0, 3).join(' / '));

  hijo.kill(); mini.servidor.close();
  try { fs.unlinkSync(brevoLog); fs.unlinkSync(relojArchivo); } catch (e) { /* nada */ }
  for (const x of resultados) console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.detalle && !x.ok ? '  ->  ' + x.detalle : ''}`);
  console.log(`\n${resultados.filter(x => x.ok).length}/${resultados.length} pruebas correctas`);
  process.exit(0);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
