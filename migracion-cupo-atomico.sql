-- =====================================================================
-- Migración: límite de reservas por persona contado y guardado en un solo paso (CEQ-02)
-- =====================================================================
-- Antes, el servidor contaba las reservas del mes de la persona y después guardaba la nueva
-- en otro pedido aparte. Si llegaban varios pedidos al mismo tiempo (por ejemplo, desde varias
-- pestañas), todos contaban "0" y todos se guardaban, pasando el límite.
--
-- Esta función hace las dos cosas dentro de una misma transacción y con un candado por
-- espacio y mes: mientras una reserva de ese espacio y ese mes se está guardando, la
-- siguiente espera su turno, y cuando cuenta ya ve la anterior.
--
-- - Solo cuenta si p_limite no es null (el servidor lo manda solo para el Frente).
-- - No cuentan las canceladas ni las de prioridad del panel (reservado_por_admin).
-- - La persona se reconoce por correo O por los últimos 9 dígitos del celular, igual que
--   identidadContacto() del servidor.
-- - Si ya llegó al límite, lanza el error CEQ03 con la cantidad en el mensaje.
-- - Sigue valiendo todo lo demás de la tabla: la regla anti-superposición (23P01) y los
--   triggers de bloqueos (CEQ01).
--
-- Se puede correr más de una vez (create or replace). No modifica datos.
-- =====================================================================

create or replace function public.crear_reserva_con_cupo(
  p_espacio_id   bigint,
  p_nombre       text,
  p_contacto     text,
  p_fecha        date,
  p_hora_inicio  time,
  p_hora_fin     time,
  p_motivo       text,
  p_codigo_hash  text,
  p_acompanantes jsonb,
  p_limite       integer,
  p_email        text,
  p_celular      text
)
returns setof public.reservas
language plpgsql
set search_path = public
as $$
declare
  v_desde    date := date_trunc('month', p_fecha)::date;
  v_hasta    date := (date_trunc('month', p_fecha) + interval '1 month')::date;
  v_cantidad integer;
begin
  if p_limite is not null then
    -- Candado de esta transacción por espacio y mes. La segunda clave es negativa para no
    -- chocar con los candados por espacio y día de los triggers de bloqueos (que son positivos).
    perform pg_advisory_xact_lock(p_espacio_id::int,
      -(extract(year from p_fecha)::int * 12 + extract(month from p_fecha)::int));

    select count(*) into v_cantidad
      from public.reservas r
     where r.estado = 'activa'
       and r.espacio_id = p_espacio_id
       and r.fecha >= v_desde and r.fecha < v_hasta
       and r.reservado_por_admin = false
       and (
         (p_email is not null and nullif(lower(trim(split_part(r.contacto, '|', 2))), '') = p_email)
         or
         (p_celular is not null and (
            select case when length(d) >= 6 then right(d, 9) end
              from (select regexp_replace(split_part(r.contacto, '|', 1), '\D', '', 'g') as d) x
          ) = p_celular)
       );

    if v_cantidad >= p_limite then
      raise exception using errcode = 'CEQ03', message = v_cantidad::text;
    end if;
  end if;

  return query
    insert into public.reservas
      (espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, estado, motivo,
       codigo_cancelacion_hash, acompanantes)
    values
      (p_espacio_id, p_nombre, p_contacto, p_fecha, p_hora_inicio, p_hora_fin, 'activa',
       coalesce(p_motivo, ''), p_codigo_hash, coalesce(p_acompanantes, '[]'::jsonb))
    returning *;
end;
$$;

-- Solo el servidor (service_role) puede usarla: nadie desde afuera llama a la base directo.
-- (Los roles anon/authenticated/service_role son de Supabase; en una base de prueba sin
-- esos roles, este bloque no hace nada más que el revoke de public.)
revoke all on function public.crear_reserva_con_cupo(bigint, text, text, date, time, time, text, text, jsonb, integer, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.crear_reserva_con_cupo(bigint, text, text, date, time, time, text, text, jsonb, integer, text, text) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.crear_reserva_con_cupo(bigint, text, text, date, time, time, text, text, jsonb, integer, text, text) to service_role';
  end if;
end $$;
