/* 0002: la vista muestra el estado de contacto con etiqueta legible. */

create or replace view public.crm_v_oportunidades with (security_invoker = true) as
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
  case o.estado_contacto
    when 'sin_intentar'   then 'Sin intentar'
    when 'intentando'     then 'Intentando'
    when 'contactado'     then 'Contactado'
    when 'buzon'          then 'Buzón de voz'
    when 'no_contactable' then 'No contactable'
    when 'baja'           then 'Baja'
  end                             as estado_contacto,
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

