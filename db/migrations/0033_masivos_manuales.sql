/*
  Masivos manuales de WhatsApp (decisión del usuario, 2026-10-10): ya no hay envíos automáticos; el admin del grupo elige
  filas en la Base de Datos, una plantilla aprobada, y la web la manda por tandas en segundo plano.

  - crm_masivos: uno por cada vez que el admin da «Enviar». Guarda el nombre de la plantilla (por si después se borra),
    quién lo mandó y su estado. Los conteos (enviados, entregados, leídos, fallidos, omitidos) salen de sus envíos.
  - crm_envios: cada fila elegida es un envío del masivo, también las que no se mandan (baja, sin teléfono, ya recibió
    un mensaje hoy…), que quedan «omitido» con su motivo. Así funcionan igual que antes el webhook de entregado/leído, el
    «último mensaje» de la tabla y la regla de un mensaje por teléfono al día.
    «parametros» congela los valores de la plantilla al dar «Enviar»: sale lo que el admin vio en la vista previa.
*/

create table public.crm_masivos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  plantilla_id uuid references public.whatsapp_plantillas(id) on delete set null,
  plantilla_nombre text not null,
  creado_por uuid references public.usuarios(id) on delete set null,
  estado text not null default 'enviando' check (estado in ('enviando', 'terminado', 'detenido')),
  creado_en timestamptz not null default now(),
  terminado_en timestamptz
);
create index crm_masivos_sucursal_idx on public.crm_masivos (sucursal_id, creado_en desc);
create index crm_masivos_enviando_idx on public.crm_masivos (estado) where estado = 'enviando';

alter table public.crm_masivos enable row level security;
revoke all on public.crm_masivos from anon, authenticated;

alter table public.crm_envios add column masivo_id uuid references public.crm_masivos(id) on delete cascade;
alter table public.crm_envios add column parametros jsonb;

alter table public.crm_envios drop constraint crm_envios_origen_chk;
alter table public.crm_envios add constraint crm_envios_origen_chk
  check (paso_id is not null or seguimiento_id is not null or masivo_id is not null);

-- Una persona (lead) entra una sola vez a cada masivo.
create unique index crm_envios_masivo_uq on public.crm_envios (masivo_id, oportunidad_id) where masivo_id is not null;
