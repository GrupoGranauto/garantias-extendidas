import { z } from "zod";

/**
 * Vista de la tarjeta del embudo: qué campo va en cada lugar de la tarjeta. La configura un admin de la sucursal y
 * la ven todos sus usuarios. Los lugares siguen la tarjeta de arriba a abajo:
 *
 *   [avatar]  arriba, arriba_extra                 esquina
 *             subtitulo
 *             titulo
 *             detalle
 *             pie  [etiquetas…]                    tareas · llamar
 *             (último mensaje del contacto)
 */
export const LUGARES = ["arriba", "arriba_extra", "esquina", "subtitulo", "titulo", "detalle", "pie"] as const;
export type Lugar = (typeof LUGARES)[number];

export type VistaTarjeta = Record<Lugar, string | null> & {
  etiquetas: string[];
  avatar: boolean;
  ultimo_mensaje: boolean;
  tareas: boolean;
  llamar: boolean;
};

export const MAX_ETIQUETAS = 6;

export const VISTA_POR_DEFECTO: VistaTarjeta = {
  arriba: "linea",
  arriba_extra: "anio_vin",
  esquina: "entro_a_etapa_en",
  subtitulo: "agencia",
  titulo: "cliente",
  detalle: "telefono_principal",
  pie: "ejecutivo",
  etiquetas: ["campana", "vin"],
  avatar: true,
  ultimo_mensaje: false,
  tareas: true,
  llamar: true,
};

const campo = z.string().max(80).nullable();
export const vistaSchema = z.object({
  arriba: campo,
  arriba_extra: campo,
  esquina: campo,
  subtitulo: campo,
  titulo: z.string().min(1, "Elige qué campo va como nombre de la tarjeta.").max(80),
  detalle: campo,
  pie: campo,
  etiquetas: z.array(z.string().max(80)).max(MAX_ETIQUETAS, `Máximo ${MAX_ETIQUETAS} etiquetas.`),
  avatar: z.boolean(),
  ultimo_mensaje: z.boolean(),
  tareas: z.boolean(),
  llamar: z.boolean(),
});

/**
 * Vista lista para usar: solo campos que existen en la sucursal; lo que no venga toma el valor por defecto. Un campo
 * que el admin ya no ve (se ocultó o se quitó) simplemente deja su lugar vacío.
 */
export function normalizarVista(cruda: unknown, disponibles: string[]): VistaTarjeta {
  const v = (cruda && typeof cruda === "object" && !Array.isArray(cruda) ? cruda : {}) as Record<string, unknown>;
  const valido = (c: unknown): string | null => (typeof c === "string" && disponibles.includes(c) ? c : null);
  const vista = { ...VISTA_POR_DEFECTO };
  for (const l of LUGARES) vista[l] = valido(l in v ? v[l] : VISTA_POR_DEFECTO[l]);
  vista.titulo = vista.titulo ?? valido("cliente") ?? disponibles[0] ?? null;
  const etiquetas = Array.isArray(v.etiquetas) ? v.etiquetas : VISTA_POR_DEFECTO.etiquetas;
  vista.etiquetas = [...new Set(etiquetas.map(valido).filter((c): c is string => c !== null))].slice(0, MAX_ETIQUETAS);
  for (const k of ["avatar", "ultimo_mensaje", "tareas", "llamar"] as const) {
    vista[k] = typeof v[k] === "boolean" ? (v[k] as boolean) : VISTA_POR_DEFECTO[k];
  }
  return vista;
}

/**
 * Columnas que hay que leer para dibujar la tarjeta, más las que usa el tablero aunque no se muestren: el tiempo en
 * el estado (fuera de tiempo), el motivo de pérdida y el teléfono para el botón de llamar.
 */
export function columnasDeVista(vista: VistaTarjeta, disponibles: string[]): string[] {
  const columnas = new Set<string>(["entro_a_etapa_en", "motivo_perdida"]);
  for (const l of LUGARES) if (vista[l]) columnas.add(vista[l] as string);
  for (const e of vista.etiquetas) columnas.add(e);
  if (vista.llamar) columnas.add("telefono_principal");
  return disponibles.filter((c) => columnas.has(c));
}
