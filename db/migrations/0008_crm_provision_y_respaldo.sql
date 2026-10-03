/* 0008:
   - crm_config.sync_bigquery: la fuente nis_ge_cartera_maestra es de Granauto/Nissan; solo las sucursales
     con la bandera encendida se sincronizan con ella (antes bastaba con tener fila en crm_config).
   - La tabla plana original queda renombrada como respaldo: lo que la siga escribiendo (scripts viejos del
     Sheet) falla a la vista en vez de actualizar en silencio una tabla que ya nadie lee.
   - crm_provisionar_sucursal: deja una sucursal nueva lista para el CRM (embudo, etapas, motivos,
     configuración, entidad y panel por omisión). */

alter table public.crm_config add column if not exists sync_bigquery boolean not null default false;
update public.crm_config set sync_bigquery = true
 where sucursal_id in (select id from public.sucursales where subdominio = 'granauto');

do $$
begin
  if to_regclass('datos_granauto.garantias_extendidas') is not null
     and to_regclass('datos_granauto.garantias_extendidas_respaldo') is null then
    alter table datos_granauto.garantias_extendidas rename to garantias_extendidas_respaldo;
  end if;
end $$;

create or replace function public.crm_provisionar_sucursal(p_sucursal uuid) returns void
language plpgsql as $$
declare
  v_entidad uuid;
  v_panel jsonb;
begin
  perform public.crm_sembrar_sucursal(p_sucursal);
  insert into public.crm_config (sucursal_id) values (p_sucursal) on conflict (sucursal_id) do nothing;

  select id into v_entidad from public.entidad_definiciones where sucursal_id = p_sucursal;
  if v_entidad is not null then return; end if;  -- ya tiene entidad: no se pisa

  v_panel := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'tipo', 'busqueda', 'ancho', 1, 'color', null, 'valor', null,
      'columna', null, 'etiqueta', 'Búsqueda por texto', 'multiple', false, 'operador', null, 'principal', false),
    jsonb_build_object('id', gen_random_uuid()::text, 'tipo', 'desplegable', 'ancho', 1, 'color', null, 'valor', null,
      'columna', 'etapa_embudo', 'etiqueta', 'Etapa', 'multiple', true, 'operador', null, 'principal', false),
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
end $$;

revoke all on function public.crm_provisionar_sucursal(uuid) from public, anon, authenticated;
