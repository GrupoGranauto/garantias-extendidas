/*
  Fase 2 del ciclo de campañas: las campañas las define el usuario y las calcula la web.

  - crm_campanas_def: la regla de cada campaña (por días o por meses, columna de fecha, etapa del vehículo opcional).
    El nombre es el mismo que usa la configuración de envío (crm_campanas_envio.campana).
  - crm_config: a qué hora del día se calculan las campañas y cuándo fue el último cálculo.
  - crm_campana_calculada: la campaña que la web calculó para cada oportunidad (una fila por oportunidad).
    En esta fase corre en modo sombra: se compara contra la campaña de BigQuery y no cambia envíos.
  - crm_campana_calculos: bitácora de cada corrida del cálculo.
*/

create table if not exists public.crm_campanas_def (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  orden integer not null,
  nombre text not null,
  tipo text not null check (tipo in ('dias', 'meses')),
  columna_fecha text not null default 'fecha_factura' check (columna_fecha in ('fecha_factura', 'fecha_reporte')),
  dias_desde integer check (dias_desde between 0 and 3650),
  dias_hasta integer check (dias_hasta between 1 and 3650),
  meses_atras integer check (meses_atras between 0 and 120),
  dia_envio integer check (dia_envio between 1 and 28),
  hora_envio time,
  etapa_orden integer check (etapa_orden between 1 and 10),
  activa boolean not null default true,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (sucursal_id, nombre),
  unique (sucursal_id, orden),
  check (tipo <> 'dias' or (dias_desde is not null and dias_hasta is not null and dias_hasta > dias_desde)),
  check (tipo <> 'meses' or (meses_atras is not null and dia_envio is not null and hora_envio is not null))
);

alter table public.crm_config
  add column if not exists campanas_calculo_hora time not null default '06:00',
  add column if not exists campanas_calculo_ultimo date;

create table if not exists public.crm_campana_calculada (
  oportunidad_id uuid primary key references public.crm_oportunidades(id) on delete cascade,
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  campana_def_id uuid references public.crm_campanas_def(id) on delete cascade,
  campana text not null,
  calculada_en timestamptz not null default now()
);
create index if not exists crm_campana_calculada_idx on public.crm_campana_calculada (sucursal_id, campana);

create table if not exists public.crm_campana_calculos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  fecha date not null,
  origen text not null check (origen in ('programado', 'manual', 'al_guardar')),
  evaluadas integer not null default 0,
  asignadas integer not null default 0,
  traslapes integer not null default 0,
  ejecutado_en timestamptz not null default now()
);
create index if not exists crm_campana_calculos_idx on public.crm_campana_calculos (sucursal_id, ejecutado_en desc);

alter table public.crm_campanas_def enable row level security;
alter table public.crm_campana_calculada enable row level security;
alter table public.crm_campana_calculos enable row level security;
revoke all on public.crm_campanas_def, public.crm_campana_calculada, public.crm_campana_calculos from anon, authenticated;

create trigger crm_campanas_def_tocar before update on public.crm_campanas_def
for each row execute function public.crm_tocar();
