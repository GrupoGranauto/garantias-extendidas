/*
  Mensaje automático por llamadas sin respuesta (pedido de Miguel Borbón, 16-oct-2026).

  Cuando a un lead se le registraron N llamadas sin respuesta en su campaña actual (N y qué resultados cuentan se configuran
  por campaña), el motor le manda una vez, por paso de campaña, la plantilla elegida (por ejemplo «GE 5M Sin respuesta a la
  llamada»). Pasa por el mismo freno que un masivo (baja, supresiones, GE, pago, «Ahora no», un mensaje al día).

  1. crm_sin_respuesta_config: una fila por sucursal y campaña. telefonos_prueba = modo prueba (solo a esos teléfonos).
  2. crm_masivos.origen: de dónde salió el masivo (manual, primer_mensaje o sin_respuesta). Los automáticos que ya existen
     quedan como primer_mensaje.
*/
begin;
set local lock_timeout = '5s';

create table public.crm_sin_respuesta_config (
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  campana text not null,
  activa boolean not null default false,
  plantilla_id uuid references public.whatsapp_plantillas(id) on delete set null,
  intentos integer not null default 3 check (intentos between 1 and 20),
  resultados text[] not null default '{NO_CONTESTA,BUZON,CUELGA,OCUPADO}',
  telefonos_prueba text[] not null default '{}',
  actualizado_en timestamptz not null default now(),
  actualizado_por uuid references public.usuarios(id) on delete set null,
  primary key (sucursal_id, campana)
);
alter table public.crm_sin_respuesta_config enable row level security;
revoke all on table public.crm_sin_respuesta_config from public, anon, authenticated;
grant all on table public.crm_sin_respuesta_config to service_role;

alter table public.crm_masivos add column if not exists origen text not null default 'manual';
update public.crm_masivos set origen = 'primer_mensaje' where automatico and origen = 'manual';
alter table public.crm_masivos add constraint crm_masivos_origen_chk check (origen in ('manual', 'primer_mensaje', 'sin_respuesta'));

commit;

-- Reversa: drop table public.crm_sin_respuesta_config; alter table public.crm_masivos drop column origen;
