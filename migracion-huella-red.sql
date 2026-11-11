-- Migración: huella de la red de cada reserva (detector de abusos) — 10/11/2026
--
-- Agrega la columna reservas.huella_red. Guarda una huella cifrada (HMAC) de la red desde la que
-- se hizo la reserva: NO la dirección IP, y no se puede volver atrás. Sirve solo para que el
-- "Detector de abusos" del panel avise cuando desde una misma conexión reservan varias personas
-- distintas. Se borra junto con los demás datos personales a los 6 meses.
--
-- El servidor funciona igual sin esta columna (el detector solo pierde esa señal), así que se
-- puede aplicar antes o después de subir el servidor.
--
-- Cómo aplicarla: Supabase > SQL Editor > pegar y ejecutar. Se puede correr más de una vez.

alter table public.reservas add column if not exists huella_red text;

comment on column public.reservas.huella_red is
  'Huella cifrada (HMAC) de la red desde la que se reservó. No es la dirección IP. Se borra a los 6 meses.';
