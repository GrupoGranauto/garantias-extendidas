/* 0010: envíos automáticos de WhatsApp por campaña.

   - Consentimiento y baja viven en el contacto (un teléfono es una persona, no una oportunidad).
   - crm_campanas_envio: configuración por campaña (activa, modo simulación/real, ventana, tope, frecuencia).
   - crm_campana_pasos: la cadencia: qué plantilla, cuántos días después del inicio, a qué hora y bajo qué condiciones.
   - crm_envios: cola y bitácora. Una fila por (oportunidad, paso): el motor no puede mandar dos veces lo mismo. */

alter table public.crm_contactos
  add column if not exists whatsapp_consentimiento boolean,
  add column if not exists whatsapp_consentimiento_fuente text,
  add column if not exists whatsapp_consentimiento_en timestamptz,
  add column if not exists whatsapp_baja boolean not null default false,
  add column if not exists whatsapp_baja_en timestamptz;

create table if not exists public.crm_campanas_envio (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  campana text not null,
  activa boolean not null default false,
  modo text not null default 'simulacion' check (modo in ('simulacion', 'real')),
  dias_semana integer[] not null default '{1,2,3,4,5}',            -- 1 = lunes … 7 = domingo
  hora_inicio time not null default '09:00',
  hora_fin time not null default '19:00',
  max_por_dia integer not null default 100 check (max_por_dia between 1 and 5000),
  dias_entre_mensajes integer not null default 7 check (dias_entre_mensajes between 0 and 365),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (sucursal_id, campana),
  check (hora_fin > hora_inicio)
);

create table if not exists public.crm_campana_pasos (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.crm_campanas_envio(id) on delete cascade,
  orden integer not null,
  plantilla_id uuid references public.whatsapp_plantillas(id) on delete set null,
  dias_despues integer not null default 0 check (dias_despues between 0 and 365),
  hora time,                                                          -- null = al abrir la ventana de envío
  vigencia_dias integer not null default 2 check (vigencia_dias between 0 and 60),
  solo_sin_respuesta boolean not null default false,
  solo_sin_contacto boolean not null default false,
  etapas text[] not null default '{}',                                -- vacío = en cualquier etapa abierta
  creado_en timestamptz not null default now()
);
create index if not exists crm_campana_pasos_config_idx on public.crm_campana_pasos (config_id, orden);

create table if not exists public.crm_envios (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  paso_id uuid not null references public.crm_campana_pasos(id) on delete cascade,
  campana text not null,
  plantilla_id uuid references public.whatsapp_plantillas(id) on delete set null,
  programado_para timestamptz not null,
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'simulado', 'enviado', 'entregado', 'leido', 'fallido', 'omitido')),
  motivo text,
  wa_message_id text,
  intentos integer not null default 0,
  error text,
  enviado_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (oportunidad_id, paso_id)
);
create index if not exists crm_envios_cola_idx on public.crm_envios (programado_para) where estado = 'pendiente';
create index if not exists crm_envios_sucursal_idx on public.crm_envios (sucursal_id, campana, creado_en desc);
create index if not exists crm_envios_wa_idx on public.crm_envios (wa_message_id) where wa_message_id is not null;

alter table public.crm_campanas_envio enable row level security;
alter table public.crm_campana_pasos enable row level security;
alter table public.crm_envios enable row level security;
revoke all on public.crm_campanas_envio, public.crm_campana_pasos, public.crm_envios from anon, authenticated;

create trigger crm_campanas_envio_tocar before update on public.crm_campanas_envio
for each row execute function public.crm_tocar();
create trigger crm_envios_tocar before update on public.crm_envios
for each row execute function public.crm_tocar();
