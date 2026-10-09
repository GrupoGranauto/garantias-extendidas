/*
  Campos de gestión del ejecutivo BDC, de la revisión en Notion («Pipeline y campos del ejecutivo BDC», tabla «Campos de
  la oportunidad · revisión»): los que no están marcados para eliminar y que el Sheet no tiene.

  - Catálogos por grupo con códigos fijos (crm_catalogo_opciones): respuesta del titular, motivo de no interés, dónde obtuvo
    la GE, origen de la venta y clasificación de la respuesta. El BI compara por código; el portal muestra la etiqueta.
  - Motivos de cierre de Notion como motivos de pérdida (ya tiene GE, ya no tiene el auto, flotilla, pidió baja…).
  - Columnas nuevas en el lead; «no contactar» vive en el contacto (whatsapp_baja) y gana el canal de la solicitud.
  - La foto del paso al cerrarse guarda también la gestión (gestion jsonb), para el historial y la vista GEXT.
  - crm_v_oportunidades gana las columnas al final (con los calculados de Notion) y la tabla del portal sus campos,
    casi todos ocultos de inicio: el admin decide cuáles ver.
  Solo agrega: lo que corre hoy sigue igual.
*/

-- ---------- Catálogos por grupo ----------
create table public.crm_catalogo_opciones (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  catalogo text not null check (catalogo in ('respuesta_titular', 'motivo_no_interes', 'donde_obtuvo_ge', 'origen_venta', 'clasificacion_respuesta')),
  clave text not null check (clave ~ '^[A-Z][A-Z0-9_]*$'),
  etiqueta text not null,
  orden integer not null default 0,
  activo boolean not null default true,
  unique (sucursal_id, catalogo, clave),
  unique (sucursal_id, catalogo, etiqueta)
);
alter table public.crm_catalogo_opciones enable row level security;
revoke all on public.crm_catalogo_opciones from anon, authenticated;

create or replace function public.crm_etiqueta(p_sucursal uuid, p_catalogo text, p_clave text)
 returns text
 language sql
 stable
as $$
  select coalesce((select k.etiqueta from public.crm_catalogo_opciones k
                    where k.sucursal_id = p_sucursal and k.catalogo = p_catalogo and k.clave = p_clave), p_clave)
$$;

create or replace function public.crm_sembrar_catalogos(p_sucursal uuid)
 returns void
 language sql
