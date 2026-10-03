/*
  Fase 3 del ciclo de campañas: los envíos pueden usar la campaña que calcula la web.

  - crm_config.campanas_fuente: quién decide a qué campaña pertenece cada oportunidad para los ENVÍOS.
    'bigquery' (por omisión): la campaña que manda BigQuery. 'web': la que calcula la web (crm_campana_calculada).
    Cambiar de fuente lo decide el admin de la sucursal y es reversible.
  - crm_campana_calculada.inicio / hora_envio: desde cuándo cuenta la campaña (los días de cada paso se cuentan desde ahí)
    y, en las campañas por meses, a qué hora sale el primer mensaje.
  - crm_envios.inicio: la fecha de inicio con la que se programó el envío. Queda fija aunque el lead salga después de
    la ventana de la campaña, para que los pasos siguientes de la cadencia se mantengan.
*/

alter table public.crm_config
  add column if not exists campanas_fuente text not null default 'bigquery' check (campanas_fuente in ('bigquery', 'web')),
  add column if not exists campanas_fuente_cambiada_en timestamptz,
  add column if not exists campanas_fuente_cambiada_por uuid;

alter table public.crm_campana_calculada
  add column if not exists inicio date,
  add column if not exists hora_envio time;

alter table public.crm_envios
  add column if not exists inicio date;
