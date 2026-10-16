// Prueba las funciones del admin supremo de octubre de 2026: horario del Altillo y motivos del
// Frente editables, frecuencia y fecha de fin de la ventana de novedades, datos de una persona y
// lista de espera. Con el server.js real, Supabase simulado, Brevo interceptado y un reloj falso.
// Uso: node probar_supremo.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const jwt = require(require.resolve('jsonwebtoken', { paths: [carpeta] }));
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const marca = Date.now();
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-supremo-' + marca + '.log');
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-supremo-' + marca + '.json');
fs.writeFileSync(brevoLog, '');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));
let desfase = 0;
const ponerHora = isoUtc => { desfase = Date.parse(isoUtc) - Date.now(); fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: desfase })); };
const SECRETO = 'secreto-supremo';

let id = 600;
const reserva = extra => ({ id: ++id, espacio_id: 3, nombre_solicitante: 'Otra Persona', contacto: '0985 000 000 | otra@example.com', fecha: '2026-11-18',
  hora_inicio: '07:00:00', hora_fin: '10:00:00', estado: 'activa', motivo: 'Actividad Personal', reservado_por_admin: false, acompanantes: [],
  asistencia: null, created_at: '2026-11-01T12:00:00', cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, ...extra });
const db = {
  reservas: [
    reserva({ id: 701, nombre_solicitante: 'Paula Pérez', contacto: '0981 777 888 | paula@example.com', fecha: '2026-11-10', estado: 'activa', asistencia: 'no_vino' }),
    reserva({ id: 702, nombre_solicitante: 'Paula Pérez', contacto: '+595 981 777 888 | paula@example.com', fecha: '2026-11-11', estado: 'cancelada', motivo_cancelacion: 'Me enfermé' }),
    reserva({ id: 703, espacio_id: 1, nombre_solicitante: 'Tomás Titular', contacto: '0982 111 222 | tomas@example.com', fecha: '2026-11-12', hora_inicio: '08:00:00', hora_fin: '10:00:00',
      motivo: 'Estudiar', acompanantes: [{ nombre: 'Paula Pérez', celular: '0981 777 888' }, { nombre: 'Luis', celular: '0983 333 444' }] }),
    reserva({ id: 704, nombre_solicitante: 'Paula Pérez', contacto: '0981 777 888 | paula@example.com', fecha: '2026-11-25', estado: 'activa' }),
    reserva({ id: 705 })
  ],
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [{ id: 1, anio: 2026, mes: 11, habilitado: true, abrir_en: null }],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }],
  registro_actividad: [], bloqueos: [], reportes_errores: [], correos_pendientes: [],
  lista_espera: [
    { id: 801, espacio_id: 3, email: 'paula@example.com', creado_en: '2026-11-05T12:00:00Z', avisado_en: null },
    { id: 802, espacio_id: 1, email: 'otro@example.com', creado_en: '2026-11-06T12:00:00Z', avisado_en: null }
  ]
};
const mini = crearMiniPostgrest(db, {
  porDefecto: { reservas: () => ({ created_at: new Date(Date.now() + desfase).toISOString().replace('Z', ''), recordatorio_enviado_en: null, asistencia: null, reservado_por_admin: false }) }
});