as $$
  insert into public.crm_catalogo_opciones (sucursal_id, catalogo, clave, etiqueta, orden)
  select p_sucursal, t.catalogo, t.clave, t.etiqueta, t.orden from (values
      ('respuesta_titular', 'PIDE_INFORMACION', 'Pide información', 1),
      ('respuesta_titular', 'PIDE_PRECIO', 'Pide precio o cotización', 2),
      ('respuesta_titular', 'QUIERE_PAGAR', 'Quiere pagar ya', 3),
      ('respuesta_titular', 'LLAMAR_DESPUES', 'Llamar después', 4),
      ('respuesta_titular', 'LO_VA_A_PENSAR', 'Lo va a pensar', 5),
      ('respuesta_titular', 'NO_INTERESADO', 'No interesado', 6),
      ('respuesta_titular', 'YA_TIENE_GE', 'Ya tiene GE', 7),
      ('respuesta_titular', 'YA_NO_TIENE_AUTO', 'Ya no tiene el auto', 8),
      ('respuesta_titular', 'FLOTILLA', 'Es flotilla o empresa', 9),
      ('respuesta_titular', 'QUEJA_SERVICIO', 'Queja de servicio', 10),
      ('respuesta_titular', 'NO_CONTACTAR', 'Pide no ser contactado', 11),
      ('motivo_no_interes', 'PRECIO_ALTO', 'Precio alto', 1),
      ('motivo_no_interes', 'NO_LO_NECESITA', 'No lo necesita', 2),
      ('motivo_no_interes', 'VA_A_VENDER', 'Va a vender el auto', 3),
      ('motivo_no_interes', 'MALA_EXPERIENCIA', 'Mala experiencia con la agencia', 4),
      ('motivo_no_interes', 'TALLER_EXTERNO', 'Prefiere taller externo', 5),
      ('motivo_no_interes', 'OTRO', 'Otro', 6),
      ('donde_obtuvo_ge', 'AL_COMPRAR', 'Al comprar el auto', 1),
      ('donde_obtuvo_ge', 'ESTA_AGENCIA', 'Después, en esta agencia', 2),
      ('donde_obtuvo_ge', 'CALL_CENTER', 'Por llamada de otro proveedor o call center', 3),
      ('donde_obtuvo_ge', 'OTRA_AGENCIA', 'En otra agencia', 4),
      ('donde_obtuvo_ge', 'NO_SABE', 'No sabe', 5),
      ('origen_venta', 'BDC', 'BDC', 1),
      ('origen_venta', 'MOSTRADOR', 'Mostrador (al vender el auto)', 2),
      ('origen_venta', 'SERVICIO', 'Servicio', 3),
      ('origen_venta', 'ORGANICA', 'Orgánica', 4),
      ('clasificacion_respuesta', 'TITULAR', 'Titular', 1),
      ('clasificacion_respuesta', 'OTRA_PERSONA', 'Otra persona', 2),
      ('clasificacion_respuesta', 'BAJA', 'Pide baja o STOP', 3),
      ('clasificacion_respuesta', 'SPAM', 'Spam o no relacionado', 4),
      ('clasificacion_respuesta', 'NUMERO_EQUIVOCADO', 'Número equivocado', 5)
  ) as t(catalogo, clave, etiqueta, orden)
  on conflict do nothing;

  insert into public.crm_motivos_perdida (sucursal_id, clave, nombre, orden)
  select p_sucursal, t.clave, t.nombre, t.orden from (values
      ('ya_tiene_ge', 'Ya tiene GE', 10),
      ('ya_no_tiene_auto', 'Ya no tiene el auto', 11),
      ('flotilla', 'Flotilla o empresa', 12),
      ('fuera_km_tiempo', 'Fuera de km o tiempo', 13),
      ('uso_no_elegible', 'Uso no elegible', 14),
      ('sin_respuesta_ventana', 'Sin respuesta al terminar la ventana', 15),
      ('pidio_baja', 'Pidió baja', 16)
  ) as t(clave, nombre, orden)
  on conflict do nothing;
$$;

select public.crm_sembrar_catalogos(id) from public.sucursales;

-- ---------- Columnas ----------
alter table public.crm_oportunidades
  add column respuesta_titular text,
  add column proximo_contacto_en timestamptz,
  add column motivo_no_interes text,
  add column declara_ge boolean not null default false,
  add column donde_obtuvo_ge text,
  add column fecha_compra_ge date,
  add column conserva_auto boolean,
  add column monto_cotizado numeric(12, 2) check (monto_cotizado is null or monto_cotizado >= 0),
  add column link_enviado_en date,
  add column fecha_pago date,
  add column origen_venta text,
  add column escalar_posventa boolean not null default false,
  add column respuesta_por_clasificar boolean not null default false,
  add column clasificacion_respuesta text,
  add column ultimo_contacto_efectivo_en timestamptz;

create index crm_oportunidades_proximo_contacto_idx on public.crm_oportunidades (sucursal_id, proximo_contacto_en)
  where proximo_contacto_en is not null;

-- Canal por el que pidió no ser contactado (la baja ya vive en el contacto).
alter table public.crm_contactos
  add column baja_canal text check (baja_canal in ('llamada', 'whatsapp', 'correo', 'presencial', 'sms'));

-- Foto de la gestión al cerrar el paso.
alter table public.crm_oportunidad_campanas add column gestion jsonb;

-- Último contacto efectivo: lo que ya hay en el historial (contestó la llamada o el cliente escribió).
update public.crm_oportunidades o set ultimo_contacto_efectivo_en = x.t
  from (select a.oportunidad_id, max(a.creado_en) as t from public.crm_actividades a
         where a.tipo = 'mensaje_entrante' or (a.tipo in ('llamada', 'whatsapp') and a.detalle->>'resultado' in ('contesto', 'CONTESTA_TITULAR'))
         group by a.oportunidad_id) x
 where x.oportunidad_id = o.id;

