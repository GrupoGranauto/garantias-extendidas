/*
  Estados de cartera «Vendida por el BDC» y «Descartado» (decisión del 16-oct-2026, Miguel Borbón).

  - VENDIDA_BDC: el BDC vendió la garantía extendida desde la web. Cuenta para el BDC aunque después el sistema de ventas
    la registre; «Ya tiene GE» (YA_TIENE_GE) queda solo para la garantía vendida fuera de la web.
  - DESCARTADO: el vehículo tiene un descarte vigente en la web (ya no tiene el auto, flotilla, uso no elegible, fuera de
    km o tiempo) y salió de cartera por eso.

  Los usa el estado de cartera del lead y el motivo con que se cierra un paso de campaña. La sincronización los pone con
  lo que sabe la web y, cuando la base maestra cruce el envío nocturno de la web, con lo que diga la base maestra.
  Solo amplía las listas permitidas: no cambia ningún dato.
*/
begin;
set local lock_timeout = '5s';

alter table public.crm_oportunidades drop constraint crm_oportunidades_estado_cartera_check;
alter table public.crm_oportunidades add constraint crm_oportunidades_estado_cartera_check
  check (estado_cartera in ('ACTIVA', 'YA_TIENE_GE', 'VENDIDA_BDC', 'DESCARTADO', 'NO_CONTACTABLE_FUENTE',
                            'FUERA_DE_VENTANA', 'NO_EN_MAESTRA'));

alter table public.crm_oportunidad_campanas drop constraint crm_oportunidad_campanas_motivo_cierre_check;
alter table public.crm_oportunidad_campanas add constraint crm_oportunidad_campanas_motivo_cierre_check
  check (motivo_cierre in ('CAMBIO_CAMPANA', 'FUERA_DE_VENTANA', 'YA_TIENE_GE', 'VENDIDA_BDC', 'DESCARTADO',
                           'NO_CONTACTABLE_FUENTE', 'NO_EN_MAESTRA'));

commit;

-- Reversa (solo si ningún lead ni paso usa los valores nuevos):
--   alter table public.crm_oportunidades drop constraint crm_oportunidades_estado_cartera_check;
--   alter table public.crm_oportunidades add constraint crm_oportunidades_estado_cartera_check
--     check (estado_cartera in ('ACTIVA', 'YA_TIENE_GE', 'NO_CONTACTABLE_FUENTE', 'FUERA_DE_VENTANA', 'NO_EN_MAESTRA'));
--   alter table public.crm_oportunidad_campanas drop constraint crm_oportunidad_campanas_motivo_cierre_check;
--   alter table public.crm_oportunidad_campanas add constraint crm_oportunidad_campanas_motivo_cierre_check
--     check (motivo_cierre in ('CAMBIO_CAMPANA', 'FUERA_DE_VENTANA', 'YA_TIENE_GE', 'NO_CONTACTABLE_FUENTE', 'NO_EN_MAESTRA'));
