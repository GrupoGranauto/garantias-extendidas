-- Tabla de BigQuery de la que sincroniza cada sucursal. NULL = la cartera maestra real
-- (base-maestra-gn.garantias_extendidas.nis_ge_cartera_maestra). Se usa para apuntar una sucursal a una tabla de pruebas
-- (por ejemplo base-maestra-gn.app_ge.nis_ge_pruebas). Con una tabla distinta de la maestra, la sincronización no exige el
-- mínimo de filas ni frena si la cartera activa se desploma (una tabla de pruebas es chica a propósito).
alter table public.crm_config
  add column if not exists bq_tabla_fuente text
    check (bq_tabla_fuente is null or bq_tabla_fuente ~ '^[a-z0-9-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$');
