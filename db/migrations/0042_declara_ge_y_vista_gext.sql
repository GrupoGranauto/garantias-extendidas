/*
  Quien declara tener GE comprada fuera sale de cartera, y la vista con forma del Sheet muestra los estados nuevos
  (decisiones del 16-oct-2026, Miguel Borbón).

  1. Freno de envíos (crm_motivo_no_enviar): en la capa de campaña, un lead con «Cliente declara tener GE» se omite como
     ya_tiene_ge, igual que el que la tiene según la maestra. Antes solo lo frenaba estar cerrado (Perdido); con la marca
     puesta en un lead abierto se le podía escribir. El resto de la función queda igual que en 0039.
  2. Vista crm_v_gext_operacion: el «Estado fuente» de los pasos cerrados ya muestra VENDIDA_BDC y DESCARTADO (el estado
     de cartera del lead), y YA_TIENE_GE también cuando el cliente la declaró. Antes se recalculaba solo con tiene_ge del
     vehículo y es_contactable, y esos estados salían como FUERA_DE_VENTANA. Mismas columnas, mismo orden.
*/
begin;
set local lock_timeout = '5s';

create or replace function public.crm_motivo_no_enviar(p_oportunidad uuid, p_plantilla uuid, p_origen text default 'masivo')
returns text language sql stable set search_path = public as $$
  with l as (
    select o.id, o.sucursal_id, o.estado, o.etapa_id, o.estado_contacto, o.estado_cartera,
           (o.fecha_pago is not null or o.fecha_compra is not null) as venta_capturada,
           coalesce(k.whatsapp_baja, false) as whatsapp_baja, crm_tel10(k.telefono) as tel10, v.vin,
           coalesce(v.tiene_ge, false) as tiene_ge, coalesce(o.declara_ge, false) as declara_ge, p.id as paso_id
      from crm_oportunidades o
      left join crm_contactos k on k.id = o.contacto_id
      left join crm_vehiculos v on v.id = o.vehiculo_id
      left join crm_oportunidad_campanas p on p.oportunidad_id = o.id and p.cerrada_en is null
     where o.id = p_oportunidad
  ), r0 as (
    select coalesce((select x.uso from crm_plantilla_reglas x where x.plantilla_id = p_plantilla), 'campana') as uso,
           coalesce((select x.estados from crm_plantilla_reglas x where x.plantilla_id = p_plantilla), '{}'::uuid[]) as estados
  ), r as (
    -- venta: la regla incluye un estado ganado (Vendido). cobro: incluye Cotizado y ningún estado ganado.
    select r0.uso, r0.estados,
           exists (select 1 from crm_etapas e where e.id = any(r0.estados) and e.tipo = 'ganada') as venta,
           exists (select 1 from crm_etapas e where e.id = any(r0.estados) and e.clave = 'cotizado')
             and not exists (select 1 from crm_etapas e where e.id = any(r0.estados) and e.tipo = 'ganada') as cobro
      from r0
  ), ct as (
    select (select x.estado from crm_contratos x where x.oportunidad_id = p_oportunidad
             order by x.creado_en desc limit 1) as estado
  ), su as (
    select (select y.motivo
              from crm_supresiones y, l
             where y.sucursal_id = l.sucursal_id and y.revocada_en is null
               and (y.vigente_hasta is null or y.vigente_hasta > now())
               and ((y.alcance = 'telefono' and y.valor = l.tel10) or (y.alcance = 'vin' and y.valor = l.vin))
             order by (y.motivo = 'baja') desc, y.creado_en
             limit 1) as motivo
  )
  select case
    when l.id is null then 'lead_inexistente'
    -- Capa 1 · cumplimiento.
    when l.whatsapp_baja or l.estado_contacto = 'baja' then 'baja'
    when su.motivo is not null then 'supresion_' || su.motivo
    when l.estado_contacto = 'no_contactable' then 'no_contactable'
    when l.tel10 is null then 'sin_telefono'
    -- Capa 2 · servicio (el primer mensaje automático siempre pasa por la capa de campaña, aunque la plantilla sea de servicio).
    when r.uso = 'servicio' and p_origen <> 'primer_mensaje' then
      case
        when ct.estado = 'cancelado' then 'contrato_cancelado'
        -- Plantillas de cobro (regla Cotizado sin Vendido): nunca a quien ya pagó, aunque siga en Cotizado.
        when r.cobro and (l.venta_capturada
                          or coalesce(ct.estado, '') in ('pago_confirmado', 'certificado_entregado', 'cobertura_iniciada'))
          then 'pagado'
        when cardinality(r.estados) = 0 or l.etapa_id = any(r.estados) then null
        when r.venta and (l.estado = 'ganada' or l.venta_capturada
                          or coalesce(ct.estado, '') in ('pago_confirmado', 'certificado_entregado', 'cobertura_iniciada'))
          then null
        -- Cobro con el contrato en curso aunque la etapa se haya movido, mientras el lead siga abierto.
        when r.cobro and l.estado = 'abierta' and coalesce(ct.estado, '') in ('cotizado', 'aceptado', 'orden_pago')
          then null
        else 'fuera_de_regla'
      end
    -- Capa 2 · campaña.
    when l.estado <> 'abierta' then 'lead_' || l.estado
    -- Ya tiene GE: vendida fuera (dato de la maestra) o declarada por el cliente (decisión del 16-oct-2026).
    when l.tiene_ge or l.declara_ge then 'ya_tiene_ge'
    when l.venta_capturada
      or coalesce(ct.estado, '') in ('pago_confirmado', 'certificado_entregado', 'cobertura_iniciada') then 'pagado'
    when l.paso_id is not null and exists (select 1 from crm_actividades a
                  where a.oportunidad_id = l.id and a.tipo = 'ahora_no' and a.campana_id = l.paso_id) then 'ahora_no'
    when p_origen = 'primer_mensaje' and l.paso_id is null then 'sin_paso_abierto'
    when p_origen = 'primer_mensaje' and l.estado_cartera <> 'ACTIVA' then 'cartera_' || lower(l.estado_cartera)
  end
  from (select 1) uno
  left join l on true
  cross join r
  cross join ct
  cross join su
