/*
  Liberar un bloqueo queda registrado (decisión del 15-oct-2026, Miguel Borbón; hallazgo R4 de la auditoría).

  Cualquier usuario (asesor o admin) que corrige un lead puede liberar el número equivocado de su teléfono o el descarte de
  su VIN, pero ahora queda quién lo hizo: el código declara set_config('crm.usuario_correccion', <usuario>, true) junto con
  crm.corregir_supresion, la supresión revocada guarda revocada_por, y el lead recibe una actividad que dice qué se liberó.
*/
begin;
set local lock_timeout = '5s';

create or replace function public.crm_oportunidades_corregir_supresion() returns trigger
language plpgsql set search_path = public as $$
declare
  v_tel text;
  v_vin text;
  v_clave_vieja text;
  v_clave_nueva text;
  v_usuario uuid := nullif(current_setting('crm.usuario_correccion', true), '')::uuid;
  v_n integer;
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
         set revocada_en = now(), revocada_por = v_usuario,
             motivo_revocacion = 'Corrección del lead en la web: dejó de ser no contactable'
       where sucursal_id = new.sucursal_id and alcance = 'telefono' and valor = v_tel
         and motivo = 'numero_equivocado' and revocada_en is null;
      get diagnostics v_n = row_count;
      if v_n > 0 then
        insert into crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id)
        values (new.sucursal_id, new.id, 'edicion', 'Se liberó el número equivocado de su teléfono',
                jsonb_build_object('campo', 'supresion', 'motivo', 'numero_equivocado', 'liberada', true), v_usuario);
      end if;
    end if;
  end if;
  if old.motivo_perdida_id is distinct from new.motivo_perdida_id and old.motivo_perdida_id is not null then
    select m.clave into v_clave_vieja from crm_motivos_perdida m where m.id = old.motivo_perdida_id;
    select m.clave into v_clave_nueva from crm_motivos_perdida m where m.id = new.motivo_perdida_id;
    if v_clave_vieja in ('ya_no_tiene_auto', 'flotilla', 'uso_no_elegible', 'fuera_km_tiempo')
       and v_clave_nueva is distinct from v_clave_vieja then
      select v.vin into v_vin from crm_vehiculos v where v.id = new.vehiculo_id;
      update crm_supresiones
         set revocada_en = now(), revocada_por = v_usuario,
             motivo_revocacion = 'Corrección del lead en la web: cambió el motivo de pérdida'
       where sucursal_id = new.sucursal_id and alcance = 'vin' and valor = v_vin
         and motivo = v_clave_vieja and revocada_en is null;
      get diagnostics v_n = row_count;
      if v_n > 0 then
        insert into crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id)
        values (new.sucursal_id, new.id, 'edicion', 'Se liberó el descarte del vehículo',
                jsonb_build_object('campo', 'supresion', 'motivo', v_clave_vieja, 'liberada', true), v_usuario);
      end if;
    end if;
  end if;
  return null;
end $$;

revoke execute on function public.crm_oportunidades_corregir_supresion() from public, anon, authenticated;

commit;

-- Reversa: volver a la definición de 0039 (sin revocada_por ni actividad).
