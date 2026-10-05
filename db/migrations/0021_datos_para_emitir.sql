/* Fase D · Datos para emitir la garantía extendida (portal de Assurant).
   El portal pide, además de lo que ya trae la maestra (VIN, modelo, versión, año, fecha de factura, km):
   número y valor de la factura original, número de motor, estado de circulación y dirección del cliente.
   - Los datos del vehículo viven en crm_vehiculos y la dirección en crm_contactos.
   - La sincronización con BigQuery solo escribe sus columnas de siempre: estas no se pisan. */

alter table public.crm_vehiculos
  add column if not exists numero_factura text check (numero_factura is null or char_length(numero_factura) <= 40),
  add column if not exists valor_factura numeric(12, 2) check (valor_factura is null or (valor_factura > 0 and valor_factura <= 99999999)),
  add column if not exists numero_motor text check (numero_motor is null or char_length(numero_motor) <= 30),
  add column if not exists estado_circulacion text check (estado_circulacion is null or char_length(estado_circulacion) <= 60),
  add column if not exists emision_actualizada_en timestamptz;

alter table public.crm_contactos
  add column if not exists direccion text check (direccion is null or char_length(direccion) <= 300);
