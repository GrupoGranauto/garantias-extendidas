-- CRM · núcleo relacional (fase 1)
--
-- Reemplaza la tabla plana por sucursal (datos_<sucursal>.garantias_extendidas) por un
-- modelo relacional con sucursal_id en cada tabla. Principios (ver Notion, docs GE-5/GE-6):
--   * La cartera y la campaña las define BigQuery (nis_ge_cartera_maestra); la app no las recalcula.
--   * Identidad de oportunidad: VIN | campaña | fecha_inicio_campaña (estable, con historial).
--   * Campos de fuente y campos de gestión humana viven separados; el sync no pisa los de gestión.
--   * Una oportunidad nunca se borra: al salir de ventana cambia su estado de cartera.
--   * Dimensiones de estado SEPARADAS: etapa comercial, estado de contacto, estado de contrato
--     y estado de cartera (fuente). "Vendido" requiere evidencia de contrato, no solo interés.
--
-- Acceso: solo el backend (service_role). RLS activo y sin políticas para anon/authenticated.

create or replace function public.crm_tocar() returns trigger
language plpgsql as $$
begin
  new.actualizado_en = now();
  return new;
end $$;

/* ---------- Personas y cosas ---------- */

create table public.crm_contactos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  -- Identidad: últimos 10 dígitos del teléfono, o el correo en minúsculas, o 'vin:<vin>'
  -- (la maestra no trae identificador de cliente).
  clave text not null,
  nombre text,
  telefono text,
  telefono_origen text,
  tiene_celular boolean,
  correo text,
  es_contactable boolean,
  motivo_no_contactable text,
  datos jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (sucursal_id, clave)
);
create index crm_contactos_tel_idx on public.crm_contactos (sucursal_id, telefono);

create table public.crm_vehiculos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  vin text not null,
  agencia text,
  distribuidor text,
  cve_distribuidor integer,
  modelo text,
  version text,
  ano_modelo integer,
  apv text,
  tipo_venta text,
  fecha_factura date,
  fecha_reporte date,
  tiene_ge boolean,
  cantidad_ge_activas integer,
  fecha_fin_garantia date,
  datos jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (sucursal_id, vin)
);

/* ---------- Embudo ---------- */

create table public.crm_embudos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  clave text not null,
  nombre text not null,
  es_predeterminado boolean not null default false,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  unique (sucursal_id, clave)
);

create table public.crm_etapas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  embudo_id uuid not null references public.crm_embudos(id) on delete cascade,
  clave text not null,
  nombre text not null,
  color text not null default '#6b7280' check (color ~ '^#[0-9a-fA-F]{6}$'),
  orden integer not null default 0,
  -- abierta = sigue en gestión; ganada / perdida = cierran la oportunidad.
  tipo text not null default 'abierta' check (tipo in ('abierta', 'ganada', 'perdida')),
  -- Tiempo máximo en la etapa antes de considerarse estancada (alertas/automatizaciones).
  tiempo_max_horas integer check (tiempo_max_horas is null or tiempo_max_horas > 0),
  activa boolean not null default true,
  unique (embudo_id, clave)
);
create index crm_etapas_embudo_idx on public.crm_etapas (embudo_id, orden);

create table public.crm_motivos_perdida (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  clave text not null,
  nombre text not null,
  orden integer not null default 0,
  activo boolean not null default true,
  unique (sucursal_id, clave)
);

/* ---------- Oportunidad ---------- */

