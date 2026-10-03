/* 0003: la entidad de Granauto pasa a leer de la vista relacional (columnas, panel de filtros y KPIs).
   Aplicar JUNTO con el despliegue del backend que entiende crm_v_oportunidades. */

/* Metadatos de la tabla del portal (Granauto). Columnas 'back' = las que captura la app. */
do $$
declare
  v_entidad uuid;
begin
  select d.id into v_entidad
  from public.entidad_definiciones d
  join public.sucursales s on s.id = d.sucursal_id
  where s.subdominio = 'granauto';
  if v_entidad is null then return; end if;

  update public.entidad_definiciones
     set nombre_tecnico = 'crm_v_oportunidades', actualizado_en = now()
   where id = v_entidad;

  delete from public.entidad_campos where entidad_id = v_entidad;

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
    (23, 'estado_fuente',         'Estado fuente',         'texto',      'api',  true,  false),
    (24, 'tiene_ge',              'Tiene GE',              'booleano',   'api',  false, false),
    (25, 'etapa_embudo',          'Etapa',                 'texto',      'back', true,  true),
    (26, 'estado_contacto',       'Estado de contacto',    'texto',      'back', true,  true),
    (27, 'intentos',              'Intentos',              'entero',     'api',  false, false),
    (28, 'motivo_perdida',        'Motivo de pérdida',     'texto',      'back', true,  true),
    (29, 'comentarios',           'Comentarios',           'texto',      'back', true,  false),
    (30, 'fecha_ultimo_contacto', 'Fecha último contacto', 'fecha',      'back', true,  false),
    (31, 'fecha_compra',          'Fecha compra',          'fecha',      'back', true,  false),
    (32, 'ejecutivo',             'Ejecutivo',             'texto',      'back', true,  true),
    (33, 'estado_oportunidad',    'Estado oportunidad',    'texto',      'api',  false, false),
    (34, 'entro_a_etapa_en',      'En la etapa desde',     'fecha_hora', 'api',  true,  false),
    (35, 'ultima_sincronizacion', 'Última sincronización', 'fecha_hora', 'api',  true,  false)
  ) as t(ord, n, v, tipo, origen, visible, lista);

  -- El panel de filtros y KPIs hablaba de columnas de la tabla plana: se traduce al modelo nuevo.
  update public.entidad_definiciones d
     set panel = coalesce((
       select jsonb_agg(
         case
           when e->>'columna' = 'etapa'
             then e || jsonb_build_object('columna', 'fase_campana', 'etiqueta', 'Fase campaña')
           when e->>'columna' = 'resultado_bdc' and e->>'valor' = 'Buzón de voz'
             then e || jsonb_build_object('columna', 'estado_contacto')
           when e->>'columna' = 'resultado_bdc' and e->>'valor' = 'Pendiente'
             then e || jsonb_build_object('columna', 'estado_contacto', 'valor', 'Sin intentar')
           when e->>'columna' = 'resultado_bdc'
             then e || jsonb_build_object('columna', 'etapa_embudo')
                    || case when e->>'tipo' = 'desplegable' then jsonb_build_object('etiqueta', 'Etapa') else '{}'::jsonb end
           else e
         end order by ord)
       from jsonb_array_elements(d.panel) with ordinality as x(e, ord)
     ), '[]'::jsonb)
   where d.id = v_entidad;
end $$;