-- ---------- Vista de la tabla ----------
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
    (SELECT count(*)::integer FROM crm_actividades a WHERE a.oportunidad_id = o.id AND a.tipo = 'llamada') AS intentos_llamada,
    (SELECT count(*)::integer FROM crm_actividades a WHERE a.oportunidad_id = o.id AND a.tipo = 'whatsapp') AS intentos_whatsapp,
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

-- ---------- Campos de la tabla del portal (sucursales existentes) ----------
insert into public.entidad_campos (entidad_id, nombre_tecnico, nombre_visible, tipo, origen, posicion, visible, editor_tipo, opciones)
select d.id, t.n, t.v, t.tipo, t.origen,
       (select max(x.posicion) from public.entidad_campos x where x.entidad_id = d.id) + t.ord,
       t.visible, case when t.lista then 'lista' else 'texto' end, '[]'::jsonb
  from public.entidad_definiciones d
 cross join (values
    (1, 'respuesta_titular', 'Respuesta del titular', 'texto', 'back', true, true),
    (2, 'proximo_contacto_en', 'Próximo contacto', 'fecha_hora', 'back', true, false),
    (3, 'motivo_no_interes', 'Motivo de no interés', 'texto', 'back', false, true),
    (4, 'declara_ge', 'Cliente declara tener GE', 'booleano', 'back', false, false),
    (5, 'donde_obtuvo_ge', 'Dónde obtuvo la GE', 'texto', 'back', false, true),
    (6, 'fecha_compra_ge', 'Fecha aprox. de compra de la GE', 'fecha', 'back', false, false),
    (7, 'ge_validada', 'GE validada en cartera', 'booleano', 'api', false, false),
    (8, 'km_leido_en', 'Fecha de lectura del km', 'fecha_hora', 'api', false, false),
    (9, 'conserva_auto', 'Conserva el auto', 'booleano', 'back', false, false),
    (10, 'periodo', 'Periodo', 'entero', 'api', false, false),
    (11, 'plazo_meses', 'Plazo adicional (meses)', 'entero', 'api', false, false),
    (12, 'monto_cotizado', 'Monto cotizado', 'decimal', 'back', false, false),
    (13, 'link_enviado_en', 'Fecha de envío del link', 'fecha', 'back', false, false),
    (14, 'pagado', 'Pagado', 'booleano', 'api', false, false),
    (15, 'fecha_pago', 'Fecha de pago', 'fecha', 'back', false, false),
    (16, 'origen_venta', 'Origen de la venta', 'texto', 'back', false, true),
    (17, 'estado_calculado', 'Estado de la oportunidad', 'texto', 'api', false, false),
    (18, 'no_contactar', 'No contactar', 'booleano', 'api', false, false),
    (19, 'escalar_posventa', 'Escalar a posventa', 'booleano', 'back', false, false),
    (20, 'ultimo_mensaje_estado', 'Estado del último mensaje', 'texto', 'api', false, false),
    (21, 'ultimo_mensaje_fallo', 'Motivo del fallo', 'texto', 'api', false, false),
    (22, 'ultimo_mensaje_en', 'Fecha del último mensaje', 'fecha_hora', 'api', false, false),
    (23, 'ultima_plantilla', 'Plantilla enviada', 'texto', 'api', false, false),
    (24, 'respuesta_por_clasificar', 'Respuesta por clasificar', 'booleano', 'api', false, false),
    (25, 'clasificacion_respuesta', 'Clasificación de la respuesta', 'texto', 'back', false, true),
    (26, 'intentos_llamada', 'Intentos por llamada', 'entero', 'api', false, false),
    (27, 'intentos_whatsapp', 'Intentos por WhatsApp', 'entero', 'api', false, false),
    (28, 'ultimo_intento_en', 'Fecha del último intento', 'fecha_hora', 'api', false, false),
    (29, 'ultimo_contacto_efectivo_en', 'Último contacto efectivo', 'fecha_hora', 'api', false, false),
    (30, 'dias_en_campana', 'Días en campaña', 'entero', 'api', false, false),
    (31, 'dias_para_cierre', 'Días para cierre de ventana', 'entero', 'api', false, false)
  ) as t(ord, n, v, tipo, origen, visible, lista)
 where d.nombre_tecnico = 'crm_v_oportunidades'
   and not exists (select 1 from public.entidad_campos y where y.entidad_id = d.id and y.nombre_tecnico = t.n);

