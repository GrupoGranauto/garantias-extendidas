/* 0013: etapas del vehículo (fase 1 del ciclo de campañas).

   La etapa de un vehículo se calcula por la fecha de una columna elegida (por defecto la de factura) y por el
   kilometraje que captura el ejecutivo. Si el km se pasa del máximo de la etapa que marca la fecha, manda el km
   (sube de etapa, o queda excluido si excede la última). Las etapas y sus rangos las define el admin.

   - crm_ciclo_config: qué columna de fecha se usa y cuándo se recalculó por última vez.
   - crm_ciclo_etapas: nombre, meses (desde/hasta) y km máximo de cada etapa.
   - crm_vehiculos: kilometraje capturado y la etapa calculada (se guarda para poder filtrar y ordenar). */

create table if not exists public.crm_ciclo_config (
  sucursal_id uuid primary key references public.sucursales(id) on delete cascade,
  columna_fecha text not null default 'fecha_factura' check (columna_fecha in ('fecha_factura', 'fecha_reporte')),
  ultimo_calculo date,
  actualizado_en timestamptz not null default now()
);

create table if not exists public.crm_ciclo_etapas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  orden integer not null check (orden >= 1),
  nombre text not null check (length(btrim(nombre)) between 1 and 60),
  meses_desde integer not null check (meses_desde >= 0),
  meses_hasta integer not null,
  km_max integer not null check (km_max > 0),
  creado_en timestamptz not null default now(),
  unique (sucursal_id, orden),
  check (meses_hasta >= meses_desde)
);

alter table public.crm_ciclo_config enable row level security;
alter table public.crm_ciclo_etapas enable row level security;
revoke all on public.crm_ciclo_config, public.crm_ciclo_etapas from anon, authenticated;

alter table public.crm_vehiculos
  add column if not exists kilometraje integer check (kilometraje is null or (kilometraje >= 0 and kilometraje <= 5000000)),
  add column if not exists kilometraje_actualizado_en timestamptz,
  add column if not exists etapa_vehiculo_id uuid references public.crm_ciclo_etapas(id) on delete set null,
  add column if not exists etapa_vehiculo_motivo text,
  add column if not exists etapa_vehiculo_calculada_en timestamptz;
create index if not exists crm_vehiculos_etapa_idx on public.crm_vehiculos (sucursal_id, etapa_vehiculo_id);

/* La vista de lectura gana tres columnas al final: kilometraje, etapa del vehículo y su motivo. */
create or replace view public.crm_v_oportunidades with (security_invoker = true) as
select
  o.id, o.sucursal_id, o.clave as id_oportunidad, o.contacto_id, o.vehiculo_id, o.embudo_id, o.etapa_id, o.posicion,
  c.nombre as cliente, v.apv, v.fecha_factura, v.vin,
  c.telefono as telefono_principal, c.telefono_origen as origen_telefono, c.tiene_celular, c.correo,
  c.es_contactable, c.motivo_no_contactable,
  v.agencia, v.modelo as linea, v.version as version_vehiculo, v.ano_modelo as anio_vin,
  o.campana, o.fase_campana, o.fecha_inicio_campana as inicio_campana, o.fecha_fin_campana as fin_campana,
  o.proxima_campania, o.fecha_proxima_campania, o.motivo_no_elegible,
  o.estado_cartera as estado_fuente, v.tiene_ge,
  e.nombre as etapa_embudo, o.estado as estado_oportunidad,
  case o.estado_contacto
    when 'sin_intentar' then 'Sin intentar'
    when 'intentando' then 'Intentando'
    when 'contactado' then 'Contactado'
    when 'buzon' then 'Buzón de voz'
    when 'no_contactable' then 'No contactable'
    when 'baja' then 'Baja'
  end as estado_contacto,
  o.intentos, mp.nombre as motivo_perdida, o.comentarios, o.fecha_ultimo_contacto, o.fecha_compra, o.ejecutivo,
  o.entro_a_etapa_en, o.ultima_sincronizacion, o.creado_en, null::timestamptz as borrado_en,
  v.kilometraje,
  coalesce(ce.nombre, case v.etapa_vehiculo_motivo
    when 'excluido_km' then 'Excluido por km'
    when 'excluido_fecha' then 'Excluido por fecha'
    when 'aun_no' then 'Aún no entra'
    when 'sin_datos' then 'Sin datos'
    when 'sin_configurar' then 'Sin configurar'
  end) as etapa_vehiculo,
  v.etapa_vehiculo_motivo
from public.crm_oportunidades o
join public.crm_contactos c on c.id = o.contacto_id
join public.crm_vehiculos v on v.id = o.vehiculo_id
left join public.crm_etapas e on e.id = o.etapa_id
left join public.crm_motivos_perdida mp on mp.id = o.motivo_perdida_id
left join public.crm_ciclo_etapas ce on ce.id = v.etapa_vehiculo_id;

revoke all on public.crm_v_oportunidades from anon, authenticated;

/* Deja visibles en la tabla del portal las dos columnas nuevas (kilometraje editable, etapa del vehículo de solo lectura). */
create or replace function public.crm_asegurar_campos_ciclo(p_sucursal uuid) returns void
language plpgsql as $$
declare
  v_entidad uuid;
  v_pos integer;
begin
  select id into v_entidad from public.entidad_definiciones where sucursal_id = p_sucursal and nombre_tecnico = 'crm_v_oportunidades';
  if v_entidad is null then return; end if;
  select coalesce(max(posicion), 0) + 1 into v_pos from public.entidad_campos where entidad_id = v_entidad;

  if not exists (select 1 from public.entidad_campos where entidad_id = v_entidad and nombre_tecnico = 'kilometraje') then
    insert into public.entidad_campos (entidad_id, nombre_tecnico, nombre_visible, tipo, origen, posicion, visible, editor_tipo, opciones)
    values (v_entidad, 'kilometraje', 'Kilometraje', 'entero', 'back', v_pos, true, 'texto', '[]'::jsonb);
    v_pos := v_pos + 1;
  end if;
  if not exists (select 1 from public.entidad_campos where entidad_id = v_entidad and nombre_tecnico = 'etapa_vehiculo') then
    insert into public.entidad_campos (entidad_id, nombre_tecnico, nombre_visible, tipo, origen, posicion, visible, editor_tipo, opciones)
    values (v_entidad, 'etapa_vehiculo', 'Etapa del vehículo', 'texto', 'api', v_pos, true, 'texto', '[]'::jsonb);
  end if;
end $$;
revoke all on function public.crm_asegurar_campos_ciclo(uuid) from public, anon, authenticated;

select public.crm_asegurar_campos_ciclo(id) from public.sucursales;
