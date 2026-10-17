/*
  Llamadas en la campaña, como filtro de la tabla (pedido de Miguel Borbón, 16-oct-2026).

  llamadas_campana: cuántas llamadas lleva el lead en su campaña actual (paso abierto), agrupado para filtrar: «Sin
  llamadas», «1 llamada», «2 llamadas» o «3 o más llamadas». Es el mismo conteo que intentos_llamada. Se agrega al final de
  la vista (sin tocar las columnas que ya existían) y como campo visible de la tabla del portal, en las sucursales que ya
  existen y en las nuevas.
*/
begin;
set local lock_timeout = '5s';

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
    crm_etiqueta(o.sucursal_id, 'respuesta_titular'::text, o.respuesta_titular) AS respuesta_titular,
    o.proximo_contacto_en,
    crm_etiqueta(o.sucursal_id, 'motivo_no_interes'::text, o.motivo_no_interes) AS motivo_no_interes,
    o.declara_ge,
    crm_etiqueta(o.sucursal_id, 'donde_obtuvo_ge'::text, o.donde_obtuvo_ge) AS donde_obtuvo_ge,
    o.fecha_compra_ge,
    o.declara_ge AND COALESCE(v.tiene_ge, false) AS ge_validada,
    v.kilometraje_actualizado_en AS km_leido_en,
    o.conserva_auto,
    ( SELECT min(b.i)::integer AS min
           FROM unnest(COALESCE(( SELECT pg.bandas_km
                   FROM crm_programa_ge pg
                  WHERE pg.sucursal_id = o.sucursal_id), '{15000,59000}'::integer[])) WITH ORDINALITY b(lim, i)
          WHERE v.kilometraje <= b.lim) AS periodo,
    ( SELECT ct.plazo_meses
           FROM crm_contratos ct
          WHERE ct.oportunidad_id = o.id) AS plazo_meses,
    o.monto_cotizado,
    o.link_enviado_en,
    o.fecha_pago IS NOT NULL OR (EXISTS ( SELECT 1
           FROM crm_contratos ct
          WHERE ct.oportunidad_id = o.id AND (ct.estado = ANY (ARRAY['pago_confirmado'::text, 'certificado_entregado'::text, 'cobertura_iniciada'::text])))) AS pagado,
    o.fecha_pago,
    crm_etiqueta(o.sucursal_id, 'origen_venta'::text, o.origen_venta) AS origen_venta,
        CASE
            WHEN o.estado = 'ganada'::text THEN 'Ganada'::text
            WHEN c.whatsapp_baja OR o.estado_contacto = 'baja'::text THEN 'Baja'::text
            WHEN o.estado = 'perdida'::text THEN 'Perdida'::text
            WHEN o.estado_cartera <> 'ACTIVA'::text THEN 'Expirada'::text
            ELSE 'Abierta'::text
        END AS estado_calculado,
    c.whatsapp_baja AS no_contactar,
    o.escalar_posventa,
    ( SELECT
                CASE x.estado
                    WHEN 'simulado'::text THEN 'Simulado'::text
                    WHEN 'enviado'::text THEN 'Enviado'::text
                    WHEN 'entregado'::text THEN 'Entregado'::text
                    WHEN 'leido'::text THEN 'Leído'::text
                    WHEN 'fallido'::text THEN 'Fallido'::text
                    ELSE NULL::text
                END AS "case"
           FROM crm_envios x
          WHERE x.oportunidad_id = o.id AND (x.estado = ANY (ARRAY['simulado'::text, 'enviado'::text, 'entregado'::text, 'leido'::text, 'fallido'::text]))
          ORDER BY (COALESCE(x.enviado_en, x.actualizado_en)) DESC
         LIMIT 1) AS ultimo_mensaje_estado,
    ( SELECT x.error
           FROM crm_envios x
          WHERE x.oportunidad_id = o.id AND (x.estado = ANY (ARRAY['simulado'::text, 'enviado'::text, 'entregado'::text, 'leido'::text, 'fallido'::text]))
          ORDER BY (COALESCE(x.enviado_en, x.actualizado_en)) DESC
         LIMIT 1) AS ultimo_mensaje_fallo,
    ( SELECT COALESCE(x.enviado_en, x.actualizado_en) AS "coalesce"
           FROM crm_envios x
          WHERE x.oportunidad_id = o.id AND (x.estado = ANY (ARRAY['simulado'::text, 'enviado'::text, 'entregado'::text, 'leido'::text, 'fallido'::text]))
          ORDER BY (COALESCE(x.enviado_en, x.actualizado_en)) DESC
         LIMIT 1) AS ultimo_mensaje_en,
    ( SELECT COALESCE(p.nombre, p.nombre_tecnico) AS "coalesce"
           FROM crm_envios x
             LEFT JOIN whatsapp_plantillas p ON p.id = x.plantilla_id
          WHERE x.oportunidad_id = o.id AND (x.estado = ANY (ARRAY['simulado'::text, 'enviado'::text, 'entregado'::text, 'leido'::text, 'fallido'::text]))
          ORDER BY (COALESCE(x.enviado_en, x.actualizado_en)) DESC
         LIMIT 1) AS ultima_plantilla,
    o.respuesta_por_clasificar,
    crm_etiqueta(o.sucursal_id, 'clasificacion_respuesta'::text, o.clasificacion_respuesta) AS clasificacion_respuesta,
    ( SELECT count(*)::integer AS count
           FROM crm_actividades a
          WHERE a.campana_id = (( SELECT p.id
                   FROM crm_oportunidad_campanas p
                  WHERE p.oportunidad_id = o.id AND p.cerrada_en IS NULL)) AND a.tipo = 'llamada'::text) AS intentos_llamada,
    ( SELECT count(*)::integer AS count
           FROM crm_actividades a
          WHERE a.campana_id = (( SELECT p.id
                   FROM crm_oportunidad_campanas p
                  WHERE p.oportunidad_id = o.id AND p.cerrada_en IS NULL)) AND a.tipo = 'whatsapp'::text) AS intentos_whatsapp,
    o.ultimo_intento_en,
    o.ultimo_contacto_efectivo_en,
        CASE
            WHEN o.estado_cartera = 'ACTIVA'::text THEN (now() AT TIME ZONE 'America/Hermosillo'::text)::date - o.fecha_inicio_campana
            ELSE NULL::integer
        END AS dias_en_campana,
        CASE
            WHEN o.estado_cartera = 'ACTIVA'::text THEN o.fecha_fin_campana - (now() AT TIME ZONE 'America/Hermosillo'::text)::date
            ELSE NULL::integer
        END AS dias_para_cierre,
    NULLIF(TRIM(BOTH FROM c.nombre_pila), ''::text) AS nombre_pila,
        CASE ( SELECT count(*)::integer AS count
               FROM crm_actividades a
              WHERE a.campana_id = (( SELECT p.id
                       FROM crm_oportunidad_campanas p
                      WHERE p.oportunidad_id = o.id AND p.cerrada_en IS NULL)) AND a.tipo = 'llamada'::text)
            WHEN 0 THEN 'Sin llamadas'::text
            WHEN 1 THEN '1 llamada'::text
            WHEN 2 THEN '2 llamadas'::text
            ELSE '3 o más llamadas'::text
        END AS llamadas_campana
   FROM crm_oportunidades o
     JOIN crm_contactos c ON c.id = o.contacto_id
     JOIN crm_vehiculos v ON v.id = o.vehiculo_id
     LEFT JOIN crm_etapas e ON e.id = o.etapa_id
     LEFT JOIN crm_motivos_perdida mp ON mp.id = o.motivo_perdida_id
     LEFT JOIN crm_ciclo_etapas ce ON ce.id = v.etapa_vehiculo_id;

