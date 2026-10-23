-- =====================================================================
-- AUD-14 (auditoría del 23/10/2026): segunda barrera de seguridad y limpieza de lo que no se usa.
-- =====================================================================
-- 1. Quita los permisos que Supabase les da por defecto a los roles públicos (anon y authenticated)
--    sobre las tablas, secuencias y funciones, también para las que se creen en el futuro. Hoy el
--    RLS sin políticas ya bloquea las filas, pero no se aplica a TRUNCATE ni a funciones nuevas:
--    esto cierra la puerta por si algún día se publica la clave pública o se activa otra API de
--    Supabase. El servidor usa la clave service_role, que no cambia.
-- 2. reservas.estado solo puede ser 'activa' o 'cancelada'.
-- 3. Borra lo que está en desuso: la tabla cancelaciones (siempre vacía) y la columna
--    reservas.codigo_cancelacion (vacía: los códigos se guardan solo cifrados en
--    codigo_cancelacion_hash).
--
-- Cómo aplicarla: Supabase > SQL Editor > pegar todo y ejecutar (Run). Va en una sola transacción:
-- si algo falla, no cambia nada. Se puede ejecutar más de una vez sin problema.
-- Antes, conviene comprobar que estas dos consultas den 0 (si no, la migración se frena sola):
--   select count(*) from public.reservas where estado not in ('activa', 'cancelada');
--   select count(*) from public.reservas where codigo_cancelacion is not null;
-- =====================================================================

begin;

-- 1. Permisos de los roles públicos (solo existen en Supabase; en una base de prueba no hace nada)
do $$
declare
  rol text;
begin
  foreach rol in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = rol) then
      execute format('revoke all on all tables in schema public from %I', rol);
      execute format('revoke all on all sequences in schema public from %I', rol);
      execute format('revoke all on all functions in schema public from %I', rol);
      execute format('alter default privileges in schema public revoke all on tables from %I', rol);
      execute format('alter default privileges in schema public revoke all on sequences from %I', rol);
      execute format('alter default privileges in schema public revoke all on functions from %I', rol);
    end if;
  end loop;
end $$;

-- 2. Estado de las reservas
do $$
begin
  if exists (select 1 from public.reservas where estado not in ('activa', 'cancelada')) then
    raise exception 'Hay reservas con un estado distinto de activa o cancelada: revisarlas antes de aplicar esta migración';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reservas_estado_valido') then
    alter table public.reservas add constraint reservas_estado_valido check (estado in ('activa', 'cancelada'));
  end if;
end $$;

-- 3. Lo que está en desuso
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reservas' and column_name = 'codigo_cancelacion') then
    if exists (select 1 from public.reservas where codigo_cancelacion is not null) then
      raise exception 'La columna reservas.codigo_cancelacion tiene datos: no se borra';
    end if;
    alter table public.reservas drop column codigo_cancelacion;
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'cancelaciones') then
    if exists (select 1 from public.cancelaciones) then
      raise exception 'La tabla cancelaciones tiene datos: no se borra';
    end if;
    drop table public.cancelaciones;
  end if;
end $$;

commit;
