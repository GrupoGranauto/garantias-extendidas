/*
  Las tareas pendientes se cierran solas (decisión del usuario, 2026-10-09):
  - Al registrar una llamada o un WhatsApp con el cliente (desde la ficha o desde el chat), las tareas pendientes de ese
    lead quedan hechas. Las preguntas no: piden una respuesta del cliente.
  - Al vender o perder el lead, se descartan todas sus pendientes, preguntas incluidas.
  - Cuando la persona pide no ser contactada (el lead queda en «Baja»), igual.
  «cierre_automatico» guarda por qué se cerró sola; vacío = la cerró una persona.
*/

alter table public.crm_tareas add column cierre_automatico text
  check (cierre_automatico in ('contacto', 'lead_cerrado', 'baja'));

create function public.crm_tareas_cerrar_por_contacto() returns trigger
language plpgsql set search_path = public as $$
begin
  update crm_tareas t
     set estado = 'hecha', completada_en = now(), completada_por = new.usuario_id, cierre_automatico = 'contacto'
   where t.oportunidad_id = new.oportunidad_id and t.estado = 'pendiente' and t.tipo = 'tarea';
  return null;
end $$;

-- Solo lo que hace una persona: la llamada o el WhatsApp registrados por el ejecutivo. Los envíos de campaña
-- (envio_campana) y los mensajes que escribe el cliente (mensaje_entrante) no cierran nada; lo migrado tampoco.
create trigger crm_actividades_cierra_tareas after insert on public.crm_actividades
  for each row when (new.tipo in ('llamada', 'whatsapp') and coalesce(new.detalle->>'origen', '') <> 'migracion')
  execute function public.crm_tareas_cerrar_por_contacto();

create function public.crm_tareas_descartar_pendientes() returns trigger
language plpgsql set search_path = public as $$
begin
  update crm_tareas t
     set estado = 'cancelada', completada_en = now(), cierre_automatico = tg_argv[0]
   where t.oportunidad_id = new.id and t.estado = 'pendiente';
  return null;
end $$;

create trigger crm_oportunidades_cerrada_cierra_tareas after update of estado on public.crm_oportunidades
  for each row when (old.estado = 'abierta' and new.estado <> 'abierta')
  execute function public.crm_tareas_descartar_pendientes('lead_cerrado');

create trigger crm_oportunidades_baja_cierra_tareas after update of estado_contacto on public.crm_oportunidades
  for each row when (new.estado_contacto = 'baja' and old.estado_contacto is distinct from 'baja')
  execute function public.crm_tareas_descartar_pendientes('baja');
