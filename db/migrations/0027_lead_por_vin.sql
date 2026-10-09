/*
  Un lead por VIN con su historial por campaña.

  La maestra de BigQuery se rearma cada mañana; la memoria de lo que pasó con cada cliente vive aquí. El lead sigue
  siendo crm_oportunidades (una por vehículo) y cada vez que el VIN está en una campaña se registra un PASO con la clave
  del Sheet (VIN | campaña | inicio). Los pasos nunca se borran: de ellos salen los KPI por campaña y la vista igual a
  GEXT_OPERACION (una fila por paso).

  Solo agrega: el código que hoy corre en producción sigue funcionando igual.
   - crm_oportunidad_campanas: los pasos (uno abierto como máximo por lead).
   - crm_oportunidades.resultado_bdc: el «Resultado BDC» del Sheet con sus 12 valores.
   - campana_id en actividades, historial de estados, tareas y envíos: a qué paso pertenece cada evento. Un trigger lo
     llena solo con el paso abierto, así nada de lo que ya inserta eventos tiene que cambiar.
   - Un lead por vehículo (índice único).
   - Llenado inicial: cada oportunidad actual se vuelve el primer paso de su lead (abierto si está ACTIVA).
*/

-- ---------- Pasos por campaña ----------
create table public.crm_oportunidad_campanas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  oportunidad_id uuid not null references public.crm_oportunidades(id) on delete cascade,
  -- «ID Oportunidad» del Sheet: VIN | campaña | inicio.
  clave text not null,
  campana text not null,
  fecha_inicio_campana date,
  fecha_fin_campana date,
  -- «Etapa» de la maestra (ETAPA_1, NURTURING, ETAPA_2).
  fase_campana text,
  abierta_en timestamptz not null default now(),
  cerrada_en timestamptz,
  -- Por qué se cerró: cambio de campaña o el estado de la maestra.
  motivo_cierre text check (motivo_cierre in ('CAMBIO_CAMPANA', 'FUERA_DE_VENTANA', 'YA_TIENE_GE', 'NO_CONTACTABLE_FUENTE', 'NO_EN_MAESTRA')),
  -- Foto de las columnas manuales del BDC al cerrar (mientras está abierto se leen del lead).
  resultado_bdc text,
  comentarios text,
  fecha_ultimo_contacto date,
  fecha_compra date,
  ejecutivo text,
  etapa_id uuid references public.crm_etapas(id) on delete set null,
  estado_contacto text,
  -- Medición.
  primer_contacto_en timestamptz,
  ultima_sincronizacion timestamptz,
  unique (sucursal_id, clave),
  check ((cerrada_en is null) = (motivo_cierre is null))
);

create unique index crm_oportunidad_campanas_abierta_uq on public.crm_oportunidad_campanas (oportunidad_id) where cerrada_en is null;
create index crm_oportunidad_campanas_lead_idx on public.crm_oportunidad_campanas (oportunidad_id, abierta_en desc);
create index crm_oportunidad_campanas_kpi_idx on public.crm_oportunidad_campanas (sucursal_id, campana, abierta_en);

alter table public.crm_oportunidad_campanas enable row level security;
revoke all on public.crm_oportunidad_campanas from anon, authenticated;

-- ---------- Resultado BDC (los 12 valores del Sheet) ----------
alter table public.crm_oportunidades
  add column resultado_bdc text not null default 'PENDIENTE'
  check (resultado_bdc in (
    'PENDIENTE', 'BUZON', 'CONTACTO NO DISPONIBLE', 'NO CONTACTABLE', 'CONTACTADO', 'SOLICITA INFO WHATSAPP',
    'INTERESADO', 'PENDIENTE DECISION TERCERO', 'COTIZADO', 'VENDIDO', 'NO INTERESADO', 'PRECIO FUERA PRESUPUESTO'
  ));

-- El valor inicial sale de lo que la web ya tiene (estado del lead, contacto y motivo de pérdida).
update public.crm_oportunidades o
   set resultado_bdc = case
     when e.clave = 'vendido' then 'VENDIDO'
     when e.clave = 'cotizado' then 'COTIZADO'
     when e.clave = 'interesado' then 'INTERESADO'
     when e.clave = 'contactado' then 'CONTACTADO'
     when e.clave = 'perdido' and (o.estado_contacto = 'no_contactable'
          or (select mp.clave from public.crm_motivos_perdida mp where mp.id = o.motivo_perdida_id) = 'no_contactable') then 'NO CONTACTABLE'
     when e.clave = 'perdido' then 'NO INTERESADO'
     when o.estado_contacto = 'buzon' then 'BUZON'
     when o.estado_contacto = 'intentando' then 'CONTACTO NO DISPONIBLE'
     when o.estado_contacto = 'no_contactable' then 'NO CONTACTABLE'
     else 'PENDIENTE'
   end
  from public.crm_etapas e
 where e.id = o.etapa_id;

