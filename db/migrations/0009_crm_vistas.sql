/* 0009: vistas guardadas de la tabla/embudo (combinaciones de filtros, búsqueda, orden y vista).
   Personales por omisión; el admin puede compartirlas con toda la sucursal. */

create table if not exists public.crm_vistas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  usuario_id uuid references public.usuarios(id) on delete cascade,
  nombre text not null check (length(btrim(nombre)) between 1 and 60),
  compartida boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now()
);

create unique index if not exists crm_vistas_nombre_uk on public.crm_vistas (sucursal_id, coalesce(usuario_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(nombre));
create index if not exists crm_vistas_sucursal_idx on public.crm_vistas (sucursal_id, compartida);

alter table public.crm_vistas enable row level security;
revoke all on public.crm_vistas from anon, authenticated;
