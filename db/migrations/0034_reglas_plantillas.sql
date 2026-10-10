/*
  A quién se le puede mandar cada plantilla en un masivo (decisión del usuario, 2026-10-10). Cada lista vacía = cualquiera:
  - campanas: códigos de campaña del lead (48H, 5M, 12M_NURTURING, 28M…). Sin campañas, la plantilla es «General».
  - estados: estados del lead (crm_etapas).
  - resultados: Resultado BDC.
  - etapas_vehiculo: etapa del vehículo (crm_ciclo_etapas).
  Un lead que no cumple las reglas de la plantilla se omite del masivo y se avisa por qué.
*/

create table public.crm_plantilla_reglas (
  plantilla_id uuid primary key references public.whatsapp_plantillas(id) on delete cascade,
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  campanas text[] not null default '{}',
  estados uuid[] not null default '{}',
  resultados text[] not null default '{}',
  etapas_vehiculo uuid[] not null default '{}',
  actualizado_en timestamptz not null default now()
);
create index crm_plantilla_reglas_sucursal_idx on public.crm_plantilla_reglas (sucursal_id);

alter table public.crm_plantilla_reglas enable row level security;
revoke all on public.crm_plantilla_reglas from anon, authenticated;
