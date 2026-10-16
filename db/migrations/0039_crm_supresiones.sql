/*
  Supresiones y freno de envíos (Etapa 0 de la auditoría externa, v3 con las correcciones del 15-oct).

  Problema: las marcas de «a este no se le escribe» vivían en campos del lead que el reinicio de campaña borra (H1), la baja
  dependía de que existiera el contacto (H2), el número equivocado se perdía (H16) y el despacho no revalidaba nada (H13).

  Qué agrega:
  - crm_supresiones: supresiones por teléfono (baja, número equivocado) o por VIN (descartes del vehículo). El reinicio
    no las toca. Vigencia opcional; se revocan con motivo, nunca se borran.
  - Funciones que usa el código:
      crm_tel10(texto)                       teléfono a 10 dígitos (igual que telefono10() del código).
      crm_registrar_supresion(...)           upsert; renueva una vencida; WhatsApp gana como canal.
      crm_revocar_supresion(id, usuario, motivo)
      crm_bloqueo_telefono(sucursal, tel10)  cumplimiento por teléfono (chat y CloudTalk).
      crm_supresion_de_lead(oportunidad)     supresión vigente del lead, por VIN o por teléfono (sync).
      crm_motivo_no_enviar(oportunidad, plantilla, origen)  freno de dos capas; null = se puede enviar.
      crm_reconciliar_bajas(desde)           bajas escritas por WhatsApp que no se procesaron.
  - Triggers: caché de la baja en contactos y leads; transición desde whatsapp_baja (código viejo); herencia de la baja al
    crear o cambiar el teléfono de un contacto; protección de la baja del lead; descarte del vehículo y número equivocado a
    supresión al capturarlos.
  - crm_plantilla_reglas.uso ('campana' | 'servicio') y crm_envios.cubierto_por_envio_id.

  Decisiones aplicadas (15-oct-2026, Miguel Borbón): D1 descartes del vehículo permanentes por VIN; D10 un primer mensaje
  por teléfono y campaña; D12 número equivocado bloquea el teléfono en todos sus VIN; plantillas de servicio con lo que ya
  captura el BDC (Vendido o fecha de compra; Cotizado), el contrato solo bloquea si está cancelado; masivos manuales de
  campaña permitidos a leads abiertos aunque estén fuera de ventana (el primer mensaje automático sigue exigiendo campaña
  vigente).
*/
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------- Utilidades ----------

-- Últimos 10 dígitos, o null con menos de 10 (misma regla que telefono10() en campanasLogica.ts).
create or replace function public.crm_tel10(t text) returns text
language sql immutable parallel safe as $$
  select case when length(d) >= 10 then right(d, 10) end
    from (select regexp_replace(coalesce(t, ''), '\D', '', 'g') as d) x
$$;

