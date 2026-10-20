-- 19/10/2026: los acompañantes se configuran por espacio desde el admin supremo (Reglas).
-- Antes la base solo los aceptaba en el Altillo y hasta 4; ahora solo exige que sea una lista de
-- hasta 10. Cuántos se permiten en cada espacio lo controla el servidor con las Reglas
-- (por defecto: Altillo 4, Frente 0, igual que antes). No modifica ninguna reserva.
alter table public.reservas drop constraint reservas_acompanantes_validos;
alter table public.reservas add constraint reservas_acompanantes_validos
  check (jsonb_typeof(acompanantes) = 'array' and jsonb_array_length(acompanantes) <= 10);
