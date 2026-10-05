/*
  Fase 5 del ciclo de campañas: activación gradual.

  - piloto_agencias: si no está vacío, la campaña solo manda a leads de esas agencias (el resto espera y, si pasa su
    vigencia, se omite con el motivo «fuera del piloto»). Vacío = todas las agencias.
  - rampa_*: el tope diario crece solo desde `rampa_inicial` y sube `rampa_incremento` cada día desde el primer envío
    real de la campaña, sin pasar de max_por_dia.
*/

alter table public.crm_campanas_envio
  add column if not exists piloto_agencias text[] not null default '{}',
  add column if not exists rampa_activa boolean not null default false,
  add column if not exists rampa_inicial integer not null default 20 check (rampa_inicial between 1 and 5000),
  add column if not exists rampa_incremento integer not null default 20 check (rampa_incremento between 0 and 5000);
