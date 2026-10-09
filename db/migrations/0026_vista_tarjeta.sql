/*
  Vista de la tarjeta del embudo: qué campo va en cada lugar de la tarjeta (primera línea, esquina, nombre,
  pie, etiquetas…) y qué extras se muestran (avatar, último mensaje, tareas, botón de llamar).

  La configura un admin de la sucursal desde el portal y la ven todos sus usuarios. Sin valor (null), la
  tarjeta usa la vista por defecto del backend (lib/vistaTarjetaLogica.ts).
*/

alter table public.entidad_definiciones add column if not exists tarjeta jsonb;
