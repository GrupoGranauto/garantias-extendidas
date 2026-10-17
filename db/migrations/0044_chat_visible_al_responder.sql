/*
  El chat solo muestra conversaciones en las que el cliente ya contestó, y la única palabra de baja es «BAJA»
  (pedidos de Miguel Borbón, 16-oct-2026).

  1. Un mensaje que sale (primer mensaje, masivo, plantilla) ya no hace aparecer la conversación en la bandeja del chat:
     aparece cuando el cliente responde. No cuentan una respuesta «Ahora no» (el botón o lo mismo escrito: «ahora no», «no
     gracias», «no me interesa»…, la misma lista que PALABRAS_AHORA_NO en campanasLogica.ts) ni una «BAJA»: la campaña se
     pausa o el teléfono se bloquea, y el ejecutivo no tiene nada que atender.
     respondio_en = la primera respuesta del cliente que sí cuenta. La pone el webhook al guardar el mensaje; aquí se llena
     para las conversaciones que ya existen, con su historial.
  2. Baja por WhatsApp: solo la palabra «BAJA» (antes también «stop», «alto», «cancelar», «no más», «ya no»…, que ahora son
     respuestas normales). crm_reconciliar_bajas usa la misma lista que PALABRAS_BAJA en campanasLogica.ts; el resto de la
     función queda igual que en 0039.
*/
begin;
set local lock_timeout = '5s';

alter table public.whatsapp_conversaciones add column if not exists respondio_en timestamptz;

update public.whatsapp_conversaciones c
   set respondio_en = r.primera
  from (select m.conversacion_id, min(m.creado_en) as primera
          from public.whatsapp_mensajes m
         where m.direccion = 'entrante'
           and not (m.tipo = 'texto'
                    and crm_normalizar_texto(coalesce(m.texto, '')) in
                        ('ahora no', 'ahorita no', 'por ahora no', 'no por ahora', 'no gracias', 'no me interesa', 'baja'))
         group by m.conversacion_id) r
 where r.conversacion_id = c.id and c.respondio_en is null;

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
       -- Misma lista que PALABRAS_BAJA en campanasLogica.ts: solo «BAJA» (16-oct-2026).
       and crm_normalizar_texto(m.texto) in ('baja')
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

revoke execute on function public.crm_reconciliar_bajas(timestamptz) from public, anon, authenticated;
grant execute on function public.crm_reconciliar_bajas(timestamptz) to service_role;

commit;

-- Reversa: alter table public.whatsapp_conversaciones drop column respondio_en; y volver a crm_reconciliar_bajas de 0039.
