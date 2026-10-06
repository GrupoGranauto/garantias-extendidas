-- Programa de garantía extendida por sucursal y datos para emitir alineados al portal de Assurant.
--
-- Fuente: material GEXT (Nissan / Assurant, portal de emisión «NISSAN NUEVOS MSI 2026»). Las reglas que hoy valen
-- para Grupo GranAuto quedan como valores por omisión, pero cada sucursal (otro grupo, otro programa, otro año) las
-- puede cambiar: meses de garantía original, bandas de kilometraje, plazos, meses sin intereses, vigencia de la liga
-- de pago, estados de circulación y vendedores.

create table if not exists public.crm_programa_ge (
  sucursal_id uuid primary key references public.sucursales(id) on delete cascade,
  nombre text not null default 'NISSAN NUEVOS MSI 2026',
  area_venta text not null default 'NUEVOS',
  -- La garantía original (3 años): la extendida empieza al terminar.
  meses_garantia_original integer not null default 36 check (meses_garantia_original between 1 and 120),
  -- Límite superior de cada banda de km, en orden (0-15,000 y 15,001-59,000). El último es el máximo para vender.
  bandas_km integer[] not null default '{15000,59000}',
  -- Meses de extensión que se pueden contratar (+1, +2, +3 años).
  plazos_meses integer[] not null default '{12,24,36}',
  -- Meses sin intereses del pago «Financiado» con tarjeta. «Contado» no tiene MSI.
  msi_meses integer[] not null default '{3,6,9}',
  liga_pago_horas integer not null default 24 check (liga_pago_horas between 1 and 720),
  -- Lista del portal para «Estado de circulación» (y el estado de la dirección). Vacía = texto libre.
  estados_circulacion text[] not null default '{"Aguascalientes","Baja California","Baja California Sur","Campeche","Chiapas","Chihuahua","Ciudad de México","Coahuila","Colima","Durango","Estado de México","Guanajuato","Guerrero","Hidalgo","Jalisco","Michoacán","Morelos","Nayarit","Nuevo León","Oaxaca","Puebla","Querétaro","Quintana Roo","San Luis Potosí","Sinaloa","Sonora","Tabasco","Tamaulipas","Tlaxcala","Veracruz","Yucatán","Zacatecas"}',
  -- «Vendedor a asignar» del portal (es por distribuidor). Vacía = texto libre.
  vendedores text[] not null default '{}',
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

drop trigger if exists crm_programa_ge_tocar on public.crm_programa_ge;
create trigger crm_programa_ge_tocar before update on public.crm_programa_ge
  for each row execute function public.crm_tocar();

alter table public.crm_programa_ge enable row level security;
revoke all on public.crm_programa_ge from anon, authenticated;

-- Dirección del cliente por partes, como la pide el portal. La columna «direccion» (texto libre) queda como antecedente.
alter table public.crm_contactos
  add column if not exists dir_cp text,
  add column if not exists dir_estado text,
  add column if not exists dir_municipio text,
  add column if not exists dir_colonia text,
  add column if not exists dir_calle text,
  add column if not exists dir_num_ext text,
  add column if not exists dir_num_int text;

-- Lo que se contrata: plazo de la extensión, método de pago, meses sin intereses y vendedor.
alter table public.crm_contratos
  add column if not exists plazo_meses integer check (plazo_meses between 1 and 120),
  add column if not exists metodo_pago text check (metodo_pago in ('contado', 'financiado')),
  add column if not exists msi_meses integer check (msi_meses between 1 and 48),
  add column if not exists vendedor text;
