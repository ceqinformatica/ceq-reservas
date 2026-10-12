// Prueba los plazos de conservación de la Política de Privacidad (artículo 10): reservas de hace
// más de 6 meses se anonimizan y los reportes de hace más de 6 meses se borran. Con el server.js real,
// Supabase simulado y un reloj falso fijo en el 10/11/2026.
// Uso: node probar_retencion.js <carpeta server+node_modules> <carpeta de ayudantes>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const [carpeta, ayudantes] = process.argv.slice(2);
const { crearMiniPostgrest } = require(path.join(ayudantes, 'mini_postgrest.js'));
const relojArchivo = path.join(os.tmpdir(), 'ceq-reloj-retencion-' + Date.now() + '.json');
const brevoLog = path.join(os.tmpdir(), 'ceq-brevo-retencion-' + Date.now() + '.log');
fs.writeFileSync(brevoLog, '');
fs.writeFileSync(relojArchivo, JSON.stringify({ desfase_ms: Date.parse('2026-11-10T13:00:00Z') - Date.now() }));

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });
const esperar = ms => new Promise(r => setTimeout(r, ms));

let id = 10;
const r = extra => ({ id: ++id, espacio_id: 3, nombre_solicitante: 'Persona ' + id, contacto: `0981000${id} | persona${id}@example.com`,
  hora_inicio: '07:00:00', hora_fin: '10:00:00', estado: 'activa', motivo: 'Actividad Personal', created_at: '2024-01-01T12:00:00',
  reservado_por_admin: false, cancelada_en: null, cancelada_por: null, motivo_cancelacion: null, recordatorio_enviado_en: null, asistencia: null, acompanantes: [], ...extra });
const R = {
  viejaFrente: r({ fecha: '2026-05-08', estado: 'cancelada', motivo_cancelacion: 'Me enfermé' }),         // hace más de 6 meses
  viejaAltillo: r({ fecha: '2026-04-15', espacio_id: 1, motivo: 'Estudiar con Juan Pérez', acompanantes: [{ nombre: 'Ana', celular: '0981111222' }] }),
  limite: r({ fecha: '2026-05-10' }),                                                                    // justo 6 meses: se conserva
  reciente: r({ fecha: '2026-10-20' })
};
const db = {
  reservas: Object.values(R),
  espacios: [{ id: 1, nombre: 'Altillo', publico: true, aviso: null }, { id: 3, nombre: 'Frente', publico: true, aviso: null }],
  meses_habilitados: [], bloqueos: [], lista_espera: [], registro_actividad: [],
  configuracion: [{ clave: 'version_sesiones', valor: '1' }, { clave: 'copia_mensual_enviada', valor: '2026-11' }],
  reportes_errores: [
    { id: 1, mensaje: 'viejo', url: null, navegador: null, leido: true, created_at: '2026-05-01T10:00:00' },
    { id: 2, mensaje: 'reciente', url: null, navegador: null, leido: false, created_at: '2026-10-01T10:00:00' }
  ]
};
const mini = crearMiniPostgrest(db, { porDefecto: { registro_actividad: () => ({ creado_en: new Date().toISOString() }) } });

(async () => {
  await new Promise(ok => mini.servidor.listen(54327, '127.0.0.1', ok));
  const hijo = spawn(process.execPath, ['--require', path.join(ayudantes, 'reloj_falso.js'), '--require', path.join(ayudantes, 'interceptar_brevo.js'), path.join(carpeta, 'server.js')], {
    cwd: carpeta,
    env: { ...process.env, PORT: '3992', SUPABASE_URL: 'http://127.0.0.1:54327', SUPABASE_KEY: 'x', BREVO_API_KEY: 'x', JWT_SECRET: 'secreto-retencion',
      ADMIN_PASSWORD_HASH: 'x', EMAIL_MODERADOR: '', BREVO_LOG: brevoLog, RELOJ_FALSO: relojArchivo, INTERVALO_TAREAS_MS: '700', NODE_OPTIONS: '' }
  });
  let salida = ''; hijo.stdout.on('data', d => salida += d); hijo.stderr.on('data', d => salida += d);
  for (let i = 0; i < 600 && !salida.includes('Servidor corriendo'); i++) await esperar(100);
  if (!salida.includes('Servidor corriendo')) { console.log('NO ARRANCÓ:\n' + salida); process.exit(1); }
  await esperar(2500);

  const vf = R.viejaFrente, va = R.viejaAltillo;
  anotar('Frente de hace más de 6 meses: sin nombre, contacto ni motivo de cancelación', vf.nombre_solicitante === '(datos eliminados)' && vf.contacto === '-' && vf.motivo_cancelacion === null, JSON.stringify(vf));
  anotar('Frente: se conserva lo estadístico (fecha, horario, estado y motivo de la lista)', vf.fecha === '2026-05-08' && vf.hora_inicio === '07:00:00' && vf.estado === 'cancelada' && vf.motivo === 'Actividad Personal');
  anotar('Altillo de hace más de 6 meses: también se borran los acompañantes y el motivo libre', va.nombre_solicitante === '(datos eliminados)' && va.contacto === '-' && Array.isArray(va.acompanantes) && va.acompanantes.length === 0 && va.motivo === '', JSON.stringify(va));
  anotar('Una reserva de hace justo 6 meses todavía se conserva', R.limite.nombre_solicitante.startsWith('Persona') && R.limite.contacto.includes('@'));
  anotar('Las reservas recientes no se tocan', R.reciente.nombre_solicitante.startsWith('Persona') && R.reciente.contacto.includes('@'));
  anotar('Reporte de hace más de 6 meses: borrado; el reciente queda', !db.reportes_errores.some(x => x.id === 1) && db.reportes_errores.some(x => x.id === 2), db.reportes_errores.map(x => x.id).join(','));
  anotar('Queda anotado en el registro de actividad (sin datos personales)', db.registro_actividad.some(a => a.rol === 'sistema' && a.detalle === '2 reserva(s) anonimizada(s) · 1 reporte(s) borrado(s)'), JSON.stringify(db.registro_actividad));
  const registros = db.registro_actividad.length;
  await esperar(2000);
  anotar('Se revisa una vez por día (no vuelve a correr en cada vuelta)', db.registro_actividad.length === registros);
  anotar('Sin errores en el servidor', !/❌|Error interno|TypeError|falló/.test(salida), (salida.match(/.*(❌|Error|falló).*/g) || []).slice(0, 3).join(' / '));

  hijo.kill(); mini.servidor.close();
  try { fs.unlinkSync(relojArchivo); fs.unlinkSync(brevoLog); } catch (e) { /* nada */ }
  for (const x of resultados) console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.detalle && !x.ok ? '  ->  ' + x.detalle : ''}`);
  console.log(`\n${resultados.filter(x => x.ok).length}/${resultados.length} pruebas correctas`);
  process.exit(0);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