create table public.crm_oportunidades (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  -- VIN|campaña|fecha_inicio_campaña
  clave text not null,
  contacto_id uuid not null references public.crm_contactos(id),
  vehiculo_id uuid not null references public.crm_vehiculos(id),

  -- Datos de fuente (BigQuery): los reescribe el sync.
  campana text not null,
  fecha_inicio_campana date not null,
  -- Fin de la ventana de la campaña activa: permite ordenar y alertar por urgencia.
  fecha_fin_campana date,
  fase_campana text,
  proxima_campania text,
  fecha_proxima_campania date,
  motivo_no_elegible text,
  estado_cartera text not null default 'ACTIVA'
    check (estado_cartera in ('ACTIVA', 'YA_TIENE_GE', 'NO_CONTACTABLE_FUENTE', 'FUERA_DE_VENTANA', 'NO_EN_MAESTRA')),
  -- Copia de lo que trae la maestra y no tiene columna propia (importe_neto_ge, fuente_ge,
  -- fecha_primera_ge, fecha_ultima_ge, elegible_campania_actual, mes_nissan, fecha_actualizacion):
  -- no se pierde nada y no hace falta alterar la tabla si luego alguno se vuelve útil.
  fuente jsonb not null default '{}'::jsonb,

  -- Dimensión comercial (embudo).
  embudo_id uuid not null references public.crm_embudos(id),
  etapa_id uuid not null references public.crm_etapas(id),
  -- Orden dentro de la etapa (tablero). Se calcula entre vecinos al arrastrar.
  posicion double precision not null default 0,
  estado text not null default 'abierta' check (estado in ('abierta', 'ganada', 'perdida')),
  motivo_perdida_id uuid references public.crm_motivos_perdida(id),
  cerrada_en timestamptz,
  entro_a_etapa_en timestamptz not null default now(),

  -- Dimensión de contacto (separada de la etapa).
  estado_contacto text not null default 'sin_intentar'
    check (estado_contacto in ('sin_intentar', 'intentando', 'contactado', 'buzon', 'no_contactable', 'baja')),
  intentos integer not null default 0 check (intentos >= 0),
  ultimo_intento_en timestamptz,

  -- Gestión humana: el sync NUNCA la pisa.
  ejecutivo text,
  comentarios text,
  fecha_ultimo_contacto date,
  fecha_compra date,

  datos jsonb not null default '{}'::jsonb,
  ultima_sincronizacion timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (sucursal_id, clave)
);
create index crm_oport_etapa_idx on public.crm_oportunidades (sucursal_id, etapa_id, posicion);
create index crm_oport_campana_idx on public.crm_oportunidades (sucursal_id, campana);
create index crm_oport_ejecutivo_idx on public.crm_oportunidades (sucursal_id, ejecutivo);
create index crm_oport_cartera_idx on public.crm_oportunidades (sucursal_id, estado_cartera);
create index crm_oport_contacto_idx on public.crm_oportunidades (contacto_id);
create index crm_oport_vehiculo_idx on public.crm_oportunidades (vehiculo_id);

/* ---------- Trazabilidad ---------- */

create table public.crm_historial_etapas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  etapa_origen_id uuid references public.crm_etapas(id),
  etapa_destino_id uuid not null references public.crm_etapas(id),
  motivo_perdida_id uuid references public.crm_motivos_perdida(id),
  usuario_id uuid references public.usuarios(id) on delete set null,
  origen text not null default 'manual' check (origen in ('manual', 'sync', 'automatizacion', 'migracion')),
  creado_en timestamptz not null default now()
);
create index crm_hist_oport_idx on public.crm_historial_etapas (oportunidad_id, creado_en desc);

