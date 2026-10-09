/*
  Vista igual a la hoja GEXT_OPERACION del Sheet: los mismos 26 encabezados (A:Z), con el mismo nombre y en el mismo
  orden, y una fila por paso de campaña (ID Oportunidad = VIN | campaña | inicio). Es lo que el proceso diario extraerá
  para alimentar la base maestra, igual que hoy se lee el Sheet.

  - A:T  datos de la fuente (cliente, vehículo, campaña). «Estado fuente»: ACTIVA si el paso está en curso; si está
         cerrado, se clasifica con el estado de hoy del VIN, como hace el Apps Script (NO_EN_MAESTRA, YA_TIENE_GE,
         NO_CONTACTABLE_FUENTE o FUERA_DE_VENTANA).
  - U:Y  campos manuales del BDC: del lead si el paso está en curso; de la foto tomada al cerrarlo si ya cerró.
  - Z    última sincronización.
  - Después de Z van columnas propias de la web (sucursal, lead, paso, fechas de apertura y cierre, motivo de cierre).

  También devuelve security_invoker a crm_v_oportunidades: el create or replace de la 0028 se lo quitó.
*/

create view public.crm_v_gext_operacion with (security_invoker = true) as
select
  p.clave                                   as "ID Oportunidad",
  c.nombre                                  as "Cliente",
  v.apv                                     as "APV",
  v.fecha_factura                           as "Fecha fact.",
  v.vin                                     as "VIN",
  c.telefono                                as "Teléfono principal",
  c.telefono_origen                         as "Origen teléfono",
  c.tiene_celular                           as "Tiene celular",
  c.correo                                  as "Correo",
  c.es_contactable                          as "Es contactable",
  c.motivo_no_contactable                   as "Motivo no contactable",
  v.agencia                                 as "Agencia",
  v.modelo                                  as "Línea",
  v.version                                 as "Versión",
  v.ano_modelo                              as "Año VIN",
  p.campana                                 as "Campaña",
  p.fase_campana                            as "Etapa",
  p.fecha_inicio_campana                    as "Inicio campaña",
  case
    when p.cerrada_en is null then o.estado_cartera
    when o.estado_cartera = 'NO_EN_MAESTRA' then 'NO_EN_MAESTRA'
    when v.tiene_ge then 'YA_TIENE_GE'
    when c.es_contactable = false then 'NO_CONTACTABLE_FUENTE'
    else 'FUERA_DE_VENTANA'
  end                                       as "Estado fuente",
  v.tiene_ge                                as "Tiene GE",
  case when p.cerrada_en is null then o.resultado_bdc else coalesce(p.resultado_bdc, 'PENDIENTE') end
                                            as "Resultado BDC",
  case when p.cerrada_en is null then o.comentarios else p.comentarios end
                                            as "Comentarios",
  case when p.cerrada_en is null then o.fecha_ultimo_contacto else p.fecha_ultimo_contacto end
                                            as "Fecha último contacto",
  case when p.cerrada_en is null then o.fecha_compra else p.fecha_compra end
                                            as "Fecha compra",
  case when p.cerrada_en is null then o.ejecutivo else p.ejecutivo end
                                            as "Ejecutivo",
  coalesce(p.ultima_sincronizacion, o.ultima_sincronizacion)
                                            as "Última sincronización",
  -- Columnas propias de la web (después de Z).
  p.sucursal_id,
  p.oportunidad_id,
  p.id                                      as paso_id,
  p.fecha_fin_campana                       as fin_campana,
  p.abierta_en,
  p.cerrada_en,
  p.motivo_cierre
from public.crm_oportunidad_campanas p
join public.crm_oportunidades o on o.id = p.oportunidad_id
join public.crm_contactos c on c.id = o.contacto_id
join public.crm_vehiculos v on v.id = o.vehiculo_id;

revoke all on public.crm_v_gext_operacion from anon, authenticated;

alter view public.crm_v_oportunidades set (security_invoker = true);
