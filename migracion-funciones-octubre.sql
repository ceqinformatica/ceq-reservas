-- =====================================================================
-- Migración "funciones de octubre" (11/10/2026)
-- Solo AGREGA columnas, una tabla y valores de configuración: no borra ni cambia datos.
-- Ya está incluida en esquema-base-de-datos.sql; este archivo queda como registro del cambio.
-- =====================================================================

-- Apertura programada: el mes se abre solo a esta hora (panel > Meses)
alter table public.meses_habilitados
  add column if not exists abrir_en timestamptz;

-- Recordatorio 2 días antes (cuándo se mandó) y asistencia marcada en el panel
alter table public.reservas
  add column if not exists recordatorio_enviado_en timestamptz,
  add column if not exists asistencia text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reservas_asistencia_valida') then
    alter table public.reservas
      add constraint reservas_asistencia_valida check (asistencia is null or asistencia in ('vino', 'no_vino'));
  end if;
end $$;

-- Lista de espera: correos para avisar si se libera un turno lleno.
-- Para un día completo (Altillo) se usa 00:00-23:59, igual que en bloqueos.
create table if not exists public.lista_espera (
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
create index if not exists idx_lista_espera_dia on public.lista_espera (espacio_id, fecha);
alter table public.lista_espera enable row level security;

-- Configuración editable por el admin supremo (mismos valores que estaban fijos en el código)
insert into public.configuracion (clave, valor) values
  ('turnos_frente', '[{"nombre":"Desayuno","inicio":"07:00","fin":"10:00"},{"nombre":"Almuerzo","inicio":"10:00","fin":"13:00"},{"nombre":"Merienda","inicio":"14:00","fin":"18:00"}]'),
  ('max_reservas_por_persona_mes', '2'),
  ('contacto_email_frente', 'Monsegonza511@gmail.com'),
  ('contacto_whatsapp_frente', '595972753471'),
  ('email_alertas', 'ceq.informatica@gmail.com')
on conflict (clave) do nothing;
