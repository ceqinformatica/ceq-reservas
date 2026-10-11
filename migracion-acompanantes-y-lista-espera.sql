-- =====================================================================
-- Migración "acompañantes y lista de espera general" (11/10/2026)
-- Ya está incluida en esquema-base-de-datos.sql.
-- =====================================================================

-- 1) Acompañantes: hasta 4 por reserva, solo en el Altillo (espacio 1):
--    [{"nombre": "...", "celular": "..."}]. Vacía = ninguno. Solo AGREGA una columna.
alter table public.reservas
  add column if not exists acompanantes jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reservas_acompanantes_validos') then
    alter table public.reservas
      add constraint reservas_acompanantes_validos
      check (jsonb_typeof(acompanantes) = 'array' and jsonb_array_length(acompanantes) <= 4
             and (espacio_id = 1 or jsonb_array_length(acompanantes) = 0));
  end if;
end $$;

-- 2) Lista de espera GENERAL: ya no es por día y turno sino por espacio. Una inscripción por
--    correo y espacio; si alguien cancela cualquier reserva de ese espacio, se avisa a todos.
--    La tabla anterior (por día) nunca se usó: si tuviera datos, la migración se detiene sin
--    cambiar nada.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'lista_espera' and column_name = 'fecha') then
    if exists (select 1 from public.lista_espera) then
      raise exception 'lista_espera tiene datos: revisar antes de migrar';
    end if;
    drop table public.lista_espera;
  end if;
end $$;

create table if not exists public.lista_espera (
  id          bigint generated always as identity primary key,
  espacio_id  bigint not null references public.espacios(id),
  email       text not null,
  creado_en   timestamptz not null default now(),
  avisado_en  timestamptz,
  unique (espacio_id, email)
);
alter table public.lista_espera enable row level security;
