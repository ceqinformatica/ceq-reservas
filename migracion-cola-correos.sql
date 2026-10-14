-- =====================================================================
-- Migración: cola de correos con reintentos (CEQ-06)
-- =====================================================================
-- Los correos de las reservas se guardan acá antes de mandarse. Si Brevo falla, el servidor
-- los reintenta (1, 5, 15, 60 y 180 minutos); si el servidor se reinicia, los retoma.
-- Cuando un correo sale (o se da por perdido) se borra su contenido, y la fila se borra a los
-- 7 días. Mismo esquema de seguridad que el resto: RLS sin políticas, solo el servidor accede.
--
-- Se puede correr más de una vez. No modifica datos existentes.
-- =====================================================================

create table if not exists public.correos_pendientes (
  id              bigint generated always as identity primary key,
  destinatarios   jsonb not null default '[]'::jsonb,
  asunto          text not null,
  html            text not null default '',
  texto           text,
  responder_a     text,
  estado          text not null default 'pendiente',
  intentos        integer not null default 0,
  proximo_intento timestamptz not null default now(),
  reclamado_hasta timestamptz,
  ultimo_error    text,
  creado_en       timestamptz not null default now(),
  enviado_en      timestamptz,
  constraint correos_estado_valido check (estado in ('pendiente', 'enviando', 'enviado', 'fallido'))
);

create index if not exists idx_correos_pendientes_estado on public.correos_pendientes (estado, proximo_intento);

alter table public.correos_pendientes enable row level security;
