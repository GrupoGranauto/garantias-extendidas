/*
  Primer mensaje automático: una corrida por campaña y día POR CONFIGURACIÓN (pedido de Miguel Borbón, 16-oct-2026).

  Antes había una sola corrida por campaña y día (crm_masivos_automatico_dia_uq): si ya había corrido, cambiar la hora no
  servía hasta el día siguiente. Ahora cada vez que se guarda la configuración de una campaña cuenta como una versión nueva
  (su actualizado_en), y esa versión puede correr una vez ese día a la hora que tenga. No se duplican mensajes: cada corrida
  solo toma a los leads que todavía no recibieron el primer mensaje de su paso, y siguen el límite de un mensaje por teléfono
  al día y D10.

  config_version guarda el actualizado_en de la configuración con la que se armó el masivo. El índice único sigue impidiendo
  que dos procesos armen dos veces la misma corrida.
*/
begin;
set local lock_timeout = '5s';

alter table public.crm_masivos add column if not exists config_version timestamptz;

drop index if exists public.crm_masivos_automatico_dia_uq;
create unique index crm_masivos_automatico_dia_uq
  on public.crm_masivos (sucursal_id, campana, fecha_local, config_version) where automatico;

commit;

-- Reversa (solo si no hay dos masivos automáticos de la misma campaña el mismo día):
--   drop index public.crm_masivos_automatico_dia_uq;
--   create unique index crm_masivos_automatico_dia_uq on public.crm_masivos (sucursal_id, campana, fecha_local) where automatico;
--   alter table public.crm_masivos drop column config_version;
