/* 0005: automatizaciones por etapa, tareas/preguntas del ejecutivo, y bandeja de eventos (outbox).

   Modelo: "Cuando <evento> en una etapa -> Entonces <acción>". Hoy el único evento es entra_etapa y las
   acciones son tarea, pregunta (registra la respuesta en una columna de la tabla) y whatsapp (solo se
   configura; no se envía hasta definir la fuente de consentimiento). El motor se alimenta de crm_eventos,
   que un trigger llena cada vez que una oportunidad entra a una etapa. */

create table public.crm_automatizaciones (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  etapa_id uuid not null references public.crm_etapas(id) on delete cascade,
  evento text not null default 'entra_etapa' check (evento in ('entra_etapa')),
  tipo text not null check (tipo in ('tarea', 'pregunta', 'whatsapp')),
  nombre text not null,
  config jsonb not null default '{}'::jsonb,
  orden integer not null default 0,
  activa boolean not null default false,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index crm_automatizaciones_etapa_idx on public.crm_automatizaciones (etapa_id, evento) where activa;

create table public.crm_eventos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  tipo text not null check (tipo in ('etapa_cambiada')),
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  datos jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now(),
  procesado_en timestamptz,
  intentos integer not null default 0,
  error text
);
create index crm_eventos_pendientes_idx on public.crm_eventos (creado_en) where procesado_en is null;

create table public.crm_tareas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  automatizacion_id uuid references public.crm_automatizaciones(id) on delete set null,
  tipo text not null check (tipo in ('tarea', 'pregunta')),
  titulo text not null,
  descripcion text,
  config jsonb not null default '{}'::jsonb,
  asignado_a text,
  vence_en timestamptz,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'hecha', 'cancelada')),
  respuesta text,
  completada_en timestamptz,
  completada_por uuid references public.usuarios(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index crm_tareas_bandeja_idx on public.crm_tareas (sucursal_id, estado, asignado_a);
create index crm_tareas_oportunidad_idx on public.crm_tareas (oportunidad_id);

-- Idempotencia: una automatización corre una sola vez por oportunidad y evento, aunque el motor reintente.
create table public.crm_ejecuciones (
  id uuid primary key default gen_random_uuid(),
  automatizacion_id uuid not null references public.crm_automatizaciones(id) on delete cascade,
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  evento_id uuid not null references public.crm_eventos(id) on delete cascade,
  creado_en timestamptz not null default now(),
  unique (automatizacion_id, oportunidad_id, evento_id)
);

alter table public.crm_automatizaciones enable row level security;
alter table public.crm_eventos enable row level security;
alter table public.crm_tareas enable row level security;
alter table public.crm_ejecuciones enable row level security;
revoke all on public.crm_automatizaciones, public.crm_eventos, public.crm_tareas, public.crm_ejecuciones from anon, authenticated;

-- Cada vez que una oportunidad nace o cambia de etapa queda un evento para el motor.
create or replace function public.crm_emitir_evento_etapa() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.etapa_id is distinct from old.etapa_id then
    insert into public.crm_eventos (sucursal_id, tipo, oportunidad_id, datos)
    values (
      new.sucursal_id, 'etapa_cambiada', new.id,
      jsonb_build_object(
        'etapa_origen', case when tg_op = 'UPDATE' then old.etapa_id end,
        'etapa_destino', new.etapa_id
      )
    );
  end if;
  return new;
end $$;

create trigger crm_oportunidades_evento_etapa
after insert or update of etapa_id on public.crm_oportunidades
for each row execute function public.crm_emitir_evento_etapa();

create trigger crm_automatizaciones_tocar before update on public.crm_automatizaciones
for each row execute function public.crm_tocar();
