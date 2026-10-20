/*
  Mensaje automático de seguimiento para leads en «Contactado» (pedido de Miguel Borbón, 19-oct-2026).

  Cuando un lead sigue en «Contactado» y pasó el tiempo configurado desde su última interacción (la última llamada
  registrada o el último mensaje de WhatsApp de su conversación, con el mismo peso), el motor le manda una vez, por paso de
  campaña, la plantilla de seguimiento elegida (por ejemplo «GE 12M Seguimiento»). Pasa por el mismo freno que un masivo.

  1. crm_seguimiento_config: una fila por sucursal y campaña. espera_horas = tiempo desde la última interacción.
     telefonos_prueba = modo prueba (solo a esos teléfonos).
  2. crm_masivos.origen admite 'seguimiento'.
*/
begin;
set local lock_timeout = '5s';

create table public.crm_seguimiento_config (
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  campana text not null,
  activa boolean not null default false,
  plantilla_id uuid references public.whatsapp_plantillas(id) on delete set null,
  espera_horas integer not null default 48 check (espera_horas between 1 and 720),
  telefonos_prueba text[] not null default '{}',
  actualizado_en timestamptz not null default now(),
  actualizado_por uuid references public.usuarios(id) on delete set null,
  primary key (sucursal_id, campana)
);
alter table public.crm_seguimiento_config enable row level security;
revoke all on table public.crm_seguimiento_config from public, anon, authenticated;
grant all on table public.crm_seguimiento_config to service_role;

alter table public.crm_masivos drop constraint crm_masivos_origen_chk;
alter table public.crm_masivos add constraint crm_masivos_origen_chk
  check (origen in ('manual', 'primer_mensaje', 'sin_respuesta', 'seguimiento'));

commit;

-- Reversa: drop table public.crm_seguimiento_config; y volver el check de origen a ('manual', 'primer_mensaje', 'sin_respuesta').