-- ---------- Un lead por vehículo ----------
create unique index crm_oportunidades_vehiculo_uq on public.crm_oportunidades (sucursal_id, vehiculo_id);

-- ---------- Llenado inicial: cada oportunidad actual es el primer paso de su lead ----------
insert into public.crm_oportunidad_campanas
  (sucursal_id, oportunidad_id, clave, campana, fecha_inicio_campana, fecha_fin_campana, fase_campana, abierta_en,
   cerrada_en, motivo_cierre, resultado_bdc, comentarios, fecha_ultimo_contacto, fecha_compra, ejecutivo, etapa_id,
   estado_contacto, primer_contacto_en, ultima_sincronizacion)
select o.sucursal_id, o.id, o.clave, coalesce(o.campana, 'SIN_CAMPANA'), o.fecha_inicio_campana, o.fecha_fin_campana,
       o.fase_campana, o.creado_en,
       case when o.estado_cartera <> 'ACTIVA' then coalesce(o.ultima_sincronizacion, o.actualizado_en, now()) end,
       case when o.estado_cartera <> 'ACTIVA' then o.estado_cartera end,
       -- La foto solo en los cerrados; el abierto lee los valores vivos del lead.
       case when o.estado_cartera <> 'ACTIVA' then o.resultado_bdc end,
       case when o.estado_cartera <> 'ACTIVA' then o.comentarios end,
       case when o.estado_cartera <> 'ACTIVA' then o.fecha_ultimo_contacto end,
       case when o.estado_cartera <> 'ACTIVA' then o.fecha_compra end,
       case when o.estado_cartera <> 'ACTIVA' then o.ejecutivo end,
       case when o.estado_cartera <> 'ACTIVA' then o.etapa_id end,
       case when o.estado_cartera <> 'ACTIVA' then o.estado_contacto end,
       (select min(a.creado_en) from public.crm_actividades a
         where a.oportunidad_id = o.id
           and (a.tipo = 'mensaje_entrante' or (a.tipo in ('llamada', 'whatsapp') and a.detalle->>'resultado' = 'contesto'))),
       o.ultima_sincronizacion
  from public.crm_oportunidades o;

-- ---------- A qué paso pertenece cada evento ----------
alter table public.crm_actividades add column campana_id uuid references public.crm_oportunidad_campanas(id) on delete set null;
alter table public.crm_historial_etapas add column campana_id uuid references public.crm_oportunidad_campanas(id) on delete set null;
alter table public.crm_tareas add column campana_id uuid references public.crm_oportunidad_campanas(id) on delete set null;
alter table public.crm_envios add column campana_id uuid references public.crm_oportunidad_campanas(id) on delete set null;

create index crm_actividades_campana_idx on public.crm_actividades (campana_id);
create index crm_historial_etapas_campana_idx on public.crm_historial_etapas (campana_id);
create index crm_tareas_campana_idx on public.crm_tareas (campana_id);
-- El candado contra mensajes repetidos: un envío por paso de campaña y paso del masivo.
create unique index crm_envios_campana_paso_uq on public.crm_envios (campana_id, paso_id) where campana_id is not null and paso_id is not null;

-- Lo que ya existe pertenece al único paso de su lead.
update public.crm_actividades a set campana_id = c.id from public.crm_oportunidad_campanas c where c.oportunidad_id = a.oportunidad_id;
update public.crm_historial_etapas h set campana_id = c.id from public.crm_oportunidad_campanas c where c.oportunidad_id = h.oportunidad_id;
update public.crm_tareas t set campana_id = c.id from public.crm_oportunidad_campanas c where c.oportunidad_id = t.oportunidad_id;
update public.crm_envios e set campana_id = c.id from public.crm_oportunidad_campanas c where c.oportunidad_id = e.oportunidad_id;

-- Lo nuevo se asigna solo al paso abierto del lead.
create or replace function public.crm_poner_campana_en_curso() returns trigger
language plpgsql as $$
begin
  if new.campana_id is null and new.oportunidad_id is not null then
    select c.id into new.campana_id
      from public.crm_oportunidad_campanas c
     where c.oportunidad_id = new.oportunidad_id and c.cerrada_en is null;
  end if;
  return new;
end $$;

create trigger crm_actividades_campana before insert on public.crm_actividades
  for each row execute function public.crm_poner_campana_en_curso();
create trigger crm_historial_etapas_campana before insert on public.crm_historial_etapas
  for each row execute function public.crm_poner_campana_en_curso();
create trigger crm_tareas_campana before insert on public.crm_tareas
  for each row execute function public.crm_poner_campana_en_curso();
create trigger crm_envios_campana before insert on public.crm_envios
  for each row execute function public.crm_poner_campana_en_curso();
