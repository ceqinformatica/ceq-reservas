-- =====================================================================
-- Migración: lista de espera con nombre y por mes
-- =====================================================================
-- 1. lista_espera.nombre: el nombre de la persona, para saludarla en los avisos.
--    Las inscripciones anteriores quedan sin nombre (el aviso dice solo "Hola").
-- 2. lista_espera.mes ('2026-11'): el mes que le interesa. Solo se le avisa si se libera un
--    lugar de ESE mes. Las inscripciones anteriores quedan con el mes en que se anotaron.
-- 3. Una inscripción por correo, espacio y mes (antes: por correo y espacio). Así una persona
--    puede anotarse para octubre y para noviembre por separado.
--
-- Se puede correr más de una vez. No borra datos.
-- =====================================================================

alter table public.lista_espera add column if not exists nombre text;
alter table public.lista_espera add column if not exists mes text;
update public.lista_espera set mes = to_char(creado_en at time zone 'America/Asuncion', 'YYYY-MM') where mes is null;
alter table public.lista_espera alter column mes set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lista_espera_mes_valido') then
    alter table public.lista_espera
      add constraint lista_espera_mes_valido check (mes ~ '^\d{4}-(0[1-9]|1[0-2])$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lista_espera_nombre_largo') then
    alter table public.lista_espera
      add constraint lista_espera_nombre_largo check (nombre is null or char_length(nombre) between 2 and 100);
  end if;
  -- La unicidad pasa de (espacio, correo) a (espacio, correo, mes)
  if exists (select 1 from pg_constraint where conname = 'lista_espera_espacio_id_email_key') then
    alter table public.lista_espera drop constraint lista_espera_espacio_id_email_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lista_espera_espacio_email_mes_key') then
    alter table public.lista_espera
      add constraint lista_espera_espacio_email_mes_key unique (espacio_id, email, mes);
  end if;
end $$;
