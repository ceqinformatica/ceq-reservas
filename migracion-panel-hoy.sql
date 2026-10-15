-- =====================================================================
-- Migración: bloqueos de varios días y estados de los reportes
-- =====================================================================
-- 1. bloqueos.lote: los bloqueos creados juntos ("varios días") comparten un mismo lote, así se
--    pueden borrar todos juntos. Los bloqueos de un solo día lo tienen vacío.
-- 2. reportes_errores.estado y .nota: cada reporte pasa por nuevo → en revisión → resuelto, con
--    una nota de lo que se hizo. Los reportes ya marcados como leídos quedan como "resuelto".
--
-- Se puede correr más de una vez. No borra datos.
-- =====================================================================

alter table public.bloqueos add column if not exists lote text;
create index if not exists idx_bloqueos_lote on public.bloqueos (lote) where lote is not null;

alter table public.reportes_errores add column if not exists estado text not null default 'nuevo';
alter table public.reportes_errores add column if not exists nota text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reportes_estado_valido') then
    alter table public.reportes_errores
      add constraint reportes_estado_valido check (estado in ('nuevo', 'en_revision', 'resuelto'));
  end if;
end $$;
update public.reportes_errores set estado = 'resuelto' where leido = true and estado = 'nuevo';
