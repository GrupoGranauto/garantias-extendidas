/*
  «Resultado BDC» visible y editable en la base de datos: columna de la tabla (justo después de «Estado del lead»),
  filtro y dato disponible para la vista de la tarjeta. Las opciones (los 12 valores del Sheet) las pone el backend.

  - La vista crm_v_oportunidades gana la columna resultado_bdc al final (todo lo demás igual).
  - Sucursales existentes: el campo entra después de etapa_embudo y las posiciones siguientes se recorren.
  - Sucursales nuevas: la función de provisión lo siembra.
*/

create or replace view public.crm_v_oportunidades as
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
    o.resultado_bdc
   FROM crm_oportunidades o
     JOIN crm_contactos c ON c.id = o.contacto_id
     JOIN crm_vehiculos v ON v.id = o.vehiculo_id
     LEFT JOIN crm_etapas e ON e.id = o.etapa_id
     LEFT JOIN crm_motivos_perdida mp ON mp.id = o.motivo_perdida_id
     LEFT JOIN crm_ciclo_etapas ce ON ce.id = v.etapa_vehiculo_id;

update public.entidad_campos c
   set posicion = c.posicion + 1
  from public.entidad_definiciones d
 where d.id = c.entidad_id and d.nombre_tecnico = 'crm_v_oportunidades'
   and c.posicion > (select x.posicion from public.entidad_campos x where x.entidad_id = d.id and x.nombre_tecnico = 'etapa_embudo')
   and not exists (select 1 from public.entidad_campos y where y.entidad_id = d.id and y.nombre_tecnico = 'resultado_bdc');

insert into public.entidad_campos (entidad_id, nombre_tecnico, nombre_visible, tipo, origen, posicion, visible, editor_tipo, opciones)
select d.id, 'resultado_bdc', 'Resultado BDC', 'texto', 'back', x.posicion + 1, true, 'lista', '[]'::jsonb
  from public.entidad_definiciones d
  join public.entidad_campos x on x.entidad_id = d.id and x.nombre_tecnico = 'etapa_embudo'
 where d.nombre_tecnico = 'crm_v_oportunidades'
   and not exists (select 1 from public.entidad_campos y where y.entidad_id = d.id and y.nombre_tecnico = 'resultado_bdc');

create or replace function public.crm_provisionar_sucursal(p_sucursal uuid)
 returns void
 language plpgsql
as $function$
declare
  v_entidad uuid;
  v_panel jsonb;
begin
  perform public.crm_sembrar_sucursal(p_sucursal);
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
    (36, 'ultima_sincronizacion', 'Última sincronización', 'fecha_hora', 'api',  true,  false)
  ) as t(ord, n, v, tipo, origen, visible, lista);
end $function$;
