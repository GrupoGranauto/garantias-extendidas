-- Nombre del cliente por partes, como lo trae el origen crudo de BigQuery (nombre, apellido paterno, apellido materno).
-- «nombre» se sigue llenando con el nombre completo para la tabla, la ficha y el chat; las partes sirven para la
-- emisión y para saludar por nombre.
alter table public.crm_contactos
  add column if not exists nombre_pila text,
  add column if not exists apellido_paterno text,
  add column if not exists apellido_materno text;
