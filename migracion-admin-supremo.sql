-- =====================================================================
-- Migración "admin supremo" (11/10/2026)
-- Solo AGREGA columnas y tablas: no borra ni cambia los datos que ya existen.
-- Ya está incluida en esquema-base-de-datos.sql; este archivo queda como registro del cambio.
-- =====================================================================

-- Cuándo, quién y por qué se canceló cada reserva (las canceladas antes de este cambio quedan vacías)
alter table public.reservas
  add column if not exists cancelada_en timestamptz,
  add column if not exists cancelada_por text,
  add column if not exists motivo_cancelacion text;

-- Qué espacios se pueden reservar desde la página y el aviso que se muestra de los que no
alter table public.espacios
  add column if not exists publico boolean not null default false,
  add column if not exists aviso text;

-- Mismo estado que hasta ahora: solo el Frente se reserva desde la página
update public.espacios set publico = true where id = 3;
update public.espacios
  set aviso = 'Por el momento, las reservas del Altillo se gestionan de forma manual, ya que la persona encargada actualmente no cuenta con una computadora para administrarlas a través de este sistema.

Para reservar este espacio, anotate en la planilla correspondiente. Cuando se restablezca el acceso, el Altillo va a volver a estar disponible acá.'
  where id = 1 and aviso is null;

-- Registro de actividad del panel (sin datos personales)
create table if not exists public.registro_actividad (
  id        bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  rol       text not null,
  accion    text not null,
  detalle   text
);

-- Configuración general (por ahora, la versión de sesiones para "Cerrar todas las sesiones")
create table if not exists public.configuracion (
  clave text primary key,
  valor text not null
);
insert into public.configuracion (clave, valor) values ('version_sesiones', '1')
  on conflict (clave) do nothing;

-- Misma seguridad que el resto: RLS sin políticas, solo el servidor accede
alter table public.registro_actividad enable row level security;
alter table public.configuracion      enable row level security;