-- ---------- Sucursales nuevas ----------
create or replace function public.crm_provisionar_sucursal(p_sucursal uuid)
 returns void
 language plpgsql
as $function$
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
    (67, 'dias_para_cierre', 'Días para cierre de ventana', 'entero', 'api', false, false)
  ) as t(ord, n, v, tipo, origen, visible, lista);
end $function$;

-- ---------- Vista igual a GEXT_OPERACION: la gestión después de Z ----------
create or replace view public.crm_v_gext_operacion with (security_invoker = true) as
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
  p.motivo_cierre,
  -- 0030: gestión del BDC (Notion). En curso se lee del lead; cerrado, de la foto del paso.
  public.crm_etiqueta(p.sucursal_id, 'respuesta_titular', case when p.cerrada_en is null then o.respuesta_titular else (p.gestion->>'respuesta_titular')::text end) as respuesta_titular,
  case when p.cerrada_en is null then o.proximo_contacto_en else (p.gestion->>'proximo_contacto_en')::timestamptz end as proximo_contacto_en,
  public.crm_etiqueta(p.sucursal_id, 'motivo_no_interes', case when p.cerrada_en is null then o.motivo_no_interes else (p.gestion->>'motivo_no_interes')::text end) as motivo_no_interes,
  case when p.cerrada_en is null then o.declara_ge else (p.gestion->>'declara_ge')::boolean end as declara_ge,
  public.crm_etiqueta(p.sucursal_id, 'donde_obtuvo_ge', case when p.cerrada_en is null then o.donde_obtuvo_ge else (p.gestion->>'donde_obtuvo_ge')::text end) as donde_obtuvo_ge,
  case when p.cerrada_en is null then o.fecha_compra_ge else (p.gestion->>'fecha_compra_ge')::date end as fecha_compra_ge,
  case when p.cerrada_en is null then o.conserva_auto else (p.gestion->>'conserva_auto')::boolean end as conserva_auto,
  case when p.cerrada_en is null then o.monto_cotizado else (p.gestion->>'monto_cotizado')::numeric end as monto_cotizado,
  case when p.cerrada_en is null then o.link_enviado_en else (p.gestion->>'link_enviado_en')::date end as link_enviado_en,
  case when p.cerrada_en is null then o.fecha_pago else (p.gestion->>'fecha_pago')::date end as fecha_pago,
  public.crm_etiqueta(p.sucursal_id, 'origen_venta', case when p.cerrada_en is null then o.origen_venta else (p.gestion->>'origen_venta')::text end) as origen_venta,
  case when p.cerrada_en is null then o.escalar_posventa else (p.gestion->>'escalar_posventa')::boolean end as escalar_posventa,
  public.crm_etiqueta(p.sucursal_id, 'clasificacion_respuesta', case when p.cerrada_en is null then o.clasificacion_respuesta else (p.gestion->>'clasificacion_respuesta')::text end) as clasificacion_respuesta,
  case when p.cerrada_en is null then o.ultimo_contacto_efectivo_en else (p.gestion->>'ultimo_contacto_efectivo_en')::timestamptz end as ultimo_contacto_efectivo_en,
  p.primer_contacto_en,
  case when p.cerrada_en is null then eo.nombre else ep.nombre end as estado_lead,
  (select count(*)::integer from public.crm_actividades a where a.campana_id = p.id and a.tipo = 'llamada') as intentos_llamada,
  (select count(*)::integer from public.crm_actividades a where a.campana_id = p.id and a.tipo = 'whatsapp') as intentos_whatsapp,
  (select count(*)::integer from public.crm_envios x where x.campana_id = p.id
     and x.estado in ('simulado', 'enviado', 'entregado', 'leido')) as mensajes_masivos
from public.crm_oportunidad_campanas p
join public.crm_oportunidades o on o.id = p.oportunidad_id
join public.crm_contactos c on c.id = o.contacto_id
join public.crm_vehiculos v on v.id = o.vehiculo_id
left join public.crm_etapas eo on eo.id = o.etapa_id
left join public.crm_etapas ep on ep.id = p.etapa_id;