-- Igual que normalizarTexto() (campanasLogica.ts): NFD, sin diacríticos, minúsculas, solo [a-z0-9 ], espacios simples.
create or replace function public.crm_normalizar_texto(t text) returns text
language sql immutable parallel safe as $$
  select btrim(regexp_replace(regexp_replace(
           lower(regexp_replace(normalize(coalesce(t, ''), NFD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g')),
           '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- ---------- Tabla ----------

create table public.crm_supresiones (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  alcance text not null check (alcance in ('telefono', 'vin')),
  valor text not null,
  motivo text not null check (motivo in ('baja', 'numero_equivocado',
                                         'ya_no_tiene_auto', 'flotilla', 'uso_no_elegible', 'fuera_km_tiempo')),
  canal text not null default 'sistema' check (canal in ('whatsapp', 'llamada', 'correo', 'presencial', 'sms', 'sistema')),
  vigente_hasta timestamptz,                                   -- null = sin vencimiento
  evidencia jsonb not null default '{}'::jsonb,
  origen_oportunidad_id uuid references public.crm_oportunidades(id) on delete set null,
  creado_por uuid references public.usuarios(id) on delete set null,
  creado_en timestamptz not null default now(),
  revocada_en timestamptz,
  revocada_por uuid references public.usuarios(id) on delete set null,
  motivo_revocacion text,
  actualizado_en timestamptz not null default now(),
  constraint crm_supresiones_valor_chk check (
       (alcance = 'telefono' and valor ~ '^\d{10}$')
    or (alcance = 'vin' and length(btrim(valor)) >= 11)),
  constraint crm_supresiones_motivo_alcance_chk check (
       (motivo in ('baja', 'numero_equivocado') and alcance = 'telefono')
    or (motivo in ('ya_no_tiene_auto', 'flotilla', 'uso_no_elegible', 'fuera_km_tiempo') and alcance = 'vin')),
  constraint crm_supresiones_revocacion_chk check (
       revocada_en is null or length(btrim(coalesce(motivo_revocacion, ''))) >= 10)
);

comment on table public.crm_supresiones is
  'A quién no se le escribe, por teléfono o VIN. El reinicio de campaña no la toca. Se revoca con motivo; nunca se borra.';

create unique index crm_supresiones_vigente_uq on public.crm_supresiones (sucursal_id, alcance, valor, motivo)
  where revocada_en is null;
create index crm_supresiones_act_idx on public.crm_supresiones (actualizado_en);
create index crm_contactos_tel10_idx on public.crm_contactos (sucursal_id, public.crm_tel10(telefono));

create trigger crm_supresiones_tocar before update on public.crm_supresiones
  for each row execute function public.crm_tocar();

alter table public.crm_supresiones enable row level security;
revoke all on public.crm_supresiones from public, anon, authenticated;

-- ---------- Registrar y revocar ----------

create or replace function public.crm_registrar_supresion(
  p_sucursal uuid, p_alcance text, p_valor text, p_motivo text, p_canal text default 'sistema',
  p_evidencia jsonb default '{}'::jsonb, p_oportunidad uuid default null, p_usuario uuid default null,
  p_vigente_hasta timestamptz default null)
returns uuid language plpgsql set search_path = public as $$
declare
  v_id uuid;
begin
  if p_valor is null or btrim(p_valor) = '' then
    return null;
  end if;
  insert into crm_supresiones as s
         (sucursal_id, alcance, valor, motivo, canal, evidencia, origen_oportunidad_id, creado_por, vigente_hasta)
  values (p_sucursal, p_alcance, btrim(p_valor), p_motivo, coalesce(p_canal, 'sistema'),
          coalesce(p_evidencia, '{}'::jsonb), p_oportunidad, p_usuario, p_vigente_hasta)
  on conflict (sucursal_id, alcance, valor, motivo) where revocada_en is null do update
     set vigente_hasta = case when s.vigente_hasta is null or excluded.vigente_hasta is null then null
                              else greatest(s.vigente_hasta, excluded.vigente_hasta) end,
         canal = case when excluded.canal = 'whatsapp' then 'whatsapp' else s.canal end,
         evidencia = s.evidencia || jsonb_build_object('ultima', excluded.evidencia)
  returning s.id into v_id;
  return v_id;
end $$;

create or replace function public.crm_revocar_supresion(p_id uuid, p_usuario uuid, p_motivo text)
returns void language plpgsql set search_path = public as $$
begin
  update crm_supresiones
     set revocada_en = now(), revocada_por = p_usuario, motivo_revocacion = p_motivo
   where id = p_id and revocada_en is null;
  if not found then
    raise exception 'La supresión % no existe o ya está revocada', p_id;
  end if;
end $$;

-- ---------- Caché en contactos y leads ----------

-- Una baja vigente marca los contactos del número y sus leads (salvo ventas, como hoy). Al revocarse, el contacto sale de
-- baja solo si no queda otra; regresar el estado de los leads lo hace el código (quitarNoContactar).
create or replace function public.crm_supresiones_a_contactos() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.alcance <> 'telefono' or new.motivo <> 'baja' then
    return null;
  end if;
  if new.revocada_en is null and (new.vigente_hasta is null or new.vigente_hasta > now()) then
    update crm_contactos k
       set whatsapp_baja = true,
           -- Una baja nueva lleva su fecha; whatsapp_baja_en de una baja anterior ya revocada es solo historia.
           whatsapp_baja_en = case when k.whatsapp_baja then coalesce(k.whatsapp_baja_en, new.creado_en) else new.creado_en end,
           baja_canal = case when new.canal = 'whatsapp' then 'whatsapp'
                             else coalesce(k.baja_canal, nullif(new.canal, 'sistema')) end
     where k.sucursal_id = new.sucursal_id and crm_tel10(k.telefono) = new.valor
       and (not k.whatsapp_baja or (new.canal = 'whatsapp' and k.baja_canal is distinct from 'whatsapp'));
    update crm_oportunidades o
       set estado_contacto = 'baja', respuesta_por_clasificar = false
      from crm_contactos k
     where k.id = o.contacto_id and k.sucursal_id = new.sucursal_id and crm_tel10(k.telefono) = new.valor
       and o.estado <> 'ganada' and o.estado_contacto <> 'baja';
  elsif tg_op = 'UPDATE' and new.revocada_en is not null and old.revocada_en is null then
    update crm_contactos k
       set whatsapp_baja = false, baja_canal = null     -- whatsapp_baja_en se conserva como historia
     where k.sucursal_id = new.sucursal_id and crm_tel10(k.telefono) = new.valor and k.whatsapp_baja
       and not exists (select 1 from crm_supresiones s
                        where s.sucursal_id = new.sucursal_id and s.alcance = 'telefono'
                          and s.valor = new.valor and s.motivo = 'baja' and s.revocada_en is null);
  end if;
  return null;
end $$;

create trigger crm_supresiones_a_contactos after insert or update of revocada_en, vigente_hasta on public.crm_supresiones
  for each row execute function public.crm_supresiones_a_contactos();

-- Transición: si algún camino (código viejo o futuro) solo marca whatsapp_baja, la baja también queda como supresión.
create or replace function public.crm_contactos_baja_a_supresion() returns trigger
language plpgsql set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then
    return null;                                    -- viene de la caché de una supresión
  end if;
  if new.whatsapp_baja and crm_tel10(new.telefono) is not null
     and not exists (select 1 from crm_supresiones s
                      where s.sucursal_id = new.sucursal_id and s.alcance = 'telefono'
                        and s.valor = crm_tel10(new.telefono) and s.motivo = 'baja' and s.revocada_en is null
                        and (new.baja_canal is distinct from 'whatsapp' or s.canal = 'whatsapp')) then
    perform crm_registrar_supresion(new.sucursal_id, 'telefono', crm_tel10(new.telefono), 'baja',
                                    coalesce(new.baja_canal, 'sistema'),
                                    jsonb_build_object('origen', 'crm_contactos', 'contacto_id', new.id));
  end if;
  return null;
end $$;

create trigger crm_contactos_baja_a_supresion after insert or update of whatsapp_baja, baja_canal on public.crm_contactos
  for each row execute function public.crm_contactos_baja_a_supresion();

-- Un contacto nuevo, o con teléfono cambiado por la sync, hereda la baja de su número.
create or replace function public.crm_contactos_heredar_baja() returns trigger
language plpgsql set search_path = public as $$
declare
  v_canal text;
begin
  select s.canal into v_canal
    from crm_supresiones s
   where s.sucursal_id = new.sucursal_id and s.alcance = 'telefono' and s.valor = crm_tel10(new.telefono)
     and s.motivo = 'baja' and s.revocada_en is null and (s.vigente_hasta is null or s.vigente_hasta > now())
   order by (s.canal = 'whatsapp') desc
   limit 1;
  if found then
    new.whatsapp_baja_en := case when tg_op = 'UPDATE' and old.whatsapp_baja then coalesce(new.whatsapp_baja_en, now())
                                 else now() end;
    new.whatsapp_baja := true;
    new.baja_canal := coalesce(new.baja_canal, nullif(v_canal, 'sistema'));
  end if;
  return new;
end $$;

create trigger crm_contactos_heredar_baja before insert or update of telefono on public.crm_contactos
  for each row execute function public.crm_contactos_heredar_baja();

-- Un lead en baja solo sale de baja con «Quitar no contactar», que declara set_config('crm.quitar_baja', 'on', true).
-- Cualquier otro UPDATE conserva la baja en silencio (no lanza error, para no tumbar ediciones en lote ni la sync).
create or replace function public.crm_oportunidades_proteger_baja() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.estado_contacto = 'baja' and new.estado_contacto is distinct from 'baja'
     and coalesce(current_setting('crm.quitar_baja', true), '') <> 'on' then
    new.estado_contacto := 'baja';
  end if;
  return new;
end $$;

create trigger crm_oportunidades_proteger_baja before update of estado_contacto on public.crm_oportunidades
  for each row execute function public.crm_oportunidades_proteger_baja();

-- Los triggers de captura actúan solo en TRANSICIONES (el valor cambió), no cada vez que un UPDATE nombra la columna:
-- reacomodar una tarjeta o repetir el mismo motivo no debe volver a bloquear un lead que ya se corrigió.

-- D1: al capturar un descarte del vehículo, queda como supresión del VIN (el reinicio ya no la puede borrar).
create or replace function public.crm_oportunidades_descarte_a_supresion() returns trigger
language plpgsql set search_path = public as $$
declare
  v_clave text;
  v_vin text;
begin
  select m.clave into v_clave from crm_motivos_perdida m where m.id = new.motivo_perdida_id;
  if v_clave in ('ya_no_tiene_auto', 'flotilla', 'uso_no_elegible', 'fuera_km_tiempo') then
    select v.vin into v_vin from crm_vehiculos v where v.id = new.vehiculo_id;
    if length(btrim(coalesce(v_vin, ''))) >= 11 then
      perform crm_registrar_supresion(new.sucursal_id, 'vin', v_vin, v_clave, 'sistema',
                                      jsonb_build_object('origen', 'motivo_perdida'), new.id);
    end if;
  end if;
  return null;
end $$;

create trigger crm_oportunidades_descarte_a_supresion_ins after insert on public.crm_oportunidades
  for each row when (new.motivo_perdida_id is not null)
  execute function public.crm_oportunidades_descarte_a_supresion();
create trigger crm_oportunidades_descarte_a_supresion_upd after update of motivo_perdida_id on public.crm_oportunidades
  for each row when (new.motivo_perdida_id is not null and new.motivo_perdida_id is distinct from old.motivo_perdida_id)
  execute function public.crm_oportunidades_descarte_a_supresion();

-- Cerrar como Perdido con el motivo «No contactable» (tablero, estado del lead o lote) deja el contacto «No contactable»,
-- igual que el Resultado BDC NO CONTACTABLE. Así D12 no depende de por dónde se capturó. Solo al cambiar el motivo.
create or replace function public.crm_oportunidades_motivo_no_contactable() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.motivo_perdida_id is not null and new.estado_contacto is distinct from 'baja'
     and exists (select 1 from crm_motivos_perdida m where m.id = new.motivo_perdida_id and m.clave = 'no_contactable') then
    new.estado_contacto := 'no_contactable';
  end if;
  return new;
end $$;

create trigger crm_oportunidades_motivo_no_contactable_ins before insert on public.crm_oportunidades
  for each row when (new.motivo_perdida_id is not null)
  execute function public.crm_oportunidades_motivo_no_contactable();
create trigger crm_oportunidades_motivo_no_contactable_upd before update of motivo_perdida_id on public.crm_oportunidades
  for each row when (new.motivo_perdida_id is not null and new.motivo_perdida_id is distinct from old.motivo_perdida_id)
  execute function public.crm_oportunidades_motivo_no_contactable();

-- D12: el número equivocado (contacto «No contactable» por llamada, por clasificación, por resultado, por motivo o a mano)
-- bloquea el teléfono en todos sus VIN y descarta las tareas pendientes de los leads de ese número.
create or replace function public.crm_oportunidades_no_contactable_a_supresion() returns trigger
language plpgsql set search_path = public as $$
declare
  v_tel text;
begin
  select crm_tel10(k.telefono) into v_tel from crm_contactos k where k.id = new.contacto_id;
  if v_tel is not null then
    perform crm_registrar_supresion(new.sucursal_id, 'telefono', v_tel, 'numero_equivocado', 'llamada',
                                    jsonb_build_object('origen', 'estado_contacto'), new.id);
    update crm_tareas t
       set estado = 'cancelada', completada_en = now(), cierre_automatico = 'numero_equivocado'
      from crm_oportunidades o
      join crm_contactos k on k.id = o.contacto_id
     where t.oportunidad_id = o.id and t.estado = 'pendiente'
       and o.sucursal_id = new.sucursal_id and crm_tel10(k.telefono) = v_tel;
  end if;
  return null;
end $$;

create trigger crm_oportunidades_no_contactable_a_supresion_ins after insert on public.crm_oportunidades
  for each row when (new.estado_contacto = 'no_contactable')
  execute function public.crm_oportunidades_no_contactable_a_supresion();
create trigger crm_oportunidades_no_contactable_a_supresion_upd
  after update of estado_contacto, motivo_perdida_id on public.crm_oportunidades
  for each row when (new.estado_contacto = 'no_contactable' and old.estado_contacto is distinct from 'no_contactable')
  execute function public.crm_oportunidades_no_contactable_a_supresion();

alter table public.crm_tareas drop constraint crm_tareas_cierre_automatico_check;
alter table public.crm_tareas add constraint crm_tareas_cierre_automatico_check
  check (cierre_automatico in ('contacto', 'lead_cerrado', 'baja', 'numero_equivocado'));

/*
  Corregir un lead deshace el bloqueo que se capturó por error, pero SOLO cuando una persona lo corrige explícitamente:
  el código declara set_config('crm.corregir_supresion', 'on', true) en la transacción de esa edición (cambio a mano del
  contacto o del estado/motivo de un lead, o una llamada en la que contestó el titular). Una llamada sin el titular, una
  edición en lote o la sync no declaran nada, así que nunca liberan un número equivocado ni un descarte.
  - Sacarlo de «No contactable» revoca el número equivocado de su teléfono, si ningún otro lead de ese número sigue
    no contactable.
  - Cambiarle un motivo de descarte del vehículo revoca la supresión de su VIN.
*/
create or replace function public.crm_oportunidades_corregir_supresion() returns trigger
language plpgsql set search_path = public as $$
declare
  v_tel text;
  v_vin text;
  v_clave_vieja text;
  v_clave_nueva text;
begin
  if coalesce(current_setting('crm.corregir_supresion', true), '') <> 'on' then
    return null;
  end if;
  if old.estado_contacto = 'no_contactable' and new.estado_contacto not in ('no_contactable', 'baja') then
    select crm_tel10(k.telefono) into v_tel from crm_contactos k where k.id = new.contacto_id;
    if v_tel is not null and not exists (
         select 1 from crm_oportunidades o2 join crm_contactos k2 on k2.id = o2.contacto_id
          where o2.sucursal_id = new.sucursal_id and o2.id <> new.id and o2.estado_contacto = 'no_contactable'
            and crm_tel10(k2.telefono) = v_tel) then
      update crm_supresiones
         set revocada_en = now(), motivo_revocacion = 'Corrección del lead en la web: dejó de ser no contactable'
       where sucursal_id = new.sucursal_id and alcance = 'telefono' and valor = v_tel
         and motivo = 'numero_equivocado' and revocada_en is null;
    end if;
  end if;
  if old.motivo_perdida_id is distinct from new.motivo_perdida_id and old.motivo_perdida_id is not null then
    select m.clave into v_clave_vieja from crm_motivos_perdida m where m.id = old.motivo_perdida_id;
    select m.clave into v_clave_nueva from crm_motivos_perdida m where m.id = new.motivo_perdida_id;
    if v_clave_vieja in ('ya_no_tiene_auto', 'flotilla', 'uso_no_elegible', 'fuera_km_tiempo')
       and v_clave_nueva is distinct from v_clave_vieja then
      select v.vin into v_vin from crm_vehiculos v where v.id = new.vehiculo_id;
      update crm_supresiones
         set revocada_en = now(), motivo_revocacion = 'Corrección del lead en la web: cambió el motivo de pérdida'
       where sucursal_id = new.sucursal_id and alcance = 'vin' and valor = v_vin
         and motivo = v_clave_vieja and revocada_en is null;
    end if;
  end if;
  return null;
end $$;

create trigger crm_oportunidades_corregir_supresion
  after update of estado_contacto, motivo_perdida_id on public.crm_oportunidades
  for each row when (old.estado_contacto is distinct from new.estado_contacto
                     or old.motivo_perdida_id is distinct from new.motivo_perdida_id)
  execute function public.crm_oportunidades_corregir_supresion();

-- ---------- Uso por plantilla y cobertura del primer mensaje ----------

alter table public.crm_plantilla_reglas
  add column uso text not null default 'campana' check (uso in ('campana', 'servicio'));
comment on column public.crm_plantilla_reglas.uso is
  'campana: elegibilidad comercial (lead abierto, sin GE, sin pago, sin «Ahora no»). servicio: plantillas de póliza y cobro.';
update public.crm_plantilla_reglas r
   set uso = 'servicio'
  from public.whatsapp_plantillas p
 where p.id = r.plantilla_id and p.categoria = 'utility';
-- «GE Liga vencida» (categoría marketing, regla Cotizado) queda en 'campana' hasta decidir D18.

alter table public.crm_envios
  add column cubierto_por_envio_id uuid references public.crm_envios(id) on delete set null;
comment on column public.crm_envios.cubierto_por_envio_id is
  'D10: primer mensaje omitido porque ya se le escribió a ese teléfono en la misma campaña con este envío.';

-- ---------- Consultas del freno ----------

-- Cumplimiento por teléfono (chat y CloudTalk). null = no hay bloqueo.
create or replace function public.crm_bloqueo_telefono(p_sucursal uuid, p_tel10 text)
returns text language sql stable set search_path = public as $$
  select coalesce(
    (select 'supresion_' || s.motivo
       from crm_supresiones s
      where s.sucursal_id = p_sucursal and s.alcance = 'telefono' and s.valor = p_tel10
        and s.revocada_en is null and (s.vigente_hasta is null or s.vigente_hasta > now())
      order by (s.motivo = 'baja') desc, s.creado_en
      limit 1),
    (select 'baja' from crm_contactos k
      where k.sucursal_id = p_sucursal and k.whatsapp_baja and crm_tel10(k.telefono) = p_tel10
      limit 1))
$$;

-- Supresión vigente que alcanza a un lead (por su VIN o por el teléfono de su contacto). La usa la sync.
create or replace function public.crm_supresion_de_lead(p_oportunidad uuid)
returns text language sql stable set search_path = public as $$
  select s.motivo
    from crm_oportunidades o
    left join crm_vehiculos v on v.id = o.vehiculo_id
    left join crm_contactos k on k.id = o.contacto_id
    join crm_supresiones s on s.sucursal_id = o.sucursal_id and s.revocada_en is null
                          and (s.vigente_hasta is null or s.vigente_hasta > now())
                          and ((s.alcance = 'vin' and s.valor = v.vin)
                            or (s.alcance = 'telefono' and s.valor = crm_tel10(k.telefono)))
   where o.id = p_oportunidad
   order by (s.motivo = 'baja') desc, s.creado_en
   limit 1
$$;

/*
  Supresión que vuelve TERMINAL a un lead en la sync (no se reinicia al cambiar de campaña): la de su VIN, la baja de su
  teléfono, o el número equivocado de su teléfono solo si el propio lead está «No contactable» (es donde se capturó y donde
  se corrige). Los demás VIN de un número equivocado sí se reinician: el freno los sigue deteniendo por la supresión del
  teléfono y, si el número se corrige, no pierden su campaña.
*/
create or replace function public.crm_supresion_terminal(p_oportunidad uuid)
returns text language sql stable set search_path = public as $$
  select s.motivo
    from crm_oportunidades o
    left join crm_vehiculos v on v.id = o.vehiculo_id
    left join crm_contactos k on k.id = o.contacto_id
    join crm_supresiones s on s.sucursal_id = o.sucursal_id and s.revocada_en is null
                          and (s.vigente_hasta is null or s.vigente_hasta > now())
                          and ((s.alcance = 'vin' and s.valor = v.vin)
                            or (s.alcance = 'telefono' and s.valor = crm_tel10(k.telefono)
                                and (s.motivo = 'baja' or o.estado_contacto = 'no_contactable')))
   where o.id = p_oportunidad
   order by (s.motivo = 'baja') desc, s.creado_en
   limit 1
$$;

/*
  Freno de dos capas para el despacho y el armado de masivos. Devuelve el motivo de omisión, o null si se puede enviar.
  p_origen: 'primer_mensaje' (automático) o 'masivo' (manual).
  Capa 1 · cumplimiento, para toda plantilla: baja, supresiones (teléfono o VIN), no contactable, sin teléfono.
  Capa 2 · servicio (uso 'servicio'): contrato cancelado; el lead debe cumplir la regla de estados de la plantilla, o tener
           evidencia de venta (regla Vendido) o contrato en cobro (regla Cotizado).
  Capa 2 · campaña (uso 'campana'): lead abierto, sin GE, sin pago, sin «Ahora no» en su paso abierto. El primer mensaje
           automático además exige paso abierto y cartera ACTIVA; el masivo manual no (D20: fuera de ventana se permite).
*/
create or replace function public.crm_motivo_no_enviar(p_oportunidad uuid, p_plantilla uuid, p_origen text default 'masivo')
returns text language sql stable set search_path = public as $$
  with l as (
    select o.id, o.sucursal_id, o.estado, o.etapa_id, o.estado_contacto, o.estado_cartera,
           (o.fecha_pago is not null or o.fecha_compra is not null) as venta_capturada,
           coalesce(k.whatsapp_baja, false) as whatsapp_baja, crm_tel10(k.telefono) as tel10, v.vin,
           coalesce(v.tiene_ge, false) as tiene_ge, p.id as paso_id
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
    when l.tiene_ge then 'ya_tiene_ge'
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

-- Bajas escritas por WhatsApp que no se procesaron (H19). Solo cuenta como atendido un BAJA si ya hay una baja con canal
-- WhatsApp (vigente, o revocada después del mensaje por re-consentimiento). Una baja manual vigente no lo tapa: la
-- reconciliación la sube a canal WhatsApp, y así ya no se puede quitar como «error de captura».
create or replace function public.crm_reconciliar_bajas(p_desde timestamptz default now() - interval '7 days')
returns integer language plpgsql set search_path = public as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select distinct on (m.sucursal_id, crm_tel10(c.wa_id))
           m.sucursal_id, crm_tel10(c.wa_id) as tel10, m.wa_message_id, m.creado_en
      from whatsapp_mensajes m
      join whatsapp_conversaciones c on c.id = m.conversacion_id
     where m.direccion = 'entrante' and m.tipo = 'texto' and m.creado_en >= p_desde
       and crm_tel10(c.wa_id) is not null
       -- Misma lista que PALABRAS_BAJA en campanasLogica.ts.
       and crm_normalizar_texto(m.texto) in ('baja', 'stop', 'alto', 'cancelar', 'no mas', 'ya no',
            'no quiero mas mensajes', 'no me escriban', 'dejen de escribirme')
       and not exists (select 1 from crm_supresiones s
                        where s.sucursal_id = m.sucursal_id and s.alcance = 'telefono' and s.valor = crm_tel10(c.wa_id)
                          and s.motivo = 'baja' and s.canal = 'whatsapp'
                          and (s.revocada_en is null or s.revocada_en >= m.creado_en))
     order by m.sucursal_id, crm_tel10(c.wa_id), m.creado_en
  loop
    perform crm_registrar_supresion(r.sucursal_id, 'telefono', r.tel10, 'baja', 'whatsapp',
                                    jsonb_build_object('origen', 'reconciliacion', 'wa_message_id', r.wa_message_id));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- Permisos de los objetos nuevos ----------

revoke execute on function
  public.crm_tel10(text), public.crm_normalizar_texto(text),
  public.crm_registrar_supresion(uuid, text, text, text, text, jsonb, uuid, uuid, timestamptz),
  public.crm_revocar_supresion(uuid, uuid, text), public.crm_bloqueo_telefono(uuid, text),
  public.crm_supresion_de_lead(uuid), public.crm_supresion_terminal(uuid), public.crm_motivo_no_enviar(uuid, uuid, text),
  public.crm_reconciliar_bajas(timestamptz),
  public.crm_supresiones_a_contactos(), public.crm_contactos_baja_a_supresion(),
  public.crm_contactos_heredar_baja(), public.crm_oportunidades_proteger_baja(),
  public.crm_oportunidades_descarte_a_supresion(), public.crm_oportunidades_no_contactable_a_supresion(),
  public.crm_oportunidades_motivo_no_contactable(), public.crm_oportunidades_corregir_supresion()
  from public, anon, authenticated;
grant execute on function
  public.crm_tel10(text), public.crm_normalizar_texto(text),
  public.crm_registrar_supresion(uuid, text, text, text, text, jsonb, uuid, uuid, timestamptz),
  public.crm_revocar_supresion(uuid, uuid, text), public.crm_bloqueo_telefono(uuid, text),
  public.crm_supresion_de_lead(uuid), public.crm_supresion_terminal(uuid), public.crm_motivo_no_enviar(uuid, uuid, text),
  public.crm_reconciliar_bajas(timestamptz)
  to service_role;

-- ---------- Datos existentes ----------

-- (1) Bajas que ya están en contactos (hoy 0).
select public.crm_registrar_supresion(k.sucursal_id, 'telefono', public.crm_tel10(k.telefono), 'baja',
         coalesce(k.baja_canal, 'sistema'), jsonb_build_object('backfill', '0039', 'contacto_id', k.id))
  from public.crm_contactos k
 where k.whatsapp_baja and public.crm_tel10(k.telefono) is not null;

-- (2) Bajas escritas por WhatsApp y nunca procesadas.
select public.crm_reconciliar_bajas('-infinity');

-- (3) Descartes del vehículo en el lead actual y en las fotos de pasos cerrados (hoy 0).
select public.crm_registrar_supresion(o.sucursal_id, 'vin', v.vin, m.clave, 'sistema',
         jsonb_build_object('backfill', '0039', 'fuente', x.fuente), o.id)
  from (select o2.id as oportunidad_id, o2.motivo_perdida_id as motivo_id, 'lead' as fuente
          from public.crm_oportunidades o2
        union all
        select p.oportunidad_id, nullif(p.gestion->>'motivo_perdida_id', '')::uuid, 'foto_paso'
          from public.crm_oportunidad_campanas p
         where p.gestion ? 'motivo_perdida_id') x
  join public.crm_oportunidades o on o.id = x.oportunidad_id
  join public.crm_vehiculos v on v.id = o.vehiculo_id
  join public.crm_motivos_perdida m on m.id = x.motivo_id
 where m.clave in ('ya_no_tiene_auto', 'flotilla', 'uso_no_elegible', 'fuera_km_tiempo')
   and length(btrim(coalesce(v.vin, ''))) >= 11;

-- (4) D12: número equivocado por teléfono, de los leads «No contactable» por contacto, por motivo o por resultado (hoy 10).
select public.crm_registrar_supresion(o.sucursal_id, 'telefono', public.crm_tel10(k.telefono), 'numero_equivocado',
         'llamada', jsonb_build_object('backfill', '0039'), o.id)
  from public.crm_oportunidades o
  join public.crm_contactos k on k.id = o.contacto_id
  left join public.crm_motivos_perdida m on m.id = o.motivo_perdida_id
 where public.crm_tel10(k.telefono) is not null and o.estado_contacto <> 'baja'
   and coalesce(m.clave, '') <> 'pidio_baja'
   and (o.estado_contacto = 'no_contactable' or m.clave = 'no_contactable' or o.resultado_bdc = 'NO CONTACTABLE');

commit;

/*
  Reversa. La tabla no se borra: se renombra para conservar la evidencia de bajas.
  begin;
  drop trigger if exists crm_oportunidades_corregir_supresion on public.crm_oportunidades;
  drop trigger if exists crm_oportunidades_motivo_no_contactable_ins on public.crm_oportunidades;
  drop trigger if exists crm_oportunidades_motivo_no_contactable_upd on public.crm_oportunidades;
  drop function if exists public.crm_oportunidades_corregir_supresion(), public.crm_oportunidades_motivo_no_contactable();
  drop trigger if exists crm_oportunidades_no_contactable_a_supresion_ins on public.crm_oportunidades;
  drop trigger if exists crm_oportunidades_no_contactable_a_supresion_upd on public.crm_oportunidades;
  drop trigger if exists crm_oportunidades_descarte_a_supresion_ins on public.crm_oportunidades;
  drop trigger if exists crm_oportunidades_descarte_a_supresion_upd on public.crm_oportunidades;
  alter table public.crm_tareas drop constraint crm_tareas_cierre_automatico_check;
  alter table public.crm_tareas add constraint crm_tareas_cierre_automatico_check
    check (cierre_automatico in ('contacto', 'lead_cerrado', 'baja'));   -- falla si ya hay tareas cerradas por número equivocado
  drop trigger if exists crm_oportunidades_proteger_baja on public.crm_oportunidades;
  drop trigger if exists crm_contactos_heredar_baja on public.crm_contactos;
  drop trigger if exists crm_contactos_baja_a_supresion on public.crm_contactos;
  drop trigger if exists crm_supresiones_a_contactos on public.crm_supresiones;
  drop function if exists public.crm_oportunidades_no_contactable_a_supresion(), public.crm_oportunidades_descarte_a_supresion(),
    public.crm_oportunidades_proteger_baja(), public.crm_contactos_heredar_baja(), public.crm_contactos_baja_a_supresion(),
    public.crm_supresiones_a_contactos(), public.crm_reconciliar_bajas(timestamptz), public.crm_motivo_no_enviar(uuid, uuid, text),
    public.crm_supresion_de_lead(uuid), public.crm_supresion_terminal(uuid), public.crm_bloqueo_telefono(uuid, text), public.crm_revocar_supresion(uuid, uuid, text),
    public.crm_registrar_supresion(uuid, text, text, text, text, jsonb, uuid, uuid, timestamptz);
  drop index if exists public.crm_contactos_tel10_idx;
  alter table public.crm_envios drop column if exists cubierto_por_envio_id;
  alter table public.crm_plantilla_reglas drop column if exists uso;
  alter table public.crm_supresiones rename to crm_supresiones_respaldo_0039;
  commit;
  -- crm_tel10 y crm_normalizar_texto pueden quedarse. Las marcas whatsapp_baja que puso la caché se quedan (falla segura).
*/
