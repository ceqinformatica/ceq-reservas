-- =====================================================================
-- Sistema de Reservas del CEQ - Estructura de la base de datos (Supabase / PostgreSQL 17)
-- =====================================================================
-- Exportado del proyecto de producción el 11/10/2026 (DB-001 de la auditoría técnica).
-- Contiene SOLO la estructura (tablas, reglas, triggers y seguridad) y los 3 espacios.
-- No contiene reservas ni datos personales.
--
-- Para recrear la base desde cero (por ejemplo, en un proyecto nuevo de Supabase):
--   1. Supabase > SQL Editor > New query.
--   2. Pegar este archivo completo y ejecutarlo (Run). Se puede ejecutar una sola vez
--      sobre una base vacía.
--   3. En Render, actualizar SUPABASE_URL y SUPABASE_KEY (clave service_role) del proyecto nuevo.
--   4. Desde el panel de admin, habilitar los meses que correspondan.
--
-- Si se cambia la estructura en Supabase, actualizar también este archivo.
-- =====================================================================

-- Necesaria para la regla anti-superposición (EXCLUDE con "=" sobre espacio_id)
create extension if not exists btree_gist with schema public;

-- ---------------------------------------------------------------------
-- ESPACIOS: 1 = Altillo, 2 = Sala de Reuniones, 3 = Frente.
-- El servidor usa estos números fijos (ver getEspacioNombre y ESPACIOS_PUBLICOS en server.js).
-- ---------------------------------------------------------------------
create table public.espacios (
  id          bigint generated always as identity primary key,
  nombre      text not null,
  descripcion text,
  created_at  timestamp default now()
);

-- ---------------------------------------------------------------------
-- RESERVAS
-- contacto: "celular | email" (el servidor valida el formato).
-- estado: 'activa' o 'cancelada'. Las canceladas no ocupan el turno.
-- horario: columna calculada sola a partir de fecha + horas; la usa la regla anti-superposición.
-- codigo_cancelacion: en desuso (los códigos se guardan solo cifrados en codigo_cancelacion_hash,
--   SEC-005). Se mantiene vacía; no volver a usarla.
-- reservado_por_admin: true en las reservas de prioridad creadas desde el panel.
-- ---------------------------------------------------------------------
create table public.reservas (
  id                      bigint generated always as identity primary key,
  espacio_id              bigint references public.espacios(id),
  nombre_solicitante      text not null,
  contacto                text not null,
  fecha                   date not null,
  hora_inicio             time not null,
  hora_fin                time not null,
  estado                  text default 'activa',
  motivo                  text default '',
  codigo_cancelacion      text unique,
  created_at              timestamp default now(),
  updated_at              timestamp default now(),
  horario                 tsrange generated always as (tsrange(fecha + hora_inicio, fecha + hora_fin, '[)')) stored,
  codigo_cancelacion_hash text,
  reservado_por_admin     boolean not null default false,

  -- Garantía principal del sistema: dos reservas ACTIVAS del mismo espacio no pueden
  -- superponerse en el tiempo. La base lo rechaza aunque lleguen al mismo instante
  -- (código de error 23P01, que el servidor muestra como "Horario no disponible").
  -- '[)' hace que los turnos contiguos (07-10 y 10-13) no choquen.
  constraint no_solapamiento_activo
    exclude using gist (espacio_id with =, horario with &&) where (estado = 'activa')
);

-- Un mismo código cifrado no puede repetirse entre reservas
create unique index idx_codigo_cancelacion_hash on public.reservas (codigo_cancelacion_hash)
  where codigo_cancelacion_hash is not null;

-- ---------------------------------------------------------------------
-- BLOQUEOS: horarios o días completos que el admin cierra (00:00-23:59 = todo el día)
-- ---------------------------------------------------------------------
create table public.bloqueos (
  id          bigint generated always as identity primary key,
  espacio_id  bigint references public.espacios(id),
  fecha       date not null,
  hora_inicio time not null,
  hora_fin    time not null,
  motivo      text default '',
  created_at  timestamp default now(),
  unique (espacio_id, fecha, hora_inicio)
);

-- ---------------------------------------------------------------------
-- CANCELACIONES: tabla en desuso (el servidor actual no la usa; el estado de la
-- cancelación queda en reservas.estado). Se mantiene por compatibilidad.
-- ---------------------------------------------------------------------
create table public.cancelaciones (
  id                bigint generated always as identity primary key,
  reserva_id        bigint references public.reservas(id),
  motivo            text,
  aplica_multa      boolean default false,
  fecha_cancelacion timestamp default now()
);

