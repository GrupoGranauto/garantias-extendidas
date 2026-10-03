/*
  Fase 4 del ciclo de campañas: seguimientos después del primer contacto automático.

  Un seguimiento dice: «N horas/días después del primer (o último) mensaje de una campaña, si se cumplen estas
  condiciones, haz esto»: crear una tarea, agendar una llamada (una tarea con fecha y hora) o mandar otro WhatsApp.

  - crm_seguimientos: las reglas. Nacen apagadas.
  - crm_seguimiento_ejecuciones: una fila por (seguimiento, oportunidad): cuándo le toca, qué pasó y por qué.
    Su unicidad evita que un seguimiento corra dos veces para la misma oportunidad.
  - crm_envios.seguimiento_id: un envío de WhatsApp puede venir de un seguimiento y no de un paso de la campaña.
  - crm_tareas.seguimiento_id: de qué seguimiento salió la tarea.
*/

create table if not exists public.crm_seguimientos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  campana text not null,
  orden integer not null,
  nombre text not null,
  activa boolean not null default false,
  desde text not null default 'primer_envio' check (desde in ('primer_envio', 'ultimo_envio')),
  espera_horas integer not null default 24 check (espera_horas between 0 and 8760),
  accion text not null check (accion in ('tarea', 'llamada', 'whatsapp')),
  condiciones jsonb not null default '[]'::jsonb,
  titulo text,
  descripcion text,
  vence_horas integer check (vence_horas between 0 and 8760),
  hora time,
  plantilla_id uuid references public.whatsapp_plantillas(id) on delete set null,
  vigencia_horas integer not null default 48 check (vigencia_horas between 0 and 1440),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (sucursal_id, campana, orden)
);
create index if not exists crm_seguimientos_idx on public.crm_seguimientos (sucursal_id, campana);

create table if not exists public.crm_seguimiento_ejecuciones (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  seguimiento_id uuid not null references public.crm_seguimientos(id) on delete cascade,
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  referencia_en timestamptz not null,
  programado_para timestamptz not null,
  simulada boolean not null default false,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'hecho', 'omitido', 'simulado')),
  motivo text,
  tarea_id uuid references public.crm_tareas(id) on delete set null,
  envio_id uuid references public.crm_envios(id) on delete set null,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (seguimiento_id, oportunidad_id)
);
create index if not exists crm_seg_ejec_cola_idx on public.crm_seguimiento_ejecuciones (programado_para) where estado = 'pendiente';
create index if not exists crm_seg_ejec_sucursal_idx on public.crm_seguimiento_ejecuciones (sucursal_id, actualizado_en desc);

alter table public.crm_envios
  alter column paso_id drop not null,
  add column if not exists seguimiento_id uuid references public.crm_seguimientos(id) on delete cascade;
alter table public.crm_envios
  add constraint crm_envios_origen_chk check (paso_id is not null or seguimiento_id is not null);
create unique index if not exists crm_envios_seguimiento_uq on public.crm_envios (oportunidad_id, seguimiento_id) where seguimiento_id is not null;

alter table public.crm_tareas
  add column if not exists seguimiento_id uuid references public.crm_seguimientos(id) on delete set null;

alter table public.crm_seguimientos enable row level security;
alter table public.crm_seguimiento_ejecuciones enable row level security;
revoke all on public.crm_seguimientos, public.crm_seguimiento_ejecuciones from anon, authenticated;

create trigger crm_seguimientos_tocar before update on public.crm_seguimientos
for each row execute function public.crm_tocar();
create trigger crm_seguimiento_ejecuciones_tocar before update on public.crm_seguimiento_ejecuciones
for each row execute function public.crm_tocar();
