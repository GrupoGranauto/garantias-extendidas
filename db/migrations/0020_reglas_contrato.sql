/*
  Fase C: pago y cierre automáticos.

  - crm_reglas_contrato: «cuando un contrato lleva N horas en el estado X, crea esta tarea para el ejecutivo». Nacen apagadas.
    Ejemplos: orden de pago a las 20 h (la liga de pago dura 24 h), a las 25 h (reemitir) y certificado entregado + 24 h (facturar).
  - crm_regla_contrato_ejecuciones: una fila por (regla, oportunidad, momento en que el contrato entró al estado). Si el contrato
    sale del estado y vuelve a entrar, empieza otro ciclo; dentro del mismo, la regla corre una sola vez.
  - crm_tareas.regla_contrato_id: de qué regla salió la tarea.
  - crm_config.cobertura_automatica: cuando hoy ≥ fecha de factura + 36 meses (fin de la garantía original), los contratos en
    «Certificado entregado» pasan solos a «Cobertura iniciada».
*/

create table if not exists public.crm_reglas_contrato (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  orden integer not null,
  nombre text not null,
  activa boolean not null default false,
  estado text not null check (estado in ('cotizado', 'aceptado', 'orden_pago', 'pago_confirmado', 'certificado_entregado', 'cobertura_iniciada')),
  espera_horas integer not null default 24 check (espera_horas between 0 and 8760),
  titulo text not null,
  descripcion text,
  vence_horas integer check (vence_horas between 0 and 8760),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (sucursal_id, orden)
);

create table if not exists public.crm_regla_contrato_ejecuciones (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  regla_id uuid not null references public.crm_reglas_contrato(id) on delete cascade,
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  estado_desde timestamptz not null,
  programado_para timestamptz not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'hecho', 'omitido')),
  motivo text,
  tarea_id uuid references public.crm_tareas(id) on delete set null,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (regla_id, oportunidad_id, estado_desde)
);
create index if not exists crm_reg_con_ejec_cola_idx on public.crm_regla_contrato_ejecuciones (programado_para) where estado = 'pendiente';
create index if not exists crm_reg_con_ejec_sucursal_idx on public.crm_regla_contrato_ejecuciones (sucursal_id, actualizado_en desc);

alter table public.crm_tareas
  add column if not exists regla_contrato_id uuid references public.crm_reglas_contrato(id) on delete set null;

alter table public.crm_config
  add column if not exists cobertura_automatica boolean not null default true;

alter table public.crm_reglas_contrato enable row level security;
alter table public.crm_regla_contrato_ejecuciones enable row level security;
revoke all on public.crm_reglas_contrato, public.crm_regla_contrato_ejecuciones from anon, authenticated;

create trigger crm_reglas_contrato_tocar before update on public.crm_reglas_contrato
for each row execute function public.crm_tocar();
create trigger crm_regla_contrato_ejecuciones_tocar before update on public.crm_regla_contrato_ejecuciones
for each row execute function public.crm_tocar();