-- Línea de tiempo del lead: notas, llamadas, mensajes, cambios, tareas.
create table public.crm_actividades (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  tipo text not null,
  titulo text,
  detalle jsonb not null default '{}'::jsonb,
  usuario_id uuid references public.usuarios(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index crm_act_oport_idx on public.crm_actividades (oportunidad_id, creado_en desc);

/* ---------- Contrato (tercera dimensión; definido, aún sin proceso activo) ---------- */

create table public.crm_contratos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  oportunidad_id uuid not null unique references public.crm_oportunidades(id) on delete cascade,
  -- Eventos de control propuestos en Notion (N05): cada uno exige su evidencia.
  estado text not null default 'sin_contrato'
    check (estado in ('sin_contrato', 'cotizado', 'aceptado', 'orden_pago', 'pago_confirmado',
                      'certificado_entregado', 'cobertura_iniciada', 'cancelado')),
  folio text,
  eventos jsonb not null default '[]'::jsonb,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

/* ---------- Observabilidad del sync (sin datos personales) ---------- */

create table public.crm_sync_corridas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  origen text not null default 'bigquery',
  modo text not null check (modo in ('simulacion', 'real')),
  estado text not null check (estado in ('ok', 'error')),
  filas_fuente integer,
  activas_fuente integer,
  nuevas integer,
  actualizadas integer,
  migradas integer,
  cerradas integer,
  conflictos integer,
  mensaje text,
  creado_en timestamptz not null default now()
);

/* ---------- Triggers de actualización ---------- */

create trigger crm_contactos_tocar before update on public.crm_contactos
  for each row execute function public.crm_tocar();
create trigger crm_vehiculos_tocar before update on public.crm_vehiculos
  for each row execute function public.crm_tocar();
create trigger crm_oportunidades_tocar before update on public.crm_oportunidades
  for each row execute function public.crm_tocar();
create trigger crm_contratos_tocar before update on public.crm_contratos
  for each row execute function public.crm_tocar();

/* ---------- Acceso: solo service_role ---------- */

alter table public.crm_contactos enable row level security;
alter table public.crm_vehiculos enable row level security;
alter table public.crm_embudos enable row level security;
alter table public.crm_etapas enable row level security;
alter table public.crm_motivos_perdida enable row level security;
alter table public.crm_oportunidades enable row level security;
alter table public.crm_historial_etapas enable row level security;
alter table public.crm_actividades enable row level security;
alter table public.crm_contratos enable row level security;
alter table public.crm_sync_corridas enable row level security;

/* ---------- Semilla por sucursal: embudo, etapas y motivos (editables) ---------- */

create or replace function public.crm_sembrar_sucursal(p_sucursal uuid) returns void
language plpgsql as $$
declare
  v_embudo uuid;
begin
  insert into public.crm_embudos (sucursal_id, clave, nombre, es_predeterminado)
  values (p_sucursal, 'garantias', 'Garantía extendida', true)
  on conflict (sucursal_id, clave) do nothing;

  select id into v_embudo from public.crm_embudos where sucursal_id = p_sucursal and clave = 'garantias';

  -- Etapas iniciales derivadas del Resultado BDC actual; el proceso comercial de GE aún no está
  -- definido en Notion, así que son una semilla editable, no una regla de negocio.
  insert into public.crm_etapas (sucursal_id, embudo_id, clave, nombre, color, orden, tipo) values
    (p_sucursal, v_embudo, 'por_contactar', 'Por contactar', '#b89f00', 1, 'abierta'),
    (p_sucursal, v_embudo, 'contactado',    'Contactado',    '#614dff', 2, 'abierta'),
    (p_sucursal, v_embudo, 'interesado',    'Interesado',    '#00b37d', 3, 'abierta'),
    (p_sucursal, v_embudo, 'cotizado',      'Cotizado',      '#f000e8', 4, 'abierta'),
    (p_sucursal, v_embudo, 'vendido',       'Vendido',       '#21c700', 5, 'ganada'),
    (p_sucursal, v_embudo, 'perdido',       'Perdido',       '#dc2626', 6, 'perdida')
  on conflict (embudo_id, clave) do nothing;

  insert into public.crm_motivos_perdida (sucursal_id, clave, nombre, orden) values
    (p_sucursal, 'no_interesado',  'No interesado',  1),
    (p_sucursal, 'no_contactable', 'No contactable', 2),
    (p_sucursal, 'no_vendido',     'No vendido',     3),
    (p_sucursal, 'otro',           'Otro',           4)
  on conflict (sucursal_id, clave) do nothing;
end $$;

select public.crm_sembrar_sucursal(id) from public.sucursales;

/* ---------- Vista de lectura: alimenta la tabla, los filtros, los KPIs y el embudo ---------- */
-- security_invoker: la vista respeta el RLS de quien consulta (sin esto correría como su dueño
-- y se saltaría el RLS de las tablas base).

create view public.crm_v_oportunidades with (security_invoker = true) as
select
  o.id,
  o.sucursal_id,
  o.clave                         as id_oportunidad,
  o.contacto_id,
  o.vehiculo_id,
  o.embudo_id,
  o.etapa_id,
  o.posicion,
  c.nombre                        as cliente,
  v.apv,
  v.fecha_factura,
  v.vin,
  c.telefono                      as telefono_principal,
  c.telefono_origen               as origen_telefono,
  c.tiene_celular,
  c.correo,
  c.es_contactable,
  c.motivo_no_contactable,
  v.agencia,
  v.modelo                        as linea,
  v.version                       as version_vehiculo,
  v.ano_modelo                    as anio_vin,
  o.campana,
  o.fase_campana,
  o.fecha_inicio_campana          as inicio_campana,
  o.fecha_fin_campana             as fin_campana,
  o.proxima_campania,
  o.fecha_proxima_campania,
  o.motivo_no_elegible,
  o.estado_cartera                as estado_fuente,
  v.tiene_ge,
  e.nombre                        as etapa_embudo,
  o.estado                        as estado_oportunidad,
  o.estado_contacto,
  o.intentos,
  mp.nombre                       as motivo_perdida,
  o.comentarios,
  o.fecha_ultimo_contacto,
  o.fecha_compra,
  o.ejecutivo,
  o.entro_a_etapa_en,
  o.ultima_sincronizacion,
  o.creado_en,
  null::timestamptz               as borrado_en
from public.crm_oportunidades o
join public.crm_contactos  c on c.id = o.contacto_id
join public.crm_vehiculos  v on v.id = o.vehiculo_id
left join public.crm_etapas e on e.id = o.etapa_id
left join public.crm_motivos_perdida mp on mp.id = o.motivo_perdida_id;

revoke all on public.crm_v_oportunidades from anon, authenticated;