$$;

revoke execute on function public.crm_motivo_no_enviar(uuid, uuid, text) from public, anon, authenticated;

create or replace view public.crm_v_gext_operacion with (security_invoker = true) as
SELECT p.clave AS "ID Oportunidad",
    c.nombre AS "Cliente",
    v.apv AS "APV",
    v.fecha_factura AS "Fecha fact.",
    v.vin AS "VIN",
    c.telefono AS "Teléfono principal",
    c.telefono_origen AS "Origen teléfono",
    c.tiene_celular AS "Tiene celular",
    c.correo AS "Correo",
    c.es_contactable AS "Es contactable",
    c.motivo_no_contactable AS "Motivo no contactable",
    v.agencia AS "Agencia",
    v.modelo AS "Línea",
    v.version AS "Versión",
    v.ano_modelo AS "Año VIN",
    p.campana AS "Campaña",
    p.fase_campana AS "Etapa",
    p.fecha_inicio_campana AS "Inicio campaña",
        CASE
            WHEN p.cerrada_en IS NULL THEN o.estado_cartera
            WHEN o.estado_cartera = ANY (ARRAY['NO_EN_MAESTRA'::text, 'VENDIDA_BDC'::text, 'DESCARTADO'::text]) THEN o.estado_cartera
            WHEN v.tiene_ge OR o.estado_cartera = 'YA_TIENE_GE'::text THEN 'YA_TIENE_GE'::text
            WHEN c.es_contactable = false THEN 'NO_CONTACTABLE_FUENTE'::text
            ELSE 'FUERA_DE_VENTANA'::text
        END AS "Estado fuente",
    v.tiene_ge AS "Tiene GE",
        CASE
            WHEN p.cerrada_en IS NULL THEN o.resultado_bdc
            ELSE COALESCE(p.resultado_bdc, 'PENDIENTE'::text)
        END AS "Resultado BDC",
        CASE
            WHEN p.cerrada_en IS NULL THEN o.comentarios
            ELSE p.comentarios
        END AS "Comentarios",
        CASE
            WHEN p.cerrada_en IS NULL THEN o.fecha_ultimo_contacto
            ELSE p.fecha_ultimo_contacto
        END AS "Fecha último contacto",
        CASE
            WHEN p.cerrada_en IS NULL THEN o.fecha_compra
            ELSE p.fecha_compra
        END AS "Fecha compra",
        CASE
            WHEN p.cerrada_en IS NULL THEN o.ejecutivo
            ELSE p.ejecutivo
        END AS "Ejecutivo",
    COALESCE(p.ultima_sincronizacion, o.ultima_sincronizacion) AS "Última sincronización",
    p.sucursal_id,
    p.oportunidad_id,
    p.id AS paso_id,
    p.fecha_fin_campana AS fin_campana,
    p.abierta_en,
    p.cerrada_en,
    p.motivo_cierre,
    crm_etiqueta(p.sucursal_id, 'respuesta_titular'::text,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.respuesta_titular
            ELSE p.gestion ->> 'respuesta_titular'::text
        END) AS respuesta_titular,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.proximo_contacto_en
            ELSE (p.gestion ->> 'proximo_contacto_en'::text)::timestamp with time zone
        END AS proximo_contacto_en,
    crm_etiqueta(p.sucursal_id, 'motivo_no_interes'::text,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.motivo_no_interes
            ELSE p.gestion ->> 'motivo_no_interes'::text
        END) AS motivo_no_interes,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.declara_ge
            ELSE (p.gestion ->> 'declara_ge'::text)::boolean
        END AS declara_ge,
    crm_etiqueta(p.sucursal_id, 'donde_obtuvo_ge'::text,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.donde_obtuvo_ge
            ELSE p.gestion ->> 'donde_obtuvo_ge'::text
        END) AS donde_obtuvo_ge,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.fecha_compra_ge
            ELSE (p.gestion ->> 'fecha_compra_ge'::text)::date
        END AS fecha_compra_ge,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.conserva_auto
            ELSE (p.gestion ->> 'conserva_auto'::text)::boolean
        END AS conserva_auto,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.monto_cotizado
            ELSE (p.gestion ->> 'monto_cotizado'::text)::numeric
        END AS monto_cotizado,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.link_enviado_en
            ELSE (p.gestion ->> 'link_enviado_en'::text)::date
        END AS link_enviado_en,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.fecha_pago
            ELSE (p.gestion ->> 'fecha_pago'::text)::date
        END AS fecha_pago,
    crm_etiqueta(p.sucursal_id, 'origen_venta'::text,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.origen_venta
            ELSE p.gestion ->> 'origen_venta'::text
        END) AS origen_venta,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.escalar_posventa
            ELSE (p.gestion ->> 'escalar_posventa'::text)::boolean
        END AS escalar_posventa,
    crm_etiqueta(p.sucursal_id, 'clasificacion_respuesta'::text,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.clasificacion_respuesta
            ELSE p.gestion ->> 'clasificacion_respuesta'::text
        END) AS clasificacion_respuesta,
        CASE
            WHEN p.cerrada_en IS NULL THEN o.ultimo_contacto_efectivo_en
            ELSE (p.gestion ->> 'ultimo_contacto_efectivo_en'::text)::timestamp with time zone
        END AS ultimo_contacto_efectivo_en,
    p.primer_contacto_en,
        CASE
            WHEN p.cerrada_en IS NULL THEN eo.nombre
            ELSE ep.nombre
        END AS estado_lead,
    ( SELECT count(*)::integer AS count
           FROM crm_actividades a
          WHERE a.campana_id = p.id AND a.tipo = 'llamada'::text) AS intentos_llamada,
    ( SELECT count(*)::integer AS count
           FROM crm_actividades a
          WHERE a.campana_id = p.id AND a.tipo = 'whatsapp'::text) AS intentos_whatsapp,
    ( SELECT count(*)::integer AS count
           FROM crm_envios x
          WHERE x.campana_id = p.id AND (x.estado = ANY (ARRAY['simulado'::text, 'enviado'::text, 'entregado'::text, 'leido'::text]))) AS mensajes_masivos
   FROM crm_oportunidad_campanas p
     JOIN crm_oportunidades o ON o.id = p.oportunidad_id
     JOIN crm_contactos c ON c.id = o.contacto_id
     JOIN crm_vehiculos v ON v.id = o.vehiculo_id
     LEFT JOIN crm_etapas eo ON eo.id = o.etapa_id
     LEFT JOIN crm_etapas ep ON ep.id = p.etapa_id;

commit;

-- Reversa: volver a crm_motivo_no_enviar de 0039 y a la vista de 0030 (CASE de «Estado fuente» sin los estados nuevos).