-- ---------- Campo de la tabla del portal (sucursales existentes) ----------
insert into public.entidad_campos (entidad_id, nombre_tecnico, nombre_visible, tipo, origen, posicion, visible, editor_tipo, opciones)
select d.id, 'llamadas_campana', 'Llamadas en la campaña', 'texto', 'api',
       (select max(x.posicion) from public.entidad_campos x where x.entidad_id = d.id) + 1,
       true, 'texto', '[]'::jsonb
  from public.entidad_definiciones d
 where d.nombre_tecnico = 'crm_v_oportunidades'
   and not exists (select 1 from public.entidad_campos y where y.entidad_id = d.id and y.nombre_tecnico = 'llamadas_campana');

-- ---------- Sucursales nuevas ----------
CREATE OR REPLACE FUNCTION public.crm_provisionar_sucursal(p_sucursal uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_entidad uuid;
  v_panel jsonb;
begin
  perform public.crm_sembrar_sucursal(p_sucursal);
  perform public.crm_sembrar_catalogos(p_sucursal);
  insert into public.crm_config (sucursal_id) values (p_sucursal) on conflict (sucursal_id) do nothing;

  select id into v_entidad from public.entidad_definiciones where sucursal_id = p_sucursal;
  if v_entidad is not null then return; end if;

  v_panel := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'tipo', 'busqueda', 'ancho', 1, 'color', null, 'valor', null,
      'columna', null, 'etiqueta', 'Búsqueda por texto', 'multiple', false, 'operador', null, 'principal', false),
    jsonb_build_object('id', gen_random_uuid()::text, 'tipo', 'desplegable', 'ancho', 1, 'color', null, 'valor', null,
      'columna', 'etapa_embudo', 'etiqueta', 'Estado del lead', 'multiple', true, 'operador', null, 'principal', false),
    jsonb_build_object('id', gen_random_uuid()::text, 'tipo', 'desplegable', 'ancho', 1, 'color', null, 'valor', null,
      'columna', 'ejecutivo', 'etiqueta', 'Ejecutivo', 'multiple', false, 'operador', null, 'principal', false),
    jsonb_build_object('id', gen_random_uuid()::text, 'tipo', 'kpi', 'ancho', 1, 'color', '#111827', 'valor', null,
      'columna', null, 'etiqueta', 'Oportunidades', 'multiple', false, 'operador', null, 'principal', false)
  );

  insert into public.entidad_definiciones (sucursal_id, nombre_tecnico, nombre_visible, columna_ejecutivo, panel)
  values (p_sucursal, 'crm_v_oportunidades', 'Oportunidades', 'ejecutivo', v_panel)
  returning id into v_entidad;

  insert into public.entidad_campos
    (entidad_id, nombre_tecnico, nombre_visible, tipo, origen, posicion, visible, editor_tipo, opciones)
  select v_entidad, t.n, t.v, t.tipo, t.origen, t.ord - 1, t.visible, case when t.lista then 'lista' else 'texto' end, '[]'::jsonb
  from (values
    (1,  'id_oportunidad',        'ID Oportunidad',        'texto',      'api',  false, false),
    (2,  'cliente',               'Cliente',               'texto',      'api',  true,  false),
    (3,  'apv',                   'APV',                   'texto',      'api',  true,  false),
    (4,  'fecha_factura',         'Fecha factura',         'fecha',      'api',  true,  false),
    (5,  'vin',                   'VIN',                   'texto',      'api',  true,  false),
    (6,  'telefono_principal',    'Teléfono',              'texto',      'api',  true,  false),
    (7,  'origen_telefono',       'Origen teléfono',       'texto',      'api',  false, false),
    (8,  'tiene_celular',         'Tiene celular',         'booleano',   'api',  false, false),
    (9,  'correo',                'Correo',                'texto',      'api',  true,  false),
    (10, 'es_contactable',        'Es contactable',        'booleano',   'api',  false, false),
    (11, 'motivo_no_contactable', 'Motivo no contactable', 'texto',      'api',  false, false),
    (12, 'agencia',               'Agencia',               'texto',      'api',  true,  false),
    (13, 'linea',                 'Línea',                 'texto',      'api',  true,  false),
    (14, 'version_vehiculo',      'Versión',               'texto',      'api',  true,  false),
    (15, 'anio_vin',              'Año VIN',               'entero',     'api',  true,  false),
    (16, 'campana',               'Campaña',               'texto',      'api',  true,  false),
    (17, 'fase_campana',          'Fase campaña',          'texto',      'api',  true,  false),
    (18, 'inicio_campana',        'Inicio campaña',        'fecha',      'api',  false, false),
    (19, 'fin_campana',           'Fin campaña',           'fecha',      'api',  false, false),
    (20, 'proxima_campania',      'Próxima campaña',       'texto',      'api',  false, false),
    (21, 'fecha_proxima_campania','Fecha próxima campaña', 'fecha',      'api',  false, false),
    (22, 'motivo_no_elegible',    'Motivo no elegible',    'texto',      'api',  false, false),
    (23, 'estado_fuente',         'Cartera',               'texto',      'api',  true,  false),
    (24, 'tiene_ge',              'Tiene GE',              'booleano',   'api',  false, false),
    (25, 'etapa_embudo',          'Estado del lead',       'texto',      'back', true,  true),
    (26, 'resultado_bdc',         'Resultado BDC',         'texto',      'back', true,  true),
    (27, 'estado_contacto',       'Contacto',              'texto',      'back', true,  true),
    (28, 'intentos',              'Intentos',              'entero',     'api',  false, false),
    (29, 'motivo_perdida',        'Motivo de pérdida',     'texto',      'back', true,  true),
    (30, 'comentarios',           'Comentarios',           'texto',      'back', true,  false),
    (31, 'fecha_ultimo_contacto', 'Fecha último contacto', 'fecha',      'back', true,  false),
    (32, 'fecha_compra',          'Fecha de compra de la garantía', 'fecha', 'back', true,  false),
    (33, 'ejecutivo',             'Ejecutivo',             'texto',      'back', true,  true),
    (34, 'estado_oportunidad',    'Resultado',             'texto',      'api',  false, false),
    (35, 'entro_a_etapa_en',      'En el estado desde',    'fecha_hora', 'api',  true,  false),
    (36, 'ultima_sincronizacion', 'Última sincronización', 'fecha_hora', 'api',  true,  false),
    (37, 'respuesta_titular', 'Respuesta del titular', 'texto', 'back', true, true),
    (38, 'proximo_contacto_en', 'Próximo contacto', 'fecha_hora', 'back', true, false),
    (39, 'motivo_no_interes', 'Motivo de no interés', 'texto', 'back', false, true),
    (40, 'declara_ge', 'Cliente declara tener GE', 'booleano', 'back', false, false),
    (41, 'donde_obtuvo_ge', 'Dónde obtuvo la GE', 'texto', 'back', false, true),
    (42, 'fecha_compra_ge', 'Fecha aprox. de compra de la GE', 'fecha', 'back', false, false),
    (43, 'ge_validada', 'GE validada en cartera', 'booleano', 'api', false, false),
    (44, 'km_leido_en', 'Fecha de lectura del km', 'fecha_hora', 'api', false, false),
    (45, 'conserva_auto', 'Conserva el auto', 'booleano', 'back', false, false),
    (46, 'periodo', 'Periodo', 'entero', 'api', false, false),
    (47, 'plazo_meses', 'Plazo adicional (meses)', 'entero', 'api', false, false),
    (48, 'monto_cotizado', 'Monto cotizado', 'decimal', 'back', false, false),
    (49, 'link_enviado_en', 'Fecha de envío del link', 'fecha', 'back', false, false),
    (50, 'pagado', 'Pagado', 'booleano', 'api', false, false),
    (51, 'fecha_pago', 'Fecha de pago', 'fecha', 'back', false, false),
    (52, 'origen_venta', 'Origen de la venta', 'texto', 'back', false, true),
    (53, 'estado_calculado', 'Estado de la oportunidad', 'texto', 'api', false, false),
    (54, 'no_contactar', 'No contactar', 'booleano', 'api', false, false),
    (55, 'escalar_posventa', 'Escalar a posventa', 'booleano', 'back', false, false),
    (56, 'ultimo_mensaje_estado', 'Estado del último mensaje', 'texto', 'api', false, false),
    (57, 'ultimo_mensaje_fallo', 'Motivo del fallo', 'texto', 'api', false, false),
    (58, 'ultimo_mensaje_en', 'Fecha del último mensaje', 'fecha_hora', 'api', false, false),
    (59, 'ultima_plantilla', 'Plantilla enviada', 'texto', 'api', false, false),
    (60, 'respuesta_por_clasificar', 'Respuesta por clasificar', 'booleano', 'api', false, false),
    (61, 'clasificacion_respuesta', 'Clasificación de la respuesta', 'texto', 'back', false, true),
    (62, 'intentos_llamada', 'Intentos por llamada', 'entero', 'api', false, false),
    (63, 'intentos_whatsapp', 'Intentos por WhatsApp', 'entero', 'api', false, false),
    (64, 'ultimo_intento_en', 'Fecha del último intento', 'fecha_hora', 'api', false, false),
    (65, 'ultimo_contacto_efectivo_en', 'Último contacto efectivo', 'fecha_hora', 'api', false, false),
    (66, 'dias_en_campana', 'Días en campaña', 'entero', 'api', false, false),
    (67, 'dias_para_cierre', 'Días para cierre de ventana', 'entero', 'api', false, false),
    (68, 'nombre_pila', 'Nombre (para saludar)', 'texto', 'api', false, false),
    (69, 'llamadas_campana', 'Llamadas en la campaña', 'texto', 'api', true, false)
  ) as t(ord, n, v, tipo, origen, visible, lista);
end $function$;

commit;

-- Reversa: quitar el campo de entidad_campos y volver a la vista y a crm_provisionar_sucursal de 0035.
