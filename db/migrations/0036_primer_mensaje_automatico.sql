/*
  Primer mensaje automático por campaña (decisión del usuario, 2026-10-14). Lo único que sale solo es el primer mensaje
  de cada campaña; el resto sigue siendo masivo manual.
  - crm_primer_mensaje_config: por campaña, si está encendido, la plantilla, los días de la semana (1 = lunes … 7 = domingo)
    y la hora a partir de la cual sale (dentro del horario de 08:00 a 20:00). telefonos_prueba: mientras tenga alguno, el
    envío automático solo considera a esos teléfonos (para probarlo de punta a punta sin mandarle a los clientes).
  - Cada día que toca, el motor arma un masivo automático por campaña (uno por día: crm_masivos_automatico_dia_uq) con los
    leads en esa campaña sin primer mensaje. Lo omitido no se guarda fila por fila (se repetiría a diario): queda el resumen
    en omitidos_resumen, y esos leads se vuelven a revisar el siguiente día permitido.
  - La marca de «ya se le mandó» es el paso de campaña (VIN | campaña | inicio), que nunca se borra aunque la base se
    reemplace cada día: crm_envios.campana_id ya apunta a él. primer_mensaje_intento distingue el envío automático y el
    índice único impide un segundo primer mensaje para el mismo paso. El intento 2 solo existe cuando el 1 no se entregó
    por el límite de marketing de Meta (error_codigo 131049).
*/

create table public.crm_primer_mensaje_config (
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  campana text not null,
  activa boolean not null default false,
  plantilla_id uuid references public.whatsapp_plantillas(id) on delete set null,
  dias_semana smallint[] not null default '{1,2,3,4,5,6}',
  hora time not null default '10:30',
  telefonos_prueba text[] not null default '{}',
  actualizado_en timestamptz not null default now(),
  actualizado_por uuid references public.usuarios(id) on delete set null,
  primary key (sucursal_id, campana),
  constraint crm_primer_mensaje_hora_chk check (hora >= time '08:00' and hora < time '20:00'),
  constraint crm_primer_mensaje_dias_chk check (dias_semana <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])
);

alter table public.crm_primer_mensaje_config enable row level security;
revoke all on public.crm_primer_mensaje_config from anon, authenticated;

alter table public.crm_masivos
  add column automatico boolean not null default false,
  add column campana text,
  add column fecha_local date,
  add column omitidos_resumen jsonb,
  add column nota text;

create unique index crm_masivos_automatico_dia_uq on public.crm_masivos (sucursal_id, campana, fecha_local) where automatico;

alter table public.crm_envios
  add column primer_mensaje_intento smallint check (primer_mensaje_intento in (1, 2)),
  add column error_codigo integer;

create unique index crm_envios_primer_mensaje_uq on public.crm_envios (campana_id, primer_mensaje_intento)
  where primer_mensaje_intento is not null;
