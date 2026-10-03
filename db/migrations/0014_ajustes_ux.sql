/*
  Ajustes de UX tras la validación del portal.

  1. El filtro principal del panel de Base de Datos pasa a ser «Activa» (estado_fuente = ACTIVA).
     Antes la tabla y el embudo arrancaban con todo (1,701) y «Por contactar» marcaba 1,595,
     mientras Inicio y Reportes contaban solo la cartera abierta (666). Quien quiera ver todo
     apaga el botón. Solo se toca si el panel tiene ese botón y todavía no hay un principal.
  2. «Etapa del vehículo» deja de salir vacía cuando el vehículo no se ha calculado:
     dice «Sin configurar» si la sucursal no definió etapas, o «Sin calcular» si ya las definió.
*/

update public.entidad_definiciones d
   set panel = (
     select jsonb_agg(
              case
                when i->>'tipo' = 'boton' and i->>'columna' = 'estado_fuente' and i->>'valor' = 'ACTIVA'
                  then jsonb_set(i, '{principal}', 'true'::jsonb)
                else i
              end
              order by ord)
       from jsonb_array_elements(d.panel) with ordinality as t(i, ord)
   )
 where jsonb_typeof(d.panel) = 'array'
   and exists (
     select 1 from jsonb_array_elements(d.panel) i
      where i->>'tipo' = 'boton' and i->>'columna' = 'estado_fuente' and i->>'valor' = 'ACTIVA'
   )
   and not exists (
     select 1 from jsonb_array_elements(d.panel) i where (i->>'principal')::boolean is true
   );

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
    else case
      when exists (select 1 from public.crm_ciclo_etapas x where x.sucursal_id = o.sucursal_id) then 'Sin calcular'
      else 'Sin configurar'
    end
  end) as etapa_vehiculo,
  v.etapa_vehiculo_motivo
from public.crm_oportunidades o
join public.crm_contactos c on c.id = o.contacto_id
join public.crm_vehiculos v on v.id = o.vehiculo_id
left join public.crm_etapas e on e.id = o.etapa_id
left join public.crm_motivos_perdida mp on mp.id = o.motivo_perdida_id
left join public.crm_ciclo_etapas ce on ce.id = v.etapa_vehiculo_id;

revoke all on public.crm_v_oportunidades from anon, authenticated;
