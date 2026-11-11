// Prueba la ruta que guarda TODO lo de un espacio junto (PUT /api/superadmin/espacios/:id, la que
// usa la tarjeta de cada espacio en Avanzado > Espacios) con el Frente, el Altillo y un espacio
// creado desde el panel, y el detector de abusos con período (?desde=&hasta=).
// Con el server.js real, Supabase simulado y Brevo interceptado.
// Uso: node probar_espacio_entero.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const bcrypt = require(require.resolve('bcryptjs', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-ent-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-ent-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const ahoraFalso = () => Date.now() + desfase;
const SECRETO = 'secreto-espacio-entero';

const reserva = (extra = {}) => ({
  espacio_id: 3, nombre_solicitante: 'Persona', contacto: '0981 000 000 | persona@example.com', fecha: '2026-11-18', hora_inicio: '07:00:00', hora_fin: '10:00:00',
  estado: 'activa', motivo: 'Actividad Personal', codigo_cancelacion_hash: 'x', reservado_por_admin: false, acompanantes: [], asistencia: null,
  created_at: '2026-11-01T12:00:00', cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, recordatorio_enviado_en: null, huella_red: null, ...extra
});
// Para el detector: pares de reservas con el mismo celular y dos correos, en fechas distintas
const par = (id, fecha1, fecha2, celular, letra) => [
  reserva({ id, fecha: fecha1, nombre_solicitante: `Uno ${letra}`, contacto: `${celular} | ${letra}1@example.com` }),
  reserva({ id: id + 1, fecha: fecha2, nombre_solicitante: `Otro ${letra}`, contacto: `${celular} | ${letra}2@example.com` })
];
const db = {
  reservas: [
    ...par(801, '2026-11-10', '2026-11-12', '0971 500 001', 'nov'),   // este mes
    ...par(803, '2026-09-01', '2026-09-03', '0971 500 002', 'sep'),   // dentro de los últimos 90 días
    ...par(805, '2026-06-10', '2026-06-12', '0971 500 003', 'jun'),   // hace más de 90 días
    ...par(807, '2026-12-05', '2026-12-06', '0971 500 004', 'dic'),   // todavía no pasaron
    reserva({ id: 809, fecha: '2026-03-02', nombre_solicitante: '-', contacto: '-' }), // ya anonimizadas
    reserva({ id: 810, fecha: '2026-03-03', nombre_solicitante: '-', contacto: '-' })
  ],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }, { clave: 'email_alertas', valor: 'alertas@example.com' }],
  registro_actividad: [], reportes_errores: [], bloqueos: [], lista_espera: [], correos_pendientes: []
};
let proximoEspacio = 4;
let fallarConfiguracion = false;
const mini = crearMiniPostgrest(db, {
  unicas: { configuracion: [['clave']], lista_espera: [['espacio_id', 'email', 'mes']] },
  porDefecto: {
    espacios: () => ({ id: proximoEspacio++ }),
    reservas: () => ({ created_at: new Date(ahoraFalso()).toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false, cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, acompanantes: [] }),
    registro_actividad: () => ({ creado_en: new Date(ahoraFalso()).toISOString() }),
    correos_pendientes: () => ({ intentos: 0, reclamado_hasta: null, ultimo_error: null, enviado_en: null })
  },
  fallar: (tabla, metodo) => fallarConfiguracion && tabla === 'configuracion' && metodo === 'POST'
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3986', SUPABASE_URL: 'http://127.0.0.1:54339', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('clave-de-prueba-local', 4), SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync('clave-suprema-de-prueba', 4),
      EMAIL_MODERADOR: 'moderador@example.com', EMAIL_MODERADOR_FRENTE: 'frente@example.com',
      BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '600000', INTERVALO_COLA_CORREOS_MS: '300', NODE_ENV: 'development', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3986';
let ipN = 1;
async function pedir(metodo, ruta, cuerpo, quien) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.18.${Math.floor(ipN / 250)}.${ipN++ % 250 + 1}` };
  if (quien) {
    const ahora = Math.floor(ahoraFalso() / 1000);
    const token = jwt.sign({ adminId: 'admin', rol: quien, v: 1, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
    Object.assign(headers, { cookie: `admin_token=${token}; csrf_token=csrf`, 'x-csrf-token': 'csrf' });
  }
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const texto = await res.text();
  let datos = {};
  try { datos = JSON.parse(texto); } catch (e) { datos = { texto }; }
  return { status: res.status, datos };
}
const guardar = (id, cuerpo, quien = 'superadmin') => pedir('PUT', `/api/superadmin/espacios/${id}`, cuerpo, quien);
const enLaBase = clave => { const f = db.configuracion.find(x => x.clave === clave); if (!f) return undefined; try { return JSON.parse(f.valor); } catch (e) { return f.valor; } };
const delPanel = async id => ((await pedir('GET', '/api/superadmin/espacios', null, 'superadmin')).datos.espacios || []).find(e => e.id === id) || {};
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let celular = 400;
const datosReserva = (espacio, fecha, ini, fin, motivo, contacto) => ({
  espacio_id: espacio, nombre_solicitante: 'Persona Prueba', acepta_normas: true, contacto: contacto || `0985 ${celular++} 333 | q${celular}@example.com`, fecha, hora_inicio: ini, hora_fin: fin, motivo
});

(async () => {
  await new Promise(ok => mini.servidor.listen(54339, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  const hijo = await arrancar();
  await esperar(800);
  let r;

  // ===== 1. Detector de abusos con período =====
  const celulares = d => (d.casos || []).filter(c => c.tipo === 'celular').map(c => c.reservas.map(x => x.id).join('+')).sort().join(' ');
  r = await pedir('GET', '/api/superadmin/abusos?desde=2026-11-01&hasta=2026-11-30', null, 'admin');
  anotar('Detector con período: sigue siendo solo del admin supremo (403)', r.status === 403, String(r.status));
  r = await pedir('GET', '/api/superadmin/abusos', null, 'superadmin');
  anotar('Detector sin fechas: los últimos 90 días (desde el 18/08) y lo que todavía no pasó, como siempre',
    r.status === 200 && r.datos.desde === '2026-08-18' && r.datos.hasta === null && r.datos.revisadas === 6 && celulares(r.datos) === '801+802 803+804 807+808',
    `${r.status} ${r.datos.desde} ${r.datos.hasta} ${r.datos.revisadas} ${celulares(r.datos)}`);
  r = await pedir('GET', '/api/superadmin/abusos?desde=2026-11-01&hasta=2026-11-30', null, 'superadmin');
  anotar('Detector de noviembre: solo las reservas con fecha de noviembre, y dice qué período y cuántas revisó',
    r.status === 200 && r.datos.desde === '2026-11-01' && r.datos.hasta === '2026-11-30' && r.datos.revisadas === 2 && celulares(r.datos) === '801+802',
    `${r.status} ${JSON.stringify(r.datos).slice(0, 200)}`);
  r = await pedir('GET', '/api/superadmin/abusos?desde=2026-06-01&hasta=2026-06-30', null, 'superadmin');
  anotar('Detector de junio: encuentra un caso de hace más de 90 días, que sin período no aparecía',
    r.status === 200 && r.datos.revisadas === 2 && celulares(r.datos) === '805+806', `${r.status} ${r.datos.revisadas} ${celulares(r.datos)}`);
  r = await pedir('GET', '/api/superadmin/abusos?desde=2026-11-12&hasta=2026-11-12', null, 'superadmin');
  anotar('Detector de un solo día: respeta los dos bordes (una reserva, ningún caso)', r.status === 200 && r.datos.revisadas === 1 && (r.datos.casos || []).length === 0, `${r.status} ${r.datos.revisadas}`);
  r = await pedir('GET', '/api/superadmin/abusos?hasta=2026-09-30', null, 'superadmin');
  anotar('Detector solo con "hasta": toma los 90 días anteriores a esa fecha',
    r.status === 200 && r.datos.desde === '2026-07-02' && r.datos.hasta === '2026-09-30' && celulares(r.datos) === '803+804', `${r.status} ${r.datos.desde} ${celulares(r.datos)}`);
  r = await pedir('GET', '/api/superadmin/abusos?desde=2026-10-01', null, 'superadmin');
  anotar('Detector solo con "desde": de esa fecha en adelante', r.status === 200 && r.datos.desde === '2026-10-01' && r.datos.hasta === null && celulares(r.datos) === '801+802 807+808', `${r.status} ${celulares(r.datos)}`);
  const malas = [];
  for (const q of ['desde=2026-13-01&hasta=2026-11-30', 'desde=hola&hasta=2026-11-30', 'desde=2026-11-01&hasta=2026-02-30', 'desde=01/11/2026&hasta=2026-11-30']) {
    malas.push((await pedir('GET', `/api/superadmin/abusos?${q}`, null, 'superadmin')).status);
  }
  anotar('Detector: las fechas que no existen o están mal escritas no se aceptan (400)', malas.join() === '400,400,400,400', malas.join());
  r = await pedir('GET', '/api/superadmin/abusos?desde=2026-11-30&hasta=2026-11-01', null, 'superadmin');
  anotar('Detector: "desde" posterior a "hasta" no se acepta (400)', r.status === 400 && /posterior/.test(r.datos.error || ''), `${r.status} ${r.datos.error || ''}`);
  r = await pedir('GET', '/api/superadmin/abusos?desde=2025-11-01&hasta=2026-11-16', null, 'superadmin');
  const topeConHasta = r.status;
  r = await pedir('GET', '/api/superadmin/abusos?desde=2025-06-01', null, 'superadmin');
  anotar('Detector: un período de más de un año no se acepta (400), con "hasta" o sin él', topeConHasta === 400 && r.status === 400 && /un año/.test(r.datos.error || ''), `${topeConHasta} ${r.status} ${r.datos.error || ''}`);
  r = await pedir('GET', '/api/superadmin/abusos?desde=2025-11-16&hasta=2026-11-16', null, 'superadmin');
  anotar('Detector: un año justo sí se acepta, y avisa que una parte del período ya está anonimizada',
    r.status === 200 && r.datos.periodo_con_anonimizadas === true && r.datos.sin_datos_antes_de === '2026-05-16' && r.datos.meses_conservacion === 6 && r.datos.revisadas === 6,
    `${r.status} ${r.datos.periodo_con_anonimizadas} ${r.datos.sin_datos_antes_de} ${r.datos.revisadas}`);
  r = await pedir('GET', '/api/superadmin/abusos?desde=2026-03-01&hasta=2026-03-31', null, 'superadmin');
  anotar('Detector: en un período ya anonimizado no revisa nada (y lo avisa)', r.status === 200 && r.datos.revisadas === 0 && r.datos.periodo_con_anonimizadas === true, `${r.status} ${r.datos.revisadas}`);
  r = await pedir('GET', '/api/superadmin/abusos?desde=2026-11-01&hasta=2026-11-30', null, 'superadmin');
  anotar('Detector: en un período reciente no hace falta el aviso de anonimizadas', r.datos.periodo_con_anonimizadas === false, String(r.datos.periodo_con_anonimizadas));

  // ===== 2. Guardar todo lo del Frente junto =====
  r = await guardar(3, { nombre: 'Frente' }, 'admin');
  anotar('Guardar un espacio entero es solo del admin supremo (403)', r.status === 403, String(r.status));
  r = await guardar(99, { nombre: 'No existe' });
  anotar('Un espacio que no existe: 404', r.status === 404, String(r.status));
  const antesFrente = await delPanel(3);
  anotar('El panel recibe el límite por persona como un solo campo (Frente: 2, mínimo 1; Altillo: 0 = sin límite)',
    antesFrente.limite_por_persona === 2 && antesFrente.limite_minimo === 1 && (await delPanel(1)).limite_por_persona === 0 && (await delPanel(1)).limite_minimo === 0,
    `${antesFrente.limite_por_persona} ${antesFrente.limite_minimo}`);
  const todoElFrente = {
    nombre: 'Frente', publico: true, aviso: 'Vuelve en marzo', mostrar_aviso: false,
    modo: 'publico', contacto_texto: '',
    horario: 'turnos', turnos: [{ nombre: 'Mañana', inicio: '07:00', fin: '12:00' }, { nombre: 'Tarde', inicio: '13:00', fin: '18:00' }],
    motivos: ['Actividad Personal', 'Feria'], contacto_email: 'frente@example.com', contacto_whatsapp: '595 981 123 456',
    reglas: { dias: [1, 2, 3], plazo_cancelacion_dias: 3, recordatorio: false, recordatorio_dias: 1, anticipacion_min_dias: 1, anticipacion_max_dias: 30, acompanantes_max: 2, normas: 'Dejar limpio' },
    limite_por_persona: 3, avisos_destinatarios: ['Uno@Example.com', 'dos@example.com']
  };
  const actividadAntes = db.registro_actividad.length;
  r = await guardar(3, todoElFrente);
  const f = await delPanel(3);
  anotar('Frente: una sola llamada guarda nombre, aviso, turnos, motivos, contacto, reglas, límite y destinatarios',
    r.status === 200 && r.datos.mensaje === 'Espacio guardado' && f.turnos.length === 2 && f.turnos[0].nombre === 'Mañana' && igual(f.motivos, ['Actividad Personal', 'Feria']) &&
    f.contacto_email === 'frente@example.com' && f.contacto_whatsapp === '595981123456' && igual(f.reglas.dias, [1, 2, 3]) && f.reglas.plazo_cancelacion_dias === 3 &&
    f.reglas.recordatorio === false && f.reglas.anticipacion_max_dias === 30 && f.reglas.acompanantes_max === 2 && f.reglas.normas === 'Dejar limpio' &&
    f.limite_por_persona === 3 && igual(f.avisos_destinatarios, ['uno@example.com', 'dos@example.com']) && f.aviso === 'Vuelve en marzo' && f.mostrar_aviso === false,
    `${r.status} ${JSON.stringify(r.datos.error || f).slice(0, 300)}`);
  anotar('Frente: cada dato quedó en su clave de siempre (turnos_frente, motivos_frente, contacto_*, max_reservas_por_persona_mes)',
    enLaBase('turnos_frente').length === 2 && igual(enLaBase('motivos_frente'), ['Actividad Personal', 'Feria']) && enLaBase('contacto_email_frente') === 'frente@example.com' &&
    String(enLaBase('contacto_whatsapp_frente')) === '595981123456' && String(enLaBase('max_reservas_por_persona_mes')) === '3' &&
    enLaBase('reglas_espacios')['3'].limite_por_persona_mes === 0 && igual(enLaBase('avisos_ocultos'), [3]) && db.espacios.find(e => e.id === 3).aviso === 'Vuelve en marzo',
    JSON.stringify(db.configuracion.map(x => x.clave)));
  anotar('Frente: lo del Altillo no se tocó (sus reglas y sus destinatarios siguen iguales)',
    igual(enLaBase('reglas_espacios')['1'].dias, [1, 2, 3, 4, 5]) && enLaBase('reglas_espacios')['1'].acompanantes_max === 4 && igual(enLaBase('avisos_destinatarios')['1'], ['moderador@example.com']),
    JSON.stringify(enLaBase('reglas_espacios')['1']));
  const registro = db.registro_actividad.slice(actividadAntes);
  anotar('Frente: queda una sola línea en el registro de actividad, con qué cambió y sin los correos',
    registro.length === 1 && registro[0].accion === 'Cambió un espacio' && /horario/.test(registro[0].detalle) && /límite por persona \(3\)/.test(registro[0].detalle) &&
    /2 correo/.test(registro[0].detalle) && !/example\.com/.test(registro[0].detalle), JSON.stringify(registro));
  r = await pedir('GET', '/api/configuracion');
  anotar('Frente: la página pública ya ve los turnos y el límite nuevos', r.status === 200 && /Mañana/.test(JSON.stringify(r.datos)) && /Feria/.test(JSON.stringify(r.datos)), String(r.status));
  r = await guardar(3, todoElFrente);
  anotar('Guardar lo mismo otra vez: "No había cambios", sin escribir nada ni sumar al registro',
    r.status === 200 && r.datos.mensaje === 'No había cambios' && db.registro_actividad.length === actividadAntes + 1, `${r.status} ${r.datos.mensaje} ${db.registro_actividad.length - actividadAntes}`);

  // Todo o nada: un dato mal y no se guarda ninguno
  r = await guardar(3, { ...todoElFrente, turnos: [{ nombre: 'Único', inicio: '08:00', fin: '09:00' }], avisos_destinatarios: ['esto-no-es-un-correo'] });
  anotar('Frente: con un correo de avisos mal escrito no se guarda nada (400), tampoco los turnos que venían bien',
    r.status === 400 && /no es un correo válido/.test(r.datos.error || '') && enLaBase('turnos_frente').length === 2, `${r.status} ${r.datos.error || ''}`);
  r = await guardar(3, { ...todoElFrente, nombre: 'Frente nuevo', reglas: { ...todoElFrente.reglas, anticipacion_min_dias: 10, anticipacion_max_dias: 5 } });
  anotar('Frente: anticipación máxima menor que la mínima no se acepta (400) y el nombre no cambia',
    r.status === 400 && /no puede ser menor que la mínima/.test(r.datos.error || '') && db.espacios.find(e => e.id === 3).nombre === 'Frente', `${r.status} ${r.datos.error || ''}`);
  r = await guardar(3, { limite_por_persona: 0 });
  const limiteCero = `${r.status} ${r.datos.error || ''}`;
  r = await guardar(3, { limite_por_persona: 21 });
  anotar('Frente: el límite por persona va de 1 a 20 (ni 0 ni 21)', /^400 .*entre 1 y 20/.test(limiteCero) && r.status === 400 && String(enLaBase('max_reservas_por_persona_mes')) === '3', `${limiteCero} | ${r.status}`);
  r = await guardar(3, { horario: 'bloques', hora_desde: 8, hora_hasta: 12 });
  anotar('Frente: no se puede pasar a bloques (400): su forma de reservar es fija', r.status === 400 && /siempre por turnos/.test(r.datos.error || ''), `${r.status} ${r.datos.error || ''}`);
  r = await guardar(3, { motivos: [] });
  anotar('Frente: no puede quedar sin motivos (400)', r.status === 400 && /entre 1 y 10 motivos/.test(r.datos.error || ''), `${r.status} ${r.datos.error || ''}`);
  r = await guardar(3, { avisos_destinatarios: [] });
  anotar('Un espacio no puede quedar sin nadie que reciba los avisos (400)', r.status === 400 && /entre 1 y 5 correos/.test(r.datos.error || ''), `${r.status} ${r.datos.error || ''}`);

  // Lo que no viene en el pedido queda como estaba
  r = await guardar(3, { limite_por_persona: 1 });
  const f2 = await delPanel(3);
  anotar('Mandar un solo dato cambia solo ese: el límite pasa a 1 y lo demás del Frente queda igual',
    r.status === 200 && f2.limite_por_persona === 1 && f2.turnos.length === 2 && igual(f2.reglas, f.reglas) && f2.aviso === 'Vuelve en marzo' && igual(r.datos.cambios, ['límite por persona (1)']),
    `${r.status} ${JSON.stringify(r.datos.cambios)}`);
  // ...y el límite se aplica de verdad al reservar
  await guardar(3, { reglas: { dias: [1, 2, 3, 4, 5], anticipacion_min_dias: 0, anticipacion_max_dias: 0, acompanantes_max: 0 } });
  const persona = '0982 700 700 | limite@example.com';
  const primera = await pedir('POST', '/api/reservas', datosReserva(3, '2026-11-23', '07:00', '12:00', 'Feria', persona));
  const segunda = await pedir('POST', '/api/reservas', datosReserva(3, '2026-11-24', '07:00', '12:00', 'Feria', persona));
  anotar('El límite del Frente guardado desde la tarjeta se aplica: la segunda reserva de la misma persona no entra',
    primera.status === 201 && segunda.status >= 400 && segunda.status < 500, `${primera.status} ${primera.datos.error || ''} | ${segunda.status} ${segunda.datos.error || ''}`);

  // Si la base falla a mitad de camino, la fila del espacio vuelve a como estaba
  fallarConfiguracion = true;
  r = await guardar(3, { nombre: 'Frente renombrado', publico: false, limite_por_persona: 5 });
  fallarConfiguracion = false;
  const filaFrente = db.espacios.find(e => e.id === 3);
  anotar('Todo o nada: si falla la base al guardar la configuración (500), el nombre y la publicación vuelven atrás',
    r.status === 500 && filaFrente.nombre === 'Frente' && filaFrente.publico === true && String(enLaBase('max_reservas_por_persona_mes')) === '1', `${r.status} ${JSON.stringify(filaFrente)}`);

  // ===== 3. Guardar todo lo del Altillo junto =====
  r = await guardar(1, { publico: false, aviso: 'Cerrado por obras', mostrar_aviso: true, modo: 'moderador', contacto_texto: 'Pedí el Altillo en Secretaría',
    hora_desde: 8, hora_hasta: 20, max_horas: 3, limite_por_persona: 4,
    reglas: { dias: [1, 2, 3, 4, 5, 6], plazo_cancelacion_dias: 1, acompanantes_max: 2 }, avisos_destinatarios: ['altillo@example.com'] });
  const a = await delPanel(1);
  anotar('Altillo: una sola llamada guarda publicación, quién reserva, horario, reglas, límite y destinatarios',
    r.status === 200 && a.publico === false && a.aviso === 'Cerrado por obras' && a.modo === 'moderador' && a.contacto_texto === 'Pedí el Altillo en Secretaría' &&
    a.hora_desde === 8 && a.hora_hasta === 20 && a.max_horas === 3 && a.limite_por_persona === 4 && igual(a.reglas.dias, [1, 2, 3, 4, 5, 6]) && a.reglas.acompanantes_max === 2 &&
    igual(a.avisos_destinatarios, ['altillo@example.com']), `${r.status} ${JSON.stringify(r.datos.error || a).slice(0, 300)}`);
  anotar('Altillo: quedó en sus claves de siempre (altillo_hora_*, reglas_espacios[1]) y el Frente no cambió',
    String(enLaBase('altillo_hora_desde')) === '8' && String(enLaBase('altillo_hora_hasta')) === '20' && String(enLaBase('altillo_max_horas')) === '3' &&
    enLaBase('reglas_espacios')['1'].limite_por_persona_mes === 4 && enLaBase('espacios_def')['1'].modo === 'moderador' &&
    enLaBase('turnos_frente').length === 2 && igual(enLaBase('avisos_destinatarios')['3'], ['uno@example.com', 'dos@example.com']), JSON.stringify(enLaBase('reglas_espacios')['1']));
  r = await pedir('GET', '/api/espacios');
  const altilloPublico = (Array.isArray(r.datos) ? r.datos : []).find(e => Number(e.id) === 1) || {};
  anotar('Altillo: la página pública lo ve como no disponible, con su aviso', altilloPublico.publico === false && altilloPublico.aviso === 'Cerrado por obras' && altilloPublico.mostrar_aviso === true, JSON.stringify(altilloPublico));
  r = await guardar(1, { hora_desde: 10, hora_hasta: 12, max_horas: 3 });
  anotar('Altillo: el máximo de horas no puede ser mayor que el horario (400) y no se guarda nada',
    r.status === 400 && /no puede ser mayor que su horario/.test(r.datos.error || '') && String(enLaBase('altillo_hora_desde')) === '8', `${r.status} ${r.datos.error || ''}`);
  r = await guardar(1, { hora_desde: 12, hora_hasta: 12 });
  anotar('Altillo: tiene que cerrar después de abrir (400)', r.status === 400, `${r.status} ${r.datos.error || ''}`);
  r = await guardar(1, { horario: 'turnos', turnos: [{ nombre: 'Mañana', inicio: '08:00', fin: '12:00' }] });
  const altilloTurnos = `${r.status} ${r.datos.error || ''}`;
  r = await guardar(1, { motivos: ['Estudio'] });
  anotar('Altillo: no se puede pasar a turnos ni ponerle lista de motivos (400): eso es fijo', /^400 .*siempre por bloques/.test(altilloTurnos) && r.status === 400 && /no lleva lista de motivos/.test(r.datos.error || ''), `${altilloTurnos} | ${r.status} ${r.datos.error || ''}`);
  r = await guardar(1, { limite_por_persona: 0, publico: true, modo: 'publico' });
  anotar('Altillo: el límite 0 (sin límite) sí se acepta', r.status === 200 && (await delPanel(1)).limite_por_persona === 0 && enLaBase('reglas_espacios')['1'].limite_por_persona_mes === 0, `${r.status} ${r.datos.error || ''}`);

  // ===== 4. Un espacio creado desde el panel =====
  r = await pedir('POST', '/api/superadmin/espacios', { nombre: 'Laboratorio', horario: 'bloques', hora_desde: 8, hora_hasta: 12, max_horas: 2 }, 'superadmin');
  const lab = r.datos.id;
  r = await guardar(lab, {
    nombre: 'Laboratorio 2', publico: true, aviso: '', mostrar_aviso: true, modo: 'moderador', contacto_texto: 'Pedilo en la Secretaría Académica',
    horario: 'turnos', turnos: [{ nombre: 'Mañana', inicio: '08:00', fin: '12:00' }, { nombre: 'Tarde', inicio: '14:00', fin: '18:00' }],
    motivos: ['Práctica', 'Tesis'], contacto_email: 'lab@example.com', contacto_whatsapp: '595981000111',
    reglas: { dias: [2, 4], plazo_cancelacion_dias: 1, recordatorio: true, recordatorio_dias: 1, anticipacion_min_dias: 2, anticipacion_max_dias: 60, acompanantes_max: 3, normas: 'Con guardapolvo' },
    limite_por_persona: 1, avisos_destinatarios: ['lab@example.com', 'jefe@example.com']
  });
  const l = await delPanel(lab);
  anotar('Espacio nuevo: una sola llamada lo renombra, lo publica, lo pasa a turnos y le pone motivos, contacto, reglas, límite y destinatarios',
    r.status === 200 && l.nombre === 'Laboratorio 2' && l.publico === true && l.modo === 'moderador' && l.horario === 'turnos' && l.turnos.length === 2 &&
    igual(l.motivos, ['Práctica', 'Tesis']) && l.contacto_email === 'lab@example.com' && l.contacto_whatsapp === '595981000111' && igual(l.reglas.dias, [2, 4]) &&
    l.reglas.anticipacion_min_dias === 2 && l.reglas.acompanantes_max === 3 && l.reglas.normas === 'Con guardapolvo' && l.limite_por_persona === 1 && l.limite_minimo === 0 &&
    igual(l.avisos_destinatarios, ['lab@example.com', 'jefe@example.com']), `${r.status} ${JSON.stringify(r.datos.error || l).slice(0, 300)}`);
  anotar('Espacio nuevo: lo suyo quedó en espacios_def, reglas_espacios y avisos_destinatarios, y el nombre y la publicación en la tabla espacios',
    enLaBase('espacios_def')[String(lab)].horario === 'turnos' && enLaBase('reglas_espacios')[String(lab)].limite_por_persona_mes === 1 &&
    igual(enLaBase('avisos_destinatarios')[String(lab)], ['lab@example.com', 'jefe@example.com']) && db.espacios.find(e => e.id === lab).nombre === 'Laboratorio 2' && db.espacios.find(e => e.id === lab).publico === true,
    JSON.stringify(enLaBase('espacios_def')));
  r = await guardar(lab, { nombre: 'frente' });
  anotar('Espacio nuevo: no puede llamarse igual que otro (409)', r.status === 409, `${r.status} ${r.datos.error || ''}`);
  r = await guardar(lab, { horario: 'turnos', turnos: [] });
  anotar('Espacio nuevo: por turnos necesita al menos un turno (400)', r.status === 400, `${r.status} ${r.datos.error || ''}`);
  // No se achica el horario por debajo de una reserva activa que todavía no pasó
  db.reservas.push(reserva({ id: 900, espacio_id: lab, fecha: '2026-11-19', hora_inicio: '14:00:00', hora_fin: '18:00:00', motivo: 'Tesis', nombre_solicitante: 'Con reserva' }));
  r = await guardar(lab, { nombre: 'Laboratorio 3', turnos: [{ nombre: 'Mañana', inicio: '08:00', fin: '12:00' }] });
  anotar('Espacio nuevo: con una reserva activa que no entra en el horario nuevo no se guarda nada (409), ni el nombre',
    r.status === 409 && /#900/.test(r.datos.error || '') && db.espacios.find(e => e.id === lab).nombre === 'Laboratorio 2' && enLaBase('espacios_def')[String(lab)].turnos.length === 2, `${r.status} ${r.datos.error || ''}`);
  r = await guardar(lab, { turnos: [{ nombre: 'Mañana', inicio: '08:00', fin: '12:00' }, { nombre: 'Siesta', inicio: '14:00', fin: '18:00' }], modo: 'publico', limite_por_persona: 0 });
  anotar('Espacio nuevo: cambiarle el nombre a un turno sin mover su horario sí se puede, y el límite puede ser 0', r.status === 200 && (await delPanel(lab)).turnos[1].nombre === 'Siesta' && (await delPanel(lab)).limite_por_persona === 0, `${r.status} ${r.datos.error || ''}`);
  r = await pedir('POST', '/api/reservas', datosReserva(lab, '2026-11-24', '08:00', '12:00', 'Práctica'));
  anotar('Espacio nuevo: ya publicado y abierto a la gente, se reserva desde la página (201)', r.status === 201, `${r.status} ${r.datos.error || ''}`);

  // ===== 5. Las rutas de siempre siguen andando y dejan lo mismo que la tarjeta =====
  r = await pedir('POST', '/api/superadmin/configuracion', { altillo_max_horas: 2 }, 'superadmin');
  const viejaConfig = r.status;
  r = await pedir('POST', '/api/superadmin/espacios/1', { publico: true, aviso: '', mostrar_aviso: true }, 'superadmin');
  anotar('Las rutas de siempre (configuración y publicar) siguen andando, y la tarjeta muestra lo que dejaron',
    viejaConfig === 200 && r.status === 200 && (await delPanel(1)).max_horas === 2 && (await delPanel(1)).aviso === '', `${viejaConfig} ${r.status}`);

  hijo.kill(); mini.servidor.close();
  fs.unlinkSync(brevoLog); fs.unlinkSync(relojArchivo);
  let ok = 0;
  for (const x of resultados) { console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + String(x.detalle).slice(0, 400)}`); if (x.ok) ok++; }
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
