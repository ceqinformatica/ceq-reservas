// Ejecuta esquema-base-de-datos.sql en un PostgreSQL vacío (PGlite) y prueba que las
// reglas de la base se comporten igual que en producción.
// Uso: node probar_esquema.js <carpeta con node_modules de pglite> <archivo .sql>
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const [carpeta, archivoSql] = process.argv.slice(2);
const req = createRequire(path.join(carpeta, 'package.json'));
const { PGlite } = req('@electric-sql/pglite');
const { btree_gist } = req('@electric-sql/pglite/contrib/btree_gist');

const resultados = [];
const anotar = (nombre, ok, detalle = '') => resultados.push({ nombre, ok, detalle });

(async () => {
  const db = new PGlite({ extensions: { btree_gist } });
  const version = (await db.query('select version() as v')).rows[0].v.split(' on ')[0];

  try {
    await db.exec(fs.readFileSync(archivoSql, 'utf8'));
    anotar(`El archivo se ejecuta completo en una base vacía (${version})`, true);
  } catch (e) {
    anotar('El archivo se ejecuta completo en una base vacía', false, e.message);
    return terminar();
  }

  const ok = async (sql) => { try { await db.query(sql); return 'ok'; } catch (e) { return e.code || e.message; } };
  const reserva = (esp, fecha, ini, fin, estado = 'activa') =>
    `insert into reservas (espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, estado, codigo_cancelacion_hash)
     values (${esp}, 'Prueba', '0981 000 000 | prueba@ejemplo.com', '${fecha}', '${ini}', '${fin}', '${estado}', md5(random()::text))`;
  const bloqueo = (esp, fecha, ini, fin) =>
    `insert into bloqueos (espacio_id, fecha, hora_inicio, hora_fin, motivo) values (${esp}, '${fecha}', '${ini}', '${fin}', 'prueba')`;

  // Estructura
  const tablas = (await db.query(`select string_agg(tablename, ', ' order by tablename) t from pg_tables where schemaname = 'public'`)).rows[0].t;
  anotar('Están las 9 tablas', tablas === 'bloqueos, cancelaciones, configuracion, espacios, lista_espera, meses_habilitados, registro_actividad, reportes_errores, reservas', tablas);
  const esp = (await db.query('select id, nombre from espacios order by id')).rows.map(r => `${r.id}=${r.nombre}`).join(', ');
  anotar('Los 3 espacios con sus números (1 Altillo, 2 Sala, 3 Frente)', esp === '1=Altillo, 2=Sala de Reuniones, 3=Frente', esp);
  const rls = (await db.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`)).rows[0].n;
  anotar('RLS activado en las 9 tablas (solo el servidor puede leer y escribir)', rls === 9, String(rls));

  // Regla anti-superposición
  anotar('Reserva Frente 07:00-10:00', await ok(reserva(3, '2026-11-10', '07:00', '10:00')) === 'ok');
  const horario = (await db.query(`select horario::text h from reservas order by id desc limit 1`)).rows[0].h;
  anotar('La columna horario se calcula sola', horario === '["2026-11-10 07:00:00","2026-11-10 10:00:00")', horario);
  anotar('Mismo turno otra vez: rechazada (23P01)', await ok(reserva(3, '2026-11-10', '07:00', '10:00')) === '23P01');
  anotar('Superposición parcial 08:00-09:00: rechazada', await ok(reserva(3, '2026-11-10', '08:00', '09:00')) === '23P01');
  anotar('Turno contiguo 10:00-13:00: permitido', await ok(reserva(3, '2026-11-10', '10:00', '13:00')) === 'ok');
  anotar('Mismo horario en otro espacio: permitido', await ok(reserva(1, '2026-11-10', '08:00', '09:00')) === 'ok');
  anotar('Mismo horario otro día: permitido', await ok(reserva(3, '2026-11-11', '07:00', '10:00')) === 'ok');
  await db.query(`update reservas set estado = 'cancelada' where espacio_id = 3 and fecha = '2026-11-11'`);
  anotar('Turno de una reserva cancelada: se puede volver a reservar', await ok(reserva(3, '2026-11-11', '07:00', '10:00')) === 'ok');

  // Triggers de bloqueos
  anotar('Bloqueo sobre reserva activa: rechazado (CEQ02)', await ok(bloqueo(3, '2026-11-10', '00:00', '23:59')) === 'CEQ02');
  anotar('Bloqueo en un día libre: permitido', await ok(bloqueo(3, '2026-11-12', '00:00', '23:59')) === 'ok');
  anotar('Reserva sobre un día bloqueado: rechazada (CEQ01)', await ok(reserva(3, '2026-11-12', '14:00', '18:00')) === 'CEQ01');
  anotar('Bloqueo repetido (mismo espacio, día y hora): rechazado (23505)', await ok(bloqueo(3, '2026-11-12', '00:00', '23:59')) === '23505');
  await db.query(reserva(3, '2026-11-13', '14:00', '18:00', 'cancelada'));
  anotar('Bloqueo sobre una reserva cancelada: permitido', await ok(bloqueo(3, '2026-11-13', '14:00', '18:00')) === 'ok');
  anotar('Reactivar una reserva cancelada sobre un bloqueo: rechazado (CEQ01)', await ok(`update reservas set estado = 'activa' where fecha = '2026-11-13'`) === 'CEQ01');

  // Otras reglas
  anotar('Mes 13: rechazado (23514)', await ok(`insert into meses_habilitados (anio, mes) values (2026, 13)`) === '23514');
  anotar('Mes válido: permitido', await ok(`insert into meses_habilitados (anio, mes) values (2026, 11)`) === 'ok');
  anotar('Mismo mes dos veces: rechazado (23505)', await ok(`insert into meses_habilitados (anio, mes) values (2026, 11)`) === '23505');
  anotar('Código cifrado repetido: rechazado (23505)', await ok(`insert into reservas (espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, codigo_cancelacion_hash)
    select 2, 'x', 'x', '2026-11-20', '08:00', '09:00', codigo_cancelacion_hash from reservas where codigo_cancelacion_hash is not null limit 1`) === '23505');
  anotar('Reserva con espacio inexistente: rechazada (23503)', await ok(reserva(99, '2026-11-20', '08:00', '09:00')) === '23503');
  anotar('Reporte de error se guarda con leido = false', await ok(`insert into reportes_errores (mensaje) values ('hola')`) === 'ok'
    && (await db.query('select leido from reportes_errores')).rows[0].leido === false);
  const nuevo = (await db.query(`insert into espacios (nombre) values ('Espacio nuevo') returning id`)).rows[0].id;
  anotar('Un espacio nuevo recibe el número 4', Number(nuevo) === 4, String(nuevo));

  // Reglas de octubre de 2026: asistencia, acompañantes y lista de espera general
  const ultima = async () => (await db.query('select id from reservas order by id desc limit 1')).rows[0].id;
  await db.query(reserva(3, '2026-11-24', '07:00', '10:00'));
  const idFrente = await ultima();
  anotar('Asistencia: acepta "vino" y rechaza otros valores (23514)', await ok(`update reservas set asistencia = 'vino' where id = ${idFrente}`) === 'ok'
    && await ok(`update reservas set asistencia = 'tal vez' where id = ${idFrente}`) === '23514');
  anotar('Frente con acompañantes: rechazado (23514)', await ok(`update reservas set acompanantes = '[{"nombre":"Ana","celular":"0981"}]' where id = ${idFrente}`) === '23514');
  await db.query(reserva(1, '2026-11-24', '08:00', '10:00'));
  const idAltillo = await ultima();
  const lista = n => JSON.stringify(Array.from({ length: n }, (_, i) => ({ nombre: 'A' + i, celular: '098100000' + i })));
  anotar('Altillo con 4 acompañantes: permitido', await ok(`update reservas set acompanantes = '${lista(4)}' where id = ${idAltillo}`) === 'ok');
  anotar('Altillo con 5 acompañantes: rechazado (23514)', await ok(`update reservas set acompanantes = '${lista(5)}' where id = ${idAltillo}`) === '23514');
  anotar('Lista de espera: un correo por espacio (23505 si se repite)', await ok(`insert into lista_espera (espacio_id, email) values (3, 'a@b.com')`) === 'ok'
    && await ok(`insert into lista_espera (espacio_id, email) values (3, 'a@b.com')`) === '23505'
    && await ok(`insert into lista_espera (espacio_id, email) values (1, 'a@b.com')`) === 'ok');
  terminar();

  function terminar() {
    for (const x of resultados) console.log(`${x.ok ? 'OK   ' : 'FALLA'} ${x.nombre}${x.detalle ? '  ->  ' + x.detalle : ''}`);
    console.log(`\n${resultados.filter(x => x.ok).length}/${resultados.length} pruebas correctas`);
  }
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