-- ---------------------------------------------------------------------
-- REPORTES DE ERRORES: los envía la opción "Reportar un problema" de la página
-- ---------------------------------------------------------------------
create table public.reportes_errores (
  id         bigint generated always as identity primary key,
  mensaje    text not null,
  url        text,
  navegador  text,
  leido      boolean default false,
  created_at timestamp default now()
);

-- ---------------------------------------------------------------------
-- MESES HABILITADOS: qué meses se pueden reservar desde la página pública
-- (se manejan desde el panel de admin > Meses; tienen que quedar consecutivos)
-- ---------------------------------------------------------------------
create table public.meses_habilitados (
  id         bigint generated always as identity primary key,
  anio       integer not null,
  mes        integer not null check (mes >= 1 and mes <= 12),
  habilitado boolean not null default true,
  created_at timestamp default now(),
  updated_at timestamp default now(),
  unique (anio, mes)
);

-- ---------------------------------------------------------------------
-- TRIGGERS: impiden, de forma atómica, una reserva sobre un bloqueo y un bloqueo
-- sobre una reserva activa (el servidor también lo revisa antes, pero esta es la
-- garantía final si las dos cosas pasan en el mismo instante).
-- El bloqueo por espacio+fecha (pg_advisory_xact_lock) hace que dos operaciones
-- simultáneas sobre el mismo día se ejecuten una después de la otra.
-- ---------------------------------------------------------------------

-- Reserva sobre un horario bloqueado -> error CEQ01 ("bloqueado por administración")
create or replace function public.verificar_sin_bloqueo_antes_de_reservar()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  hay_conflicto boolean;
begin
  if NEW.estado <> 'activa' or NEW.espacio_id is null then
    return NEW;
  end if;

  -- Lock exclusivo por espacio+fecha (se libera solo al final de la transacción)
  perform pg_advisory_xact_lock(NEW.espacio_id::int, (NEW.fecha - date '2000-01-01')::int);

  select exists (
    select 1 from bloqueos b
    where b.espacio_id = NEW.espacio_id
      and b.fecha = NEW.fecha
      and NEW.hora_inicio < b.hora_fin
      and NEW.hora_fin > b.hora_inicio
  ) into hay_conflicto;

  if hay_conflicto then
    raise exception 'Horario bloqueado por administración'
      using errcode = 'CEQ01';
  end if;

  return NEW;
end;
$function$;

-- Bloqueo sobre una reserva activa -> error CEQ02 ("ya hay una reserva activa")
create or replace function public.verificar_sin_reserva_antes_de_bloquear()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  hay_conflicto boolean;
begin
  if NEW.espacio_id is null then
    return NEW;
  end if;

  perform pg_advisory_xact_lock(NEW.espacio_id::int, (NEW.fecha - date '2000-01-01')::int);

  select exists (
    select 1 from reservas r
    where r.espacio_id = NEW.espacio_id
      and r.fecha = NEW.fecha
      and r.estado = 'activa'
      and NEW.hora_inicio < r.hora_fin
      and NEW.hora_fin > r.hora_inicio
  ) into hay_conflicto;

  if hay_conflicto then
    raise exception 'Ya hay una reserva activa en ese horario'
      using errcode = 'CEQ02';
  end if;

  return NEW;
end;
$function$;

create trigger trg_verificar_bloqueo_reserva
  before insert or update of estado, fecha, hora_inicio, hora_fin on public.reservas
  for each row execute function public.verificar_sin_bloqueo_antes_de_reservar();

create trigger trg_verificar_reserva_bloqueo
  before insert on public.bloqueos
  for each row execute function public.verificar_sin_reserva_antes_de_bloquear();

-- ---------------------------------------------------------------------
-- SEGURIDAD: RLS activado SIN políticas en todas las tablas. Así nadie puede leer
-- ni escribir directamente con las claves públicas de Supabase; solo el servidor,
-- que usa la clave service_role (variable SUPABASE_KEY en Render). No agregar
-- políticas públicas ni poner esa clave en las páginas.
-- ---------------------------------------------------------------------
alter table public.espacios          enable row level security;
alter table public.reservas          enable row level security;
alter table public.bloqueos          enable row level security;
alter table public.cancelaciones     enable row level security;
alter table public.reportes_errores  enable row level security;
alter table public.meses_habilitados enable row level security;

-- ---------------------------------------------------------------------
-- DATOS INICIALES: los 3 espacios con sus números fijos
-- ---------------------------------------------------------------------
insert into public.espacios (id, nombre, descripcion) overriding system value values
  (1, 'Altillo', 'Espacio arriba'),
  (2, 'Sala de Reuniones', 'Sala principal'),
  (3, 'Frente', 'Espacio frente');

-- Para que un espacio nuevo agregado a mano reciba el número 4 y no choque con los anteriores
select setval(pg_get_serial_sequence('public.espacios', 'id'), 3);
