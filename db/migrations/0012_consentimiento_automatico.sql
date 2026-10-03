/* 0012: consentimiento por contrato de venta.

   Cuando la agencia confirma que el cliente autoriza ser contactado en su contrato de venta, el
   consentimiento se registra solo en cada contacto (con esa fuente, fecha y origen "automatico"), tanto
   para los que ya están en la base como para los que lleguen después. Quién lo confirmó y cuándo queda
   en crm_config. Un consentimiento retirado a mano o una baja siempre ganan sobre la regla. */

alter table public.crm_config
  add column if not exists consentimiento_automatico boolean not null default false,
  add column if not exists consentimiento_fuente text,
  add column if not exists consentimiento_confirmado_por uuid references public.usuarios(id) on delete set null,
  add column if not exists consentimiento_confirmado_en timestamptz;

alter table public.crm_contactos
  add column if not exists whatsapp_consentimiento_origen text check (whatsapp_consentimiento_origen in ('manual', 'automatico'));

update public.crm_contactos set whatsapp_consentimiento_origen = 'manual'
 where whatsapp_consentimiento is not null and whatsapp_consentimiento_origen is null;
