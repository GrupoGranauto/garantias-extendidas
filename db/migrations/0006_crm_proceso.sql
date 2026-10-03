/* 0006: bloque de proceso del CRM.
   - Disparador por tiempo ("después de N horas en la etapa") además de "al entrar".
   - Regla por sucursal: exigir evidencia (certificado entregado) antes de marcar una venta.
   - Índices para la línea de tiempo y los reportes. */

alter table public.crm_config
  add column if not exists exigir_evidencia_venta boolean not null default false;

alter table public.crm_automatizaciones drop constraint if exists crm_automatizaciones_evento_check;
alter table public.crm_automatizaciones
  add constraint crm_automatizaciones_evento_check check (evento in ('entra_etapa', 'tiempo_en_etapa'));

-- Una ejecución por tiempo no nace de un evento: se identifica por el "ciclo" (el instante en que la
-- oportunidad entró a la etapa), así si sale y vuelve a entrar la regla puede correr otra vez.
alter table public.crm_ejecuciones alter column evento_id drop not null;
alter table public.crm_ejecuciones add column if not exists ciclo timestamptz;
create unique index if not exists crm_ejecuciones_ciclo_uk
  on public.crm_ejecuciones (automatizacion_id, oportunidad_id, ciclo) where ciclo is not null;

create index if not exists crm_actividades_oportunidad_idx on public.crm_actividades (oportunidad_id, creado_en desc);
create index if not exists crm_actividades_sucursal_idx on public.crm_actividades (sucursal_id, creado_en desc);
create index if not exists crm_historial_sucursal_idx on public.crm_historial_etapas (sucursal_id, creado_en desc);
create index if not exists crm_oportunidades_etapa_idx on public.crm_oportunidades (etapa_id, posicion);