async function arrancar() {
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3988', SUPABASE_URL: 'http://127.0.0.1:54325', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: SECRETO,
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo,
      INTERVALO_TAREAS_MS: '600000', EMAILS_SIN_LIMITE: '', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) throw new Error('No arrancó:\n' + salida);
  return hijo;
}
const API = 'http://127.0.0.1:3988';
let ipN = 1;
async function pedir(metodo, ruta, cuerpo, rol) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ipN++ % 250}` };
  if (rol) {
    const ahora = Math.floor((Date.now() + desfase) / 1000);
    const token = jwt.sign({ adminId: 'admin', rol, v: 1, iat: ahora, exp: ahora + 3600 }, SECRETO, { algorithm: 'HS256' });
    Object.assign(headers, { cookie: `admin_token=${token}; csrf_token=csrf`, 'x-csrf-token': 'csrf' });
  }
  const res = await fetch(API + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: res.status, datos: await res.json().catch(() => ({})) };
}
const reservar = extra => pedir('POST', '/api/reservas', { espacio_id: 1, nombre_solicitante: 'Nueva Persona', contacto: '0986 123 456 | nueva@example.com',
  fecha: '2026-11-19', hora_inicio: '08:00', hora_fin: '09:00', motivo: 'Estudiar', ...extra });

(async () => {
  await new Promise(ok => mini.servidor.listen(54325, '127.0.0.1', ok));
  ponerHora('2026-11-16T13:00:00Z'); // lunes 16/11/2026, 10:00 en Paraguay
  let hijo = await arrancar();
  await esperar(800);

  // ===== 1. Horario del Altillo y motivos del Frente desde la configuración =====
  let r = await pedir('GET', '/api/superadmin/configuracion', null, 'superadmin');
  anotar('Valores por defecto: Altillo 07-19, máximo 2 h y los 5 motivos', r.datos.altillo_hora_desde === 7 && r.datos.altillo_hora_hasta === 19 && r.datos.altillo_max_horas === 2 && r.datos.motivos_frente.length === 5, JSON.stringify([r.datos.altillo_hora_desde, r.datos.altillo_hora_hasta, r.datos.altillo_max_horas]));
  const motivosNuevos = ['Actividad Personal', 'Recaudación - Secretaría CEQ', '  Reunión   de comisión  '];
  r = await pedir('POST', '/api/superadmin/configuracion', { altillo_hora_desde: 8, altillo_hora_hasta: 20, altillo_max_horas: 3, motivos_frente: motivosNuevos }, 'superadmin');
  anotar('El admin supremo cambia el Altillo a 08-20 con máximo 3 h y la lista de motivos', r.status === 200, `${r.status} ${JSON.stringify(r.datos).slice(0, 120)}`);
  r = await pedir('GET', '/api/configuracion');
  anotar('La página recibe el horario nuevo y los motivos (limpios)', r.datos.altillo.hora_desde === 8 && r.datos.altillo.hora_hasta === 20 && r.datos.altillo.max_horas === 3 &&
    JSON.stringify(r.datos.motivos_frente) === JSON.stringify(['Actividad Personal', 'Recaudación - Secretaría CEQ', 'Reunión de comisión']), JSON.stringify(r.datos.altillo) + JSON.stringify(r.datos.motivos_frente));
  r = await reservar({ hora_inicio: '07:00', hora_fin: '08:00' });
  anotar('Altillo a las 07:00: ahora rechazado (abre a las 08:00)', r.status === 400 && /08:00-20:00/.test(r.datos.error), `${r.status} ${r.datos.error}`);
  r = await reservar({ hora_inicio: '17:00', hora_fin: '20:00' });
  anotar('Altillo 17-20 (3 horas): ahora aceptado', r.status === 201, `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Nueva Persona', contacto: '0986 123 456 | nueva@example.com', fecha: '2026-11-19', hora_inicio: '10:00', hora_fin: '13:00', motivo: 'Reunión de comisión' });
  anotar('Frente con un motivo nuevo de la lista: aceptado', r.status === 201, `${r.status} ${r.datos.error}`);
  r = await pedir('POST', '/api/reservas', { espacio_id: 3, nombre_solicitante: 'Otra Nueva', contacto: '0987 123 456 | otranueva@example.com', fecha: '2026-11-20', hora_inicio: '10:00', hora_fin: '13:00', motivo: 'Recaudación - Padrinaje' });
  anotar('Frente con un motivo que se quitó de la lista: rechazado', r.status === 400 && /motivo/i.test(r.datos.error), `${r.status} ${r.datos.error}`);

  const malos = [
    [{ altillo_hora_desde: 19, altillo_hora_hasta: 19 }, 'abre y cierra igual'],
    [{ altillo_hora_desde: 8, altillo_hora_hasta: 10, altillo_max_horas: 3 }, 'máximo mayor que el horario'],
    [{ altillo_hora_desde: 3 }, 'abre a las 3'],
    [{ altillo_max_horas: 0 }, 'máximo 0'],
    [{ motivos_frente: [] }, 'sin motivos'],
    [{ motivos_frente: ['A'] }, 'motivo de 1 letra'],
    [{ motivos_frente: ['Uno', 'uno'] }, 'repetidos'],
    [{ motivos_frente: ['Con "comillas"'] }, 'comillas'],
    [{ motivos_frente: Array.from({ length: 11 }, (_, i) => 'Motivo ' + i) }, '11 motivos']
  ];
  const estados = [];
  for (const [cuerpo] of malos) estados.push((await pedir('POST', '/api/superadmin/configuracion', cuerpo, 'superadmin')).status);
  anotar('Valores inválidos (horario al revés, máximo mayor que el horario, sin motivos, repetidos…): 400', estados.every(s => s === 400), malos.map(([, n], i) => `${n}=${estados[i]}`).join(', '));
  r = await pedir('POST', '/api/superadmin/configuracion', { altillo_max_horas: 1 }, 'admin');
  anotar('El admin común no puede cambiar la configuración (403)', r.status === 403);
  hijo.kill(); await esperar(300);
  hijo = await arrancar(); await esperar(800);
  r = await pedir('GET', '/api/configuracion');
  anotar('Después de reiniciar el servidor sigue la configuración guardada', r.datos.altillo.hora_desde === 8 && r.datos.motivos_frente.length === 3, JSON.stringify(r.datos.altillo));

  // ===== 2. Ventana de novedades: frecuencia y "mostrar hasta" =====
  const ventana = { titulo: 'Novedades', bloques: [], activa: true, volver_a_mostrar: true };
  r = await pedir('POST', '/api/superadmin/novedades', { ...ventana, frecuencia: 'cada_visita', hasta: '2026-11-30' }, 'superadmin');
  anotar('Se guarda con frecuencia "cada visita" y hasta el 30/11', r.status === 200 && r.datos.ventana_novedades.frecuencia === 'cada_visita' && r.datos.ventana_novedades.hasta === '2026-11-30', JSON.stringify(r.datos.ventana_novedades || r.datos));
  r = await pedir('GET', '/api/configuracion');
  anotar('Antes de la fecha la página la recibe', r.datos.ventana_novedades && r.datos.ventana_novedades.frecuencia === 'cada_visita');
  r = await pedir('POST', '/api/superadmin/novedades', { ...ventana, hasta: '2026-11-15' }, 'superadmin');
  const sinVentana = await pedir('GET', '/api/configuracion');
  anotar('Con "mostrar hasta" ya pasado, la página no la recibe (se quita sola)', r.status === 200 && sinVentana.datos.ventana_novedades === null, JSON.stringify(sinVentana.datos.ventana_novedades));
  r = await pedir('POST', '/api/superadmin/novedades', { ...ventana, hasta: '2026-11-16' }, 'superadmin');
  anotar('El mismo día de "mostrar hasta" todavía se muestra', (await pedir('GET', '/api/configuracion')).datos.ventana_novedades !== null);
  const malasV = [await pedir('POST', '/api/superadmin/novedades', { ...ventana, frecuencia: 'siempre' }, 'superadmin'),
    await pedir('POST', '/api/superadmin/novedades', { ...ventana, hasta: '2026-02-30' }, 'superadmin')];
  anotar('Frecuencia inventada o fecha que no existe: 400', malasV.every(m => m.status === 400), malasV.map(m => m.status).join(','));
  r = await pedir('POST', '/api/superadmin/novedades', { ...ventana }, 'superadmin');
  anotar('Sin frecuencia queda "una vez" (como antes)', r.datos.ventana_novedades && r.datos.ventana_novedades.frecuencia === 'una_vez' && r.datos.ventana_novedades.hasta === null);

  // ===== 3. Lista de espera =====
  r = await pedir('GET', '/api/superadmin/lista-espera', null, 'superadmin');
  anotar('El admin supremo ve la lista de espera', r.status === 200 && r.datos.length === 2, JSON.stringify(r.datos));
  r = await pedir('GET', '/api/superadmin/lista-espera', null, 'admin');
  anotar('El admin común no (403)', r.status === 403);
  r = await pedir('DELETE', '/api/superadmin/lista-espera/802', null, 'superadmin');
  const r404 = await pedir('DELETE', '/api/superadmin/lista-espera/802', null, 'superadmin');
  anotar('Sacar a alguien de la lista (y 404 si ya no está)', r.status === 200 && !db.lista_espera.some(l => l.id === 802) && r404.status === 404, `${r.status} ${r404.status}`);

  // ===== 4. Datos de una persona =====
  r = await pedir('GET', '/api/superadmin/persona?q=paula@example.com', null, 'superadmin');
  anotar('Buscar por correo: sus 3 reservas y su inscripción en la lista de espera', r.status === 200 && r.datos.reservas.map(x => x.id).sort().join() === '701,702,704' && r.datos.lista_espera.length === 1, JSON.stringify({ r: r.datos.reservas?.map(x => x.id), l: r.datos.lista_espera?.length }));
  r = await pedir('GET', '/api/superadmin/persona?q=' + encodeURIComponent('+595 981-777-888'), null, 'superadmin');
  anotar('Buscar por celular (con +595): sus reservas y también donde figura como acompañante',
    r.datos.reservas.length === 3 && r.datos.como_acompanante.length === 1 && r.datos.como_acompanante[0].id === 703 && r.datos.como_acompanante[0].acompanante[0].nombre === 'Paula Pérez',
    JSON.stringify(r.datos.como_acompanante));
  anotar('No se mandan los códigos de cancelación', !JSON.stringify(r.datos).includes('codigo'));
  // CEQ-16: el archivo para la persona lleva solo sus datos
  const ent = r.datos.entrega || {};
  const textoEnt = JSON.stringify(ent);
  anotar('El archivo para la persona: sus reservas, donde fue acompañante y su lista de espera',
    (ent.reservas || []).length === 3 && (ent.como_acompanante || []).length === 1 && (ent.lista_espera || []).length === 1 &&
    ent.como_acompanante[0].como_figura.length === 1 && ent.como_acompanante[0].como_figura[0].nombre === 'Paula Pérez', textoEnt);
  anotar('...sin el nombre de quien reservó ni los otros acompañantes', !/Tomás|Titular|Luis|0983|tomas@/i.test(textoEnt), textoEnt);
  anotar('...de sus reservas solo va cuántos acompañantes tenía', ent.reservas.every(x => typeof x.cantidad_acompanantes === 'number' && !('acompanantes' in x)));
  // CEQ-17: se la encuentra por los otros datos que dejó en sus reservas
  r = await pedir('GET', '/api/superadmin/persona?q=paula@example.com', null, 'superadmin');
  anotar('Buscando por correo también aparece donde figura como acompañante (por su celular)',
    r.datos.como_acompanante.length === 1 && r.datos.como_acompanante[0].id === 703, JSON.stringify(r.datos.como_acompanante));
  // Correos en la cola que todavía guardan contenido
  db.correos_pendientes.push(
    { id: 9001, destinatarios: ['paula@example.com'], asunto: 'Confirmación', html: '<p>Hola Paula</p>', texto: null, estado: 'fallido', intentos: 6, proximo_intento: '2026-11-01T00:00:00Z' },
    { id: 9002, destinatarios: ['moderador@example.com'], asunto: 'Nueva Reserva', html: '<p>Contacto: 0981 777 888 | paula@example.com</p>', texto: null, estado: 'fallido', intentos: 6, proximo_intento: '2026-11-01T00:00:00Z' },
    { id: 9003, destinatarios: ['otra@example.com'], asunto: 'Confirmación', html: '<p>Hola Otra</p>', texto: null, estado: 'fallido', intentos: 6, proximo_intento: '2026-11-01T00:00:00Z' }
  );
  r = await pedir('GET', '/api/superadmin/persona?q=0981777888', null, 'superadmin');
  anotar('Cuenta los correos para ella que siguen en la cola', r.datos.correos_en_cola === 2, String(r.datos.correos_en_cola));
  const malasP = [await pedir('GET', '/api/superadmin/persona?q=123', null, 'superadmin'), await pedir('GET', '/api/superadmin/persona?q=no-es-correo@', null, 'superadmin')];
  anotar('Búsqueda demasiado corta o correo inválido: 400', malasP.every(m => m.status === 400), malasP.map(m => m.status).join(','));
  r = await pedir('GET', '/api/superadmin/persona?q=paula@example.com', null, 'admin');
  anotar('El admin común no puede (403)', r.status === 403);

  r = await pedir('POST', '/api/superadmin/persona/borrar', { q: '0981777888', confirmar: 'BORRAR' }, 'superadmin');
  anotar('Con una reserva activa a futuro no se borra (409) y dice cuál', r.status === 409 && r.datos.reservas.length === 1 && r.datos.reservas[0].fecha === '2026-11-25', JSON.stringify(r.datos));
  r = await pedir('POST', '/api/superadmin/persona/borrar', { q: '0981777888' }, 'superadmin');
  anotar('Sin escribir BORRAR no se borra (400)', r.status === 400);
  db.reservas.find(x => x.id === 704).estado = 'cancelada';
  r = await pedir('POST', '/api/superadmin/persona/borrar', { q: '0981777888', confirmar: 'BORRAR' }, 'superadmin');
  const p = db.reservas.filter(x => [701, 702, 704].includes(x.id));
  anotar('Se borran sus datos: 3 reservas quedan sin nombre ni contacto', r.status === 200 && p.every(x => x.nombre_solicitante === '(datos eliminados)' && x.contacto === '-'), JSON.stringify(r.datos));
  anotar('...el motivo de la lista se conserva y el motivo de cancelación se borra', p.every(x => x.motivo === 'Actividad Personal') && db.reservas.find(x => x.id === 702).motivo_cancelacion === null);
  const r703 = db.reservas.find(x => x.id === 703);
  anotar('...se la quita como acompañante sin tocar al titular ni a los demás', r703.acompanantes.length === 1 && r703.acompanantes[0].nombre === 'Luis' && r703.nombre_solicitante === 'Tomás Titular');
  anotar('...las reservas de otras personas no se tocan', db.reservas.find(x => x.id === 705).nombre_solicitante === 'Otra Persona');
  anotar('...buscando por celular también sale de la lista de espera (que es por correo)', r.datos.lista_espera === 1 && !db.lista_espera.some(l => l.email === 'paula@example.com'), JSON.stringify(r.datos));
  anotar('...y se borran sus correos de la cola (el suyo y el aviso al moderador), no los de otros',
    r.datos.correos === 2 && !db.correos_pendientes.some(c => c.id === 9001 || c.id === 9002) && db.correos_pendientes.some(c => c.id === 9003), JSON.stringify(db.correos_pendientes.map(c => c.id)));
  await esperar(300);
  const act = db.registro_actividad.find(a => a.accion === 'Borró los datos de una persona');
  anotar('El registro de actividad no guarda datos personales', act && !/paula|0981|777/i.test(JSON.stringify(act)), JSON.stringify(act));
  r = await pedir('POST', '/api/superadmin/persona/borrar', { q: 'paula@example.com', confirmar: 'BORRAR' }, 'superadmin');
  anotar('Repetir el borrado no falla y no queda nada más', r.status === 200 && r.datos.reservas === 0 && r.datos.lista_espera === 0 && r.datos.correos === 0, JSON.stringify(r.datos));

  hijo.kill();
  mini.servidor.close();
  const ok = resultados.filter(x => x.ok).length;
  resultados.forEach(x => console.log(`${x.ok ? 'OK  ' : 'FALLA'} ${x.nombre}${x.ok ? '' : '  ->  ' + x.detalle}`));
  console.log(`\n${ok}/${resultados.length} pruebas correctas`);
  process.exit(ok === resultados.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
