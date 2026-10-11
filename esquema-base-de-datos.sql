-- =====================================================================
-- Sistema de Reservas del CEQ - Estructura de la base de datos (Supabase / PostgreSQL 17)
-- =====================================================================
-- Exportado del proyecto de producción el 11/10/2026 (DB-001 de la auditoría técnica),
-- actualizado con las migraciones del mismo día (migracion-admin-supremo.sql y
-- migracion-funciones-octubre.sql).
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
-- El servidor usa estos números fijos (ver getEspacioNombre en server.js).
-- publico: si se puede reservar desde la página (se cambia en el panel > Avanzado > Espacios).
-- aviso: texto que ve la gente cuando el espacio no está disponible.
-- ---------------------------------------------------------------------
create table public.espacios (
  id          bigint generated always as identity primary key,
  nombre      text not null,
  descripcion text,
  created_at  timestamp default now(),
  publico     boolean not null default false,
  aviso       text
);

-- ---------------------------------------------------------------------
-- RESERVAS
-- contacto: "celular | email" (el servidor valida el formato).
-- estado: 'activa' o 'cancelada'. Las canceladas no ocupan el turno.
-- horario: columna calculada sola a partir de fecha + horas; la usa la regla anti-superposición.
-- codigo_cancelacion: en desuso (los códigos se guardan solo cifrados en codigo_cancelacion_hash,
--   SEC-005). Se mantiene vacía; no volver a usarla.
-- reservado_por_admin: true en las reservas de prioridad creadas desde el panel.
-- cancelada_en / cancelada_por / motivo_cancelacion: cuándo, quién ('usuario', 'moderador' o
--   'admin supremo') y por qué se canceló. Vacías en las canceladas antes del 11/10/2026.
-- recordatorio_enviado_en: cuándo se mandó el recordatorio de 2 días antes (una sola vez).
-- asistencia: 'vino' o 'no_vino', lo marca un moderador en el panel (vacía = sin marcar).
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
  cancelada_en            timestamptz,
  cancelada_por           text,
  motivo_cancelacion      text,
  recordatorio_enviado_en timestamptz,
  asistencia              text,

  constraint reservas_asistencia_valida check (asistencia is null or asistencia in ('vino', 'no_vino')),

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
-- abrir_en: apertura programada; desde esa hora el mes cuenta como habilitado
-- ---------------------------------------------------------------------
create table public.meses_habilitados (
  id         bigint generated always as identity primary key,
  anio       integer not null,
  mes        integer not null check (mes >= 1 and mes <= 12),
  habilitado boolean not null default true,
  created_at timestamp default now(),
  updated_at timestamp default now(),
  abrir_en   timestamptz,
  unique (anio, mes)
);

-- ---------------------------------------------------------------------
-- LISTA DE ESPERA: correos para avisar si se libera un turno que estaba lleno.
-- Un día completo (Altillo) se guarda como 00:00-23:59, igual que en bloqueos.
-- avisado_en: cuándo se avisó (cada inscripción se avisa una sola vez).
-- ---------------------------------------------------------------------
create table public.lista_espera (
  id          bigint generated always as identity primary key,
  espacio_id  bigint not null references public.espacios(id),
  fecha       date not null,
  hora_inicio time not null,
  hora_fin    time not null,
  email       text not null,
  creado_en   timestamptz not null default now(),
  avisado_en  timestamptz,
  unique (espacio_id, fecha, hora_inicio, hora_fin, email)
);
create index idx_lista_espera_dia on public.lista_espera (espacio_id, fecha);

-- ---------------------------------------------------------------------
-- REGISTRO DE ACTIVIDAD del panel (admin supremo > Avanzado > Actividad), sin datos personales
-- ---------------------------------------------------------------------
create table public.registro_actividad (
  id        bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  rol       text not null,
  accion    text not null,
  detalle   text
);

-- ---------------------------------------------------------------------
-- CONFIGURACIÓN general. version_sesiones: al subirla ("Cerrar todas las sesiones"),
-- todas las sesiones abiertas del panel dejan de valer. El resto (turnos del Frente, límite
-- por persona, contacto del Frente, correo de alertas) se edita en admin supremo >
-- Avanzado > Configuración.
-- ---------------------------------------------------------------------
create table public.configuracion (
  clave text primary key,
  valor text not null
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
alter table public.registro_actividad enable row level security;
alter table public.configuracion     enable row level security;
alter table public.lista_espera      enable row level security;

-- ---------------------------------------------------------------------
-- DATOS INICIALES: los 3 espacios con sus números fijos (solo el Frente abierto al público)
-- y la versión inicial de las sesiones del panel
-- ---------------------------------------------------------------------
insert into public.espacios (id, nombre, descripcion, publico, aviso) overriding system value values
  (1, 'Altillo', 'Espacio arriba', false, 'Por el momento, las reservas del Altillo se gestionan de forma manual, ya que la persona encargada actualmente no cuenta con una computadora para administrarlas a través de este sistema.

Para reservar este espacio, anotate en la planilla correspondiente. Cuando se restablezca el acceso, el Altillo va a volver a estar disponible acá.'),
  (2, 'Sala de Reuniones', 'Sala principal', false, null),
  (3, 'Frente', 'Espacio frente', true, null);

insert into public.configuracion (clave, valor) values
  ('version_sesiones', '1'),
  ('turnos_frente', '[{"nombre":"Desayuno","inicio":"07:00","fin":"10:00"},{"nombre":"Almuerzo","inicio":"10:00","fin":"13:00"},{"nombre":"Merienda","inicio":"14:00","fin":"18:00"}]'),
  ('max_reservas_por_persona_mes', '2'),
  ('contacto_email_frente', 'Monsegonza511@gmail.com'),
  ('contacto_whatsapp_frente', '595972753471'),
  ('email_alertas', 'ceq.informatica@gmail.com');

-- Para que un espacio nuevo agregado a mano reciba el número 4 y no choque con los anteriores
select setval(pg_get_serial_sequence('public.espacios', 'id'), 3);
