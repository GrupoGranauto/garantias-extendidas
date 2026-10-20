/*
  Reglas del contrato que mandan WhatsApp (pedido de Miguel Borbón, 20-oct-2026).

  Hasta hoy una regla del contrato solo creaba una tarea para el ejecutivo («cuando el contrato lleva N horas en el estado X»).
  Ahora cada regla elige su acción: crear la tarea o mandar una plantilla de WhatsApp de servicio (aviso de la liga de pago,
  recordatorio, liga vencida, póliza contratada, cómo mantenerla vigente). Usa el mismo reloj: una vez por cada entrada del
  contrato al estado, y nada si el contrato cambió de estado antes.

  1. crm_reglas_contrato.accion ('tarea' | 'whatsapp'), plantilla_id y telefonos_prueba (modo prueba: solo a esos teléfonos).
     En una regla de WhatsApp, vence_horas es la vigencia: si el mensaje ya no puede salir dentro de ese plazo desde que le
     tocaba (por ejemplo, de noche fuera del horario de envíos), ya no sale.
  2. crm_regla_contrato_ejecuciones.envio_id: el mensaje que dejó en cola.
  3. crm_masivos.origen admite 'contrato'.
*/
begin;
set local lock_timeout = '5s';

alter table public.crm_reglas_contrato
  add column if not exists accion text not null default 'tarea',
  add column if not exists plantilla_id uuid references public.whatsapp_plantillas(id) on delete set null,
  add column if not exists telefonos_prueba text[] not null default '{}';
alter table public.crm_reglas_contrato add constraint crm_reglas_contrato_accion_chk check (accion in ('tarea', 'whatsapp'));

alter table public.crm_regla_contrato_ejecuciones
  add column if not exists envio_id uuid references public.crm_envios(id) on delete set null;

alter table public.crm_masivos drop constraint crm_masivos_origen_chk;
alter table public.crm_masivos add constraint crm_masivos_origen_chk
  check (origen in ('manual', 'primer_mensaje', 'sin_respuesta', 'seguimiento', 'contrato'));

commit;

-- Reversa: quitar accion, plantilla_id y telefonos_prueba de crm_reglas_contrato, envio_id de las ejecuciones, y volver el
-- check de origen a ('manual', 'primer_mensaje', 'sin_respuesta', 'seguimiento').
