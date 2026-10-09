create table if not exists public.cloudtalk_config (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null unique references public.sucursales(id) on delete cascade,
  api_access_key_id text not null,
  api_access_key_secret_cifrado text not null,
  activo boolean not null default true,
  actualizado_en timestamptz not null default now()
);

alter table public.cloudtalk_config enable row level security;
revoke all on public.cloudtalk_config from anon, authenticated;

create trigger cloudtalk_config_tocar before update on public.cloudtalk_config
for each row execute function public.crm_tocar();
