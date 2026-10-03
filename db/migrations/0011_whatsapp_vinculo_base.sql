/* 0011: cada conversación de WhatsApp se vincula sola con el contacto de la base cargada en la web
   (por los últimos 10 dígitos del teléfono), sin depender de una columna configurada a mano.

   crm_vincular_conversaciones(p_sucursal): liga las conversaciones sin contacto que ya coinciden con la
   base y, si la conversación no tiene dueño, la asigna al ejecutivo de la oportunidad activa más reciente.
   Con null revisa todas las sucursales. Es idempotente: se puede correr tantas veces como se quiera
   (por ejemplo cada vez que la sincronización trae contactos nuevos). */

alter table public.whatsapp_conversaciones
  add column if not exists contacto_id uuid references public.crm_contactos(id) on delete set null;
create index if not exists whatsapp_conversaciones_contacto_idx on public.whatsapp_conversaciones (contacto_id) where contacto_id is not null;

create or replace function public.crm_vincular_conversaciones(p_sucursal uuid default null) returns integer
language plpgsql as $$
declare
  v_ligadas integer;
begin
  with candidatos as (
    select distinct on (cv.id) cv.id as conversacion_id, c.id as contacto_id
      from public.whatsapp_conversaciones cv
      join public.crm_contactos c
        on c.sucursal_id = cv.sucursal_id
       and length(regexp_replace(coalesce(c.telefono, ''), '\D', '', 'g')) >= 10
       and right(regexp_replace(c.telefono, '\D', '', 'g'), 10) = right(regexp_replace(cv.wa_id, '\D', '', 'g'), 10)
     where cv.contacto_id is null and (p_sucursal is null or cv.sucursal_id = p_sucursal)
     order by cv.id, c.actualizado_en desc
  )
  update public.whatsapp_conversaciones cv
     set contacto_id = x.contacto_id
    from candidatos x
   where cv.id = x.conversacion_id;
  get diagnostics v_ligadas = row_count;

  -- Conversaciones sin dueño: quedan con el ejecutivo de la oportunidad activa más reciente de su contacto.
  update public.whatsapp_conversaciones cv
     set asignado_a = (
       select o2.ejecutivo
         from public.crm_oportunidades o2
        where o2.contacto_id = cv.contacto_id and o2.ejecutivo is not null and o2.ejecutivo <> ''
        order by (o2.estado_cartera = 'ACTIVA' and o2.estado = 'abierta') desc, o2.creado_en desc
        limit 1
     )
   where cv.contacto_id is not null and cv.asignado_a is null and (p_sucursal is null or cv.sucursal_id = p_sucursal);

  return v_ligadas;
end $$;

revoke all on function public.crm_vincular_conversaciones(uuid) from public, anon, authenticated;

select public.crm_vincular_conversaciones(null);
