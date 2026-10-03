/* 0004: configuración del CRM por sucursal (roster de ejecutivos para asignación automática). */

create table if not exists public.crm_config (
  sucursal_id uuid primary key references public.sucursales(id) on delete cascade,
  roster_ejecutivos text[] not null default '{}',
  actualizado_en timestamptz not null default now()
);

alter table public.crm_config enable row level security;
revoke all on public.crm_config from anon, authenticated;

insert into public.crm_config (sucursal_id, roster_ejecutivos)
select id, array['María José Nuñez', 'Fernando Zazueta']
from public.sucursales
where subdominio = 'granauto'
on conflict (sucursal_id) do nothing;
