// Restaurar la base desde una copia completa (AUD-06).
//
// Convierte la copia completa que manda el sistema (el adjunto "...-completa.json.gz" de la copia
// mensual, o el "...-completa.json" que se baja del panel) en un archivo SQL para cargar en una
// base NUEVA de Supabase. Conserva los números de reserva, así los códigos y los enlaces para
// cancelar siguen sirviendo, y el historial no se mezcla.
//
// Uso (no hace falta instalar nada, solo Node):
//   node restaurar.js reservas-ceq-2026-11-completa.json.gz > restaurar.sql
//
// Después, en el proyecto NUEVO de Supabase (SQL Editor):
//   1. Ejecutar esquema-base-de-datos.sql (crea las tablas vacías).
//   2. Ejecutar restaurar.sql (carga todo; si algo falla, no queda nada a medias).
// Ver el README, "Restaurar la base", para el resto de los pasos (Render y contraseñas).
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

// Orden de carga: primero lo que otras tablas necesitan (espacios), después el resto
const TABLAS = [
  // [tabla, clave, ¿ya tiene filas en una base nueva?]
  ['espacios', 'id', true],
  ['meses_habilitados', 'id', false],
  ['configuracion', 'clave', true],
  ['reservas', 'id', false],
  ['bloqueos', 'id', false],
  ['lista_espera', 'id', false],
  ['reportes_errores', 'id', false],
  ['registro_actividad', 'id', false]
];
// Columnas que calcula la base sola (no se pueden cargar)
const CALCULADAS = { reservas: ['horario'] };
// Los triggers que impiden reservas sobre bloqueos (y al revés) se apagan mientras se carga: los
// datos de la copia ya eran válidos, y el orden de carga no tiene que importar
const TRIGGERS = [['reservas', 'trg_verificar_bloqueo_reserva'], ['bloqueos', 'trg_verificar_reserva_bloqueo']];

function leerCopia(archivo) {
  let datos = fs.readFileSync(archivo);
  if (datos[0] === 0x1f && datos[1] === 0x8b) datos = zlib.gunzipSync(datos);
  const copia = JSON.parse(datos.toString('utf8'));
  if (!copia || copia.formato !== 'copia-ceq-reservas' || !copia.tablas) {
    throw new Error('El archivo no es una copia completa del sistema de reservas (falta "formato": "copia-ceq-reservas")');
  }
  if (copia.version !== 1) throw new Error(`Esta versión de restaurar.js no conoce el formato de copia ${copia.version}`);
  return copia;
}

const nombre = n => {
  if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new Error(`Nombre de columna inválido en la copia: ${n}`);
  return `"${n}"`;
};

function armarSql(copia) {
  // Las filas van como JSON entre $etiqueta$ … $etiqueta$ (sin escapar nada): la etiqueta se elige
  // al azar y se comprueba que no aparezca en los datos
  const texto = JSON.stringify(copia.tablas);
  let etiqueta;
  do { etiqueta = 'copia_' + crypto.randomBytes(6).toString('hex'); } while (texto.includes(etiqueta));
  const lineas = [
    `-- Restauración de la copia del ${copia.creada_en} (generada por restaurar.js)`,
    '-- Ejecutar en una base NUEVA, después de esquema-base-de-datos.sql.',
    'begin;'
  ];
  TRIGGERS.forEach(([t, trg]) => lineas.push(`alter table public.${t} disable trigger ${trg};`));
  const resumen = [];
  for (const [tabla, clave, yaTieneFilas] of TABLAS) {
    const filas = copia.tablas[tabla] || [];
    resumen.push(`${tabla}: ${filas.length}`);
    if (filas.length === 0) continue;
    const columnas = [...new Set(filas.flatMap(f => Object.keys(f)))].filter(c => !(CALCULADAS[tabla] || []).includes(c));
    if (!columnas.includes(clave)) throw new Error(`La tabla ${tabla} de la copia no tiene la columna ${clave}`);
    const lista = columnas.map(nombre).join(', ');
    const identidad = clave === 'id' ? ' overriding system value' : '';
    // Las que la base nueva ya trae (los 3 espacios y la configuración inicial) se reemplazan por
    // las de la copia
    const conflicto = yaTieneFilas
      ? ` on conflict (${nombre(clave)}) do update set ${columnas.filter(c => c !== clave).map(c => `${nombre(c)} = excluded.${nombre(c)}`).join(', ') || `${nombre(clave)} = excluded.${nombre(clave)}`}`
      : '';
    lineas.push(`insert into public.${tabla} (${lista})${identidad}\n  select ${lista} from jsonb_populate_recordset(null::public.${tabla}, $${etiqueta}$${JSON.stringify(filas)}$${etiqueta}$::jsonb)${conflicto};`);
    // El próximo número libre, después del más alto de la copia
    if (clave === 'id') lineas.push(`select setval(pg_get_serial_sequence('public.${tabla}', 'id'), (select coalesce(max(id), 0) + 1 from public.${tabla}), false);`);
  }
  TRIGGERS.forEach(([t, trg]) => lineas.push(`alter table public.${t} enable trigger ${trg};`));
  lineas.push('commit;', `-- Cargado: ${resumen.join(', ')}`);
  return { sql: lineas.join('\n') + '\n', resumen };
}

if (require.main === module) {
  const archivo = process.argv[2];
  if (!archivo) {
    console.error('Uso: node restaurar.js <copia-completa.json.gz o .json> > restaurar.sql');
    process.exit(1);
  }
  try {
    const { sql, resumen } = armarSql(leerCopia(archivo));
    process.stdout.write(sql);
    console.error(`Listo. Filas por tabla: ${resumen.join(', ')}`);
  } catch (err) {
    console.error('No se pudo armar la restauración:', err.message);
    process.exit(1);
  }
}

module.exports = { leerCopia, armarSql };
