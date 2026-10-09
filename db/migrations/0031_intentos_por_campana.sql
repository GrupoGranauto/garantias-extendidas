/*
  Intentos por llamada y por WhatsApp de la campaña en curso (Notion: «Intentos por canal» de la oportunidad), no de toda la
  vida del VIN: al entrar a otra campaña el lead empieza en cero, como «Intentos» y «Fecha del último intento», y como la
  fila de esa campaña en la vista GEXT. Sin campaña abierta, cero. Solo cambia esas dos columnas de la vista.
*/

create or replace view public.crm_v_oportunidades with (security_invoker = true) as
 SELECT o.id,
    o.sucursal_id,
    o.clave AS id_oportunidad,
    o.contacto_id,
    o.vehiculo_id,
    o.embudo_id,
    o.etapa_id,
    o.posicion,
    c.nombre AS cliente,
    v.apv,
    v.fecha_factura,
    v.vin,
    c.telefono AS telefono_principal,
    c.telefono_origen AS origen_telefono,
    c.tiene_celular,
    c.correo,
    c.es_contactable,
    c.motivo_no_contactable,
    v.agencia,
    v.modelo AS linea,
    v.version AS version_vehiculo,
    v.ano_modelo AS anio_vin,
    o.campana,
    o.fase_campana,
    o.fecha_inicio_campana AS inicio_campana,
    o.fecha_fin_campana AS fin_campana,
    o.proxima_campania,
    o.fecha_proxima_campania,
    o.motivo_no_elegible,
    o.estado_cartera AS estado_fuente,
    v.tiene_ge,
    e.nombre AS etapa_embudo,
    o.estado AS estado_oportunidad,
        CASE o.estado_contacto
            WHEN 'sin_intentar'::text THEN 'Sin intentar'::text
            WHEN 'intentando'::text THEN 'Intentando'::text
            WHEN 'contactado'::text THEN 'Contactado'::text
            WHEN 'buzon'::text THEN 'Buzón de voz'::text
            WHEN 'no_contactable'::text THEN 'No contactable'::text
            WHEN 'baja'::text THEN 'Baja'::text
            ELSE NULL::text
        END AS estado_contacto,
    o.intentos,
    mp.nombre AS motivo_perdida,
    o.comentarios,
    o.fecha_ultimo_contacto,
    o.fecha_compra,
    o.ejecutivo,
    o.entro_a_etapa_en,
    o.ultima_sincronizacion,
    o.creado_en,
    NULL::timestamp with time zone AS borrado_en,
    v.kilometraje,
    COALESCE(ce.nombre,
        CASE v.etapa_vehiculo_motivo
            WHEN 'excluido_km'::text THEN 'Excluido por km'::text
            WHEN 'excluido_fecha'::text THEN 'Excluido por fecha'::text
            WHEN 'aun_no'::text THEN 'Aún no entra'::text
            WHEN 'sin_datos'::text THEN 'Sin datos'::text
            WHEN 'sin_configurar'::text THEN 'Sin configurar'::text
            ELSE
            CASE
                WHEN (EXISTS ( SELECT 1
                   FROM crm_ciclo_etapas x
                  WHERE x.sucursal_id = o.sucursal_id)) THEN 'Sin calcular'::text
                ELSE 'Sin configurar'::text
            END
        END) AS etapa_vehiculo,
    v.etapa_vehiculo_motivo,
    o.resultado_bdc,
    -- 0030: campos de gestión del ejecutivo BDC (Notion). Las listas se muestran con la etiqueta del catálogo del grupo.
    crm_etiqueta(o.sucursal_id, 'respuesta_titular', o.respuesta_titular) AS respuesta_titular,
    o.proximo_contacto_en,
    crm_etiqueta(o.sucursal_id, 'motivo_no_interes', o.motivo_no_interes) AS motivo_no_interes,
    o.declara_ge,
    crm_etiqueta(o.sucursal_id, 'donde_obtuvo_ge', o.donde_obtuvo_ge) AS donde_obtuvo_ge,
    o.fecha_compra_ge,
    (o.declara_ge AND COALESCE(v.tiene_ge, false)) AS ge_validada,
    v.kilometraje_actualizado_en AS km_leido_en,
    o.conserva_auto,
    (SELECT min(b.i)::integer
       FROM unnest(COALESCE((SELECT pg.bandas_km FROM crm_programa_ge pg WHERE pg.sucursal_id = o.sucursal_id), '{15000,59000}'::integer[]))
            WITH ORDINALITY b(lim, i)
      WHERE v.kilometraje <= b.lim) AS periodo,
    (SELECT ct.plazo_meses FROM crm_contratos ct WHERE ct.oportunidad_id = o.id) AS plazo_meses,
    o.monto_cotizado,
    o.link_enviado_en,
    (o.fecha_pago IS NOT NULL OR EXISTS (SELECT 1 FROM crm_contratos ct WHERE ct.oportunidad_id = o.id
        AND ct.estado IN ('pago_confirmado', 'certificado_entregado', 'cobertura_iniciada'))) AS pagado,
    o.fecha_pago,
    crm_etiqueta(o.sucursal_id, 'origen_venta', o.origen_venta) AS origen_venta,
    CASE
      WHEN o.estado = 'ganada' THEN 'Ganada'
      WHEN c.whatsapp_baja OR o.estado_contacto = 'baja' THEN 'Baja'
      WHEN o.estado = 'perdida' THEN 'Perdida'
      WHEN o.estado_cartera <> 'ACTIVA' THEN 'Expirada'
      ELSE 'Abierta'
    END AS estado_calculado,
    c.whatsapp_baja AS no_contactar,
    o.escalar_posventa,
    (SELECT CASE x.estado WHEN 'simulado' THEN 'Simulado' WHEN 'enviado' THEN 'Enviado' WHEN 'entregado' THEN 'Entregado'
                          WHEN 'leido' THEN 'Leído' WHEN 'fallido' THEN 'Fallido' END
       FROM crm_envios x WHERE x.oportunidad_id = o.id AND x.estado IN ('simulado', 'enviado', 'entregado', 'leido', 'fallido')
      ORDER BY COALESCE(x.enviado_en, x.actualizado_en) DESC LIMIT 1) AS ultimo_mensaje_estado,
    (SELECT x.error
       FROM crm_envios x WHERE x.oportunidad_id = o.id AND x.estado IN ('simulado', 'enviado', 'entregado', 'leido', 'fallido')
      ORDER BY COALESCE(x.enviado_en, x.actualizado_en) DESC LIMIT 1) AS ultimo_mensaje_fallo,
    (SELECT COALESCE(x.enviado_en, x.actualizado_en)
       FROM crm_envios x WHERE x.oportunidad_id = o.id AND x.estado IN ('simulado', 'enviado', 'entregado', 'leido', 'fallido')
      ORDER BY COALESCE(x.enviado_en, x.actualizado_en) DESC LIMIT 1) AS ultimo_mensaje_en,
    (SELECT COALESCE(p.nombre, p.nombre_tecnico)
       FROM crm_envios x LEFT JOIN whatsapp_plantillas p ON p.id = x.plantilla_id
      WHERE x.oportunidad_id = o.id AND x.estado IN ('simulado', 'enviado', 'entregado', 'leido', 'fallido')
      ORDER BY COALESCE(x.enviado_en, x.actualizado_en) DESC LIMIT 1) AS ultima_plantilla,
    o.respuesta_por_clasificar,
    crm_etiqueta(o.sucursal_id, 'clasificacion_respuesta', o.clasificacion_respuesta) AS clasificacion_respuesta,
    (SELECT count(*)::integer FROM crm_actividades a WHERE a.campana_id = (SELECT p.id FROM crm_oportunidad_campanas p WHERE p.oportunidad_id = o.id AND p.cerrada_en IS NULL) AND a.tipo = 'llamada') AS intentos_llamada,
    (SELECT count(*)::integer FROM crm_actividades a WHERE a.campana_id = (SELECT p.id FROM crm_oportunidad_campanas p WHERE p.oportunidad_id = o.id AND p.cerrada_en IS NULL) AND a.tipo = 'whatsapp') AS intentos_whatsapp,
    o.ultimo_intento_en,
    o.ultimo_contacto_efectivo_en,
    CASE WHEN o.estado_cartera = 'ACTIVA' THEN (now() AT TIME ZONE 'America/Hermosillo')::date - o.fecha_inicio_campana END AS dias_en_campana,
    CASE WHEN o.estado_cartera = 'ACTIVA' THEN o.fecha_fin_campana - (now() AT TIME ZONE 'America/Hermosillo')::date END AS dias_para_cierre
   FROM crm_oportunidades o
     JOIN crm_contactos c ON c.id = o.contacto_id
     JOIN crm_vehiculos v ON v.id = o.vehiculo_id
     LEFT JOIN crm_etapas e ON e.id = o.etapa_id
     LEFT JOIN crm_motivos_perdida mp ON mp.id = o.motivo_perdida_id
     LEFT JOIN crm_ciclo_etapas ce ON ce.id = v.etapa_vehiculo_id;
