// Prueba la segunda tanda de personalización (19/10/2026): acompañantes por espacio, quién recibe
// los avisos internos y sus textos, las respuestas listas para copiar, y los textos fijos de la
// página y los mensajes de error. Con el server.js real, Supabase simulado, Brevo interceptado.
// Uso: node probar_mas_personalizacion.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-mas-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-mas-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
const correos = () => fs.readFileSync(brevoLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const hasta = async (condicion, ms = 6000) => { for (let i = 0; i < ms / 100 && !condicion(); i++) await esperar(100); return condicion(); };
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const SECRETO = 'secreto-mas';

const db = {
  reservas: [{ id: 801, espacio_id: 1, nombre_solicitante: 'Para Cancelar', contacto: '0981 000 801 | cancelar@example.com', fecha: '2026-11-25', hora_inicio: '08:00:00', hora_fin: '09:00:00',
    estado: 'activa', motivo: 'Estudiar', codigo_cancelacion_hash: 'x', reservado_por_admin: false, acompanantes: [], asistencia: null, created_at: '2026-11-01T12:00:00',
    cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, recordatorio_enviado_en: null }],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }],
  registro_actividad: [], reportes_errores: [], bloqueos: [], lista_espera: [], correos_pendientes: []
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
    env: { ...process.env, PORT: '3981', SUPABASE_URL: 'http://127.0.0.1:54335', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: 'moderador@example.com', EMAIL_MODERADOR_FRENTE: 'frente-mod@example.com', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo,
      INTERVALO_TAREAS_MS: '600000', INTERVALO_COLA_CORREOS_MS: '300', NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3981';
let ipN = 1;
async function pedir(metodo, ruta, cuerpo, rol) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.18.0.${ipN++ % 250}` };
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
const para = c => c.to.map(t => t.email).sort().join(',');
let celular = 100;
const reservar = (espacio, fecha, ini, fin, email, extra = {}) => pedir('POST', '/api/reservas', {
  espacio_id: espacio, nombre_solicitante: 'Persona Prueba', contacto: `0985 ${celular++} 111 | ${email}`, fecha, hora_inicio: ini, hora_fin: fin,
  motivo: espacio === 3 ? 'Actividad Personal' : 'Estudiar', ...extra
});
const REGLAS = (cambio = {}) => ({
  reglas: {
    3: { dias: [1, 2, 3, 4, 5], plazo_cancelacion_dias: 2, recordatorio: true, recordatorio_dias: 2, anticipacion_min_dias: 0, anticipacion_max_dias: 0, limite_por_persona_mes: 0, acompanantes_max: 0, normas: '', ...(cambio[3] || {}) },
    1: { dias: [1, 2, 3, 4, 5], plazo_cancelacion_dias: 0, recordatorio: true, recordatorio_dias: 2, anticipacion_min_dias: 0, anticipacion_max_dias: 0, limite_por_persona_mes: 0, acompanantes_max: 4, normas: '', ...(cambio[1] || {}) }
  }, max_reservas_por_persona_mes: 2
});
const acomp = n => Array.from({ length: n }, (_, i) => ({ nombre: `Acompañante ${i + 1}`, celular: `0981 222 33${i}` }));

(async () => {
  await new Promise(ok => mini.servidor.listen(54335, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  const hijo = await arrancar();
  await esperar(800);

  // ===== Permisos =====
  const prohibidas = [await pedir('POST', '/api/superadmin/avisos-destinatarios', { 3: ['a@b.com'], 1: ['a@b.com'] }, 'admin'), await pedir('POST', '/api/superadmin/respuestas', { restaurar: true }, 'admin')];
  anotar('El admin común no puede cambiar los avisos ni las respuestas (403)', prohibidas.every(p => p.status === 403), prohibidas.map(p => p.status).join(','));

  // ===== Valores de siempre =====
  let p = await pedir('GET', '/api/superadmin/personalizacion', null, 'superadmin');
  let conf = await pedir('GET', '/api/configuracion');
  anotar('Por defecto: Altillo hasta 4 acompañantes y Frente ninguno; avisos del Frente al general y al del Frente, del Altillo al general; 6 respuestas listas',
    p.datos.reglas['1'].acompanantes_max === 4 && p.datos.reglas['3'].acompanantes_max === 0 && conf.datos.reglas['1'].acompanantes_max === 4 && conf.datos.max_acompanantes === 4 &&
    p.datos.avisos_destinatarios['3'].join() === 'moderador@example.com,frente-mod@example.com' && p.datos.avisos_destinatarios['1'].join() === 'moderador@example.com' &&
    p.datos.respuestas_listas.length === 6 && p.datos.respuestas_valores.plazo_frente === '2 días', JSON.stringify({ r: p.datos.reglas, a: p.datos.avisos_destinatarios }));
  anotar('Los textos nuevos de la página llegan con su texto de siempre', conf.datos.textos.confirmacion_titulo === '¡Tu reserva quedó confirmada!' &&
    conf.datos.textos.confirmacion_mensaje.includes('{correo}') && conf.datos.textos.codigo_perdido.includes('{whatsapp}') && conf.datos.textos.reporte_titulo === 'Reportar un problema' &&
    conf.datos.textos.error_ocupado === 'Horario no disponible - se solapa con otra reserva existente', JSON.stringify(conf.datos.textos));

  // ===== Acompañantes por espacio =====
  let r = await pedir('POST', '/api/superadmin/reglas', REGLAS({ 3: { acompanantes_max: 11 } }), 'superadmin');
  anotar('Más de 10 acompañantes en las Reglas: 400', r.status === 400 && /acompañantes/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/superadmin/reglas', REGLAS({ 3: { acompanantes_max: 2 }, 1: { acompanantes_max: 0 } }), 'superadmin');
  conf = await pedir('GET', '/api/configuracion');
  anotar('Se guarda: Frente hasta 2, Altillo ninguno (y la página lo recibe)', r.status === 200 && conf.datos.reglas['3'].acompanantes_max === 2 && conf.datos.reglas['1'].acompanantes_max === 0, `${r.status} ${r.datos.error || ''}`);
  r = await reservar(3, '2026-11-18', '07:00', '10:00', 'frente-acomp@example.com', { acompanantes: acomp(2) });
  anotar('Frente con 2 acompañantes: aceptada y guardada', r.status === 201 && db.reservas.at(-1).acompanantes.length === 2, `${r.status} ${r.datos.error || ''}`);
  await hasta(() => correos().some(c => c.subject.includes('Nueva Reserva (Frente)')));
  const avisoFrente = correos().find(c => c.subject.includes('Nueva Reserva (Frente)'));
  anotar('...el aviso interno lista los acompañantes y va al general y al del Frente', avisoFrente && avisoFrente.htmlContent.includes('Acompañante 1 (0981 222 330)') &&
    para(avisoFrente) === 'frente-mod@example.com,moderador@example.com', avisoFrente && para(avisoFrente));
  r = await reservar(3, '2026-11-18', '10:00', '13:00', 'frente-acomp2@example.com', { acompanantes: acomp(3) });
  anotar('Frente con 3 acompañantes: rechazada (hasta 2)', r.status === 400 && /hasta 2 acompañantes/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await reservar(1, '2026-11-18', '09:00', '10:00', 'altillo-acomp@example.com', { acompanantes: acomp(1) });
  anotar('Altillo con acompañantes cuando no se permiten: rechazada y dice dónde sí', r.status === 400 && /solo en las reservas del Frente/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  const leg = await pedir('GET', '/api/legal/terminos');
  anotar('El comodín de los Términos sigue al máximo del Altillo', leg.datos.html.includes('hasta cero (0) acompañantes'), '');
  await pedir('POST', '/api/superadmin/reglas', REGLAS(), 'superadmin');

  // ===== Quién recibe los avisos internos =====
  const malos = [
    await pedir('POST', '/api/superadmin/avisos-destinatarios', { 3: [], 1: ['a@b.com'] }, 'superadmin'),
    await pedir('POST', '/api/superadmin/avisos-destinatarios', { 3: ['no-es-correo'], 1: ['a@b.com'] }, 'superadmin'),
    await pedir('POST', '/api/superadmin/avisos-destinatarios', { 3: ['a@b.com', 'b@b.com', 'c@b.com', 'd@b.com', 'e@b.com', 'f@b.com'], 1: ['a@b.com'] }, 'superadmin'),
    await pedir('POST', '/api/superadmin/avisos-destinatarios', { 3: ['a@b.com'] }, 'superadmin')
  ];
  anotar('Destinatarios inválidos = 400 (vacío, correo inválido, más de 5, falta un espacio)', malos.every(m => m.status === 400), malos.map(m => `${m.status} ${m.datos.error}`).join(' | '));
  r = await pedir('POST', '/api/superadmin/avisos-destinatarios', { 3: [' Monse@Example.com ', 'otra@example.com', 'monse@example.com'], 1: ['altillo-mod@example.com'] }, 'superadmin');
  anotar('Se guardan en minúsculas y sin repetidos', r.status === 200 && r.datos.avisos_destinatarios['3'].join() === 'monse@example.com,otra@example.com' && r.datos.avisos_destinatarios['1'].join() === 'altillo-mod@example.com', JSON.stringify(r.datos));
  await esperar(300);
  const act = db.registro_actividad.find(a => a.accion === 'Cambió quién recibe los avisos internos');
  anotar('...el registro dice cuántos, sin los correos', !!act && !/@/.test(act.detalle), act && act.detalle);
  const antes = correos().length;
  r = await reservar(1, '2026-11-19', '09:00', '10:00', 'nueva-altillo@example.com');
  await hasta(() => correos().slice(antes).some(c => c.subject.includes('Nueva Reserva (Altillo)')));
  const avisoAltillo = correos().slice(antes).find(c => c.subject.includes('Nueva Reserva (Altillo)'));
  anotar('El aviso de una reserva nueva del Altillo va solo a su destinatario nuevo', avisoAltillo && para(avisoAltillo) === 'altillo-mod@example.com', avisoAltillo && para(avisoAltillo));
  const antes2 = correos().length;
  r = await pedir('POST', '/api/admin/cancelar/801', { motivo: 'Mantenimiento' }, 'superadmin');
  await hasta(() => correos().slice(antes2).some(c => c.subject.includes('Un moderador canceló')));
  const avisoMod = correos().slice(antes2).find(c => c.subject.includes('Un moderador canceló'));
  anotar('El aviso de "un moderador canceló" usa la misma lista y dice el motivo', r.status === 200 && avisoMod && para(avisoMod) === 'altillo-mod@example.com' &&
    avisoMod.subject === '🔔 Un moderador canceló una reserva (Altillo) - CEQ #801' && avisoMod.htmlContent.includes('Motivo de la cancelación:</strong> Mantenimiento'), avisoMod && `${avisoMod.subject} ${para(avisoMod)}`);

  // ===== Textos de los avisos internos =====
  r = await pedir('POST', '/api/superadmin/plantillas', { clave: 'aviso_nueva', asunto: 'Reserva nueva en el {espacio} de {nombre}', titulo: 'Entró una reserva', mensaje: 'Contacto: {contacto}' }, 'superadmin');
  const antes3 = correos().length;
  const nueva = await reservar(3, '2026-11-20', '14:00', '18:00', 'otra-persona@example.com', { nombre_solicitante: 'Lía Gómez' });
  await hasta(() => correos().slice(antes3).some(c => c.subject.startsWith('Reserva nueva en el Frente')));
  const avisoEditado = correos().slice(antes3).find(c => c.subject.startsWith('Reserva nueva en el Frente'));
  // AUD-04: el aviso trae el contacto, pero no el código de cancelación (solo lo tiene la persona)
  anotar('Aviso interno editado: asunto, título y mensaje nuevos, con " - CEQ #número", el contacto y sin el código de cancelación', r.status === 200 && avisoEditado &&
    avisoEditado.subject === `Reserva nueva en el Frente de Lía Gómez - CEQ #${nueva.datos.reserva.id}` && avisoEditado.htmlContent.includes('<h2>Entró una reserva</h2>') &&
    avisoEditado.htmlContent.includes('otra-persona@example.com') && !/Código/.test(avisoEditado.htmlContent) && !/[0-9A-F]{16}/.test(avisoEditado.htmlContent), avisoEditado && avisoEditado.subject);
  r = await pedir('POST', '/api/superadmin/plantillas/vista-previa', { clave: 'aviso_cancelacion_moderador', espacio_id: 3 }, 'superadmin');
  anotar('Vista previa de un aviso interno: el correo real con el contacto de ejemplo y el motivo', r.status === 200 && r.datos.html.includes('Contacto:</strong> 0981 123 456 | ana.perez@example.com') &&
    r.datos.html.includes('Motivo de la cancelación'), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/superadmin/plantillas', { clave: 'confirmacion', asunto: 'Hola {contacto}', titulo: 'x', mensaje: 'x' }, 'superadmin');
  anotar('{contacto} no se puede usar en los correos a la gente (400)', r.status === 400 && /\{contacto\}/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  await pedir('POST', '/api/superadmin/plantillas', { clave: 'aviso_nueva', restaurar: true }, 'superadmin');

  // ===== Respuestas listas =====
  const malasR = [
    await pedir('POST', '/api/superadmin/respuestas', { respuestas: [] }, 'superadmin'),
    await pedir('POST', '/api/superadmin/respuestas', { respuestas: [{ titulo: 'Ok', texto: 'Hola {nomber}' }] }, 'superadmin'),
    await pedir('POST', '/api/superadmin/respuestas', { respuestas: [{ titulo: 'Bien', texto: '' }] }, 'superadmin')
  ];
  anotar('Respuestas inválidas = 400 (ninguna, comodín mal escrito, texto vacío)', malasR.every(m => m.status === 400), malasR.map(m => `${m.status} ${m.datos.error}`).join(' | '));
  r = await pedir('POST', '/api/superadmin/respuestas', { respuestas: [{ titulo: 'Bienvenida', texto: 'Hola, {nombre}: el plazo es de {plazo_frente}.' }, { titulo: 'Otra', texto: 'Texto' }] }, 'superadmin');
  p = await pedir('GET', '/api/superadmin/personalizacion', null, 'superadmin');
  anotar('Se guardan las respuestas nuevas', r.status === 200 && p.datos.respuestas_listas.length === 2 && p.datos.respuestas_listas[0].titulo === 'Bienvenida', `${r.status} ${r.datos.error || ''}`);

  // ===== Mensajes de error editables =====
  r = await pedir('POST', '/api/superadmin/textos', { textos: { error_ocupado: 'Uy, ese turno ya lo tomó otra persona', error_bloqueado: 'El Frente está cerrado ese día por un evento', error_limite: 'Ya usaste tus {maximo} turnos del {espacio} ({cantidad}).', confirmacion_titulo: '' } }, 'superadmin');
  anotar('Se guardan los mensajes de error (un obligatorio vacío vuelve al de siempre)', r.status === 200, `${r.status} ${r.datos.error || ''}`);
  conf = await pedir('GET', '/api/configuracion');
  anotar('...el título vacío de la ventana vuelve a "¡Tu reserva quedó confirmada!"', conf.datos.textos.confirmacion_titulo === '¡Tu reserva quedó confirmada!', conf.datos.textos.confirmacion_titulo);
  db.bloqueos.push({ id: 7001, espacio_id: 3, fecha: '2026-11-27', hora_inicio: '00:00:00', hora_fin: '23:59:00', motivo: 'Evento', lote: null });
  r = await reservar(3, '2026-11-27', '07:00', '10:00', 'tercera@example.com');
  anotar('Horario bloqueado: sale el mensaje nuevo', r.status === 409 && r.datos.error === 'El Frente está cerrado ese día por un evento', `${r.status} ${r.datos.error}`);
  await reservar(3, '2026-11-23', '07:00', '10:00', 'limite@example.com');
  await reservar(3, '2026-11-24', '07:00', '10:00', 'limite@example.com');
  r = await reservar(3, '2026-11-25', '07:00', '10:00', 'limite@example.com');
  anotar('Límite del mes: sale el mensaje nuevo con sus comodines', r.status === 400 && r.datos.error === 'Ya usaste tus 2 turnos del Frente (2 reservas activas).', `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/superadmin/textos', { textos: { confirmacion_mensaje: 'Te escribimos a {email}' } }, 'superadmin');
  anotar('Comodín que no corresponde en un texto: 400', r.status === 400 && /\{correo\}/.test(r.datos.error), `${r.status} ${r.datos.error}`);

  // ===== Después de reiniciar =====
  hijo.kill();
  await esperar(500);
  const hijo2 = await arrancar();
  await esperar(800);
  p = await pedir('GET', '/api/superadmin/personalizacion', null, 'superadmin');
  conf = await pedir('GET', '/api/configuracion');
  anotar('Después de reiniciar siguen los destinatarios, las respuestas y los mensajes', p.datos.avisos_destinatarios['1'].join() === 'altillo-mod@example.com' &&
    p.datos.respuestas_listas.length === 2 && conf.datos.textos.error_ocupado === 'Uy, ese turno ya lo tomó otra persona' && conf.datos.textos.error_bloqueado === 'El Frente está cerrado ese día por un evento', JSON.stringify(p.datos.avisos_destinatarios));
  r = await pedir('POST', '/api/superadmin/respuestas', { restaurar: true }, 'superadmin');
  anotar('"Volver a las originales" deja las 6 respuestas de siempre', r.status === 200 && r.datos.respuestas_listas.length === 6, `${r.status}`);

  hijo2.kill();
  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
