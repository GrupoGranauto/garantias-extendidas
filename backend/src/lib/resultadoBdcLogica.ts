/**
 * «Resultado BDC»: el campo del Sheet con sus 12 valores. En la web es lo que elige el ejecutivo, y de él salen el estado
 * del lead (la columna del embudo), el motivo de pérdida y el estado de contacto. Al revés, mover la tarjeta o cambiar el
 * estado pone el resultado base de ese estado (si el que tenía ya era de ese estado, se respeta).
 */

export const RESULTADOS_BDC = [
  "PENDIENTE",
  "BUZON",
  "CONTACTO NO DISPONIBLE",
  "NO CONTACTABLE",
  "CONTACTADO",
  "SOLICITA INFO WHATSAPP",
  "INTERESADO",
  "PENDIENTE DECISION TERCERO",
  "COTIZADO",
  "VENDIDO",
  "NO INTERESADO",
  "PRECIO FUERA PRESUPUESTO",
] as const;

export type ResultadoBdc = (typeof RESULTADOS_BDC)[number];

export const esResultadoBdc = (v: unknown): v is ResultadoBdc => typeof v === "string" && (RESULTADOS_BDC as readonly string[]).includes(v);

type Destino = { etapa: string; motivo?: string; contacto?: string };

/** Estado del lead (clave de la etapa), motivo de pérdida (clave) y estado de contacto que deja cada resultado. */
export const DESTINO_DE_RESULTADO: Record<ResultadoBdc, Destino> = {
  PENDIENTE: { etapa: "por_contactar" },
  BUZON: { etapa: "por_contactar", contacto: "buzon" },
  "CONTACTO NO DISPONIBLE": { etapa: "por_contactar", contacto: "intentando" },
  "NO CONTACTABLE": { etapa: "perdido", motivo: "no_contactable", contacto: "no_contactable" },
  CONTACTADO: { etapa: "contactado", contacto: "contactado" },
  "SOLICITA INFO WHATSAPP": { etapa: "contactado", contacto: "contactado" },
  INTERESADO: { etapa: "interesado", contacto: "contactado" },
  "PENDIENTE DECISION TERCERO": { etapa: "interesado", contacto: "contactado" },
  COTIZADO: { etapa: "cotizado", contacto: "contactado" },
  VENDIDO: { etapa: "vendido", contacto: "contactado" },
  "NO INTERESADO": { etapa: "perdido", motivo: "no_interesado", contacto: "contactado" },
  "PRECIO FUERA PRESUPUESTO": { etapa: "perdido", motivo: "precio_fuera_presupuesto", contacto: "contactado" },
};

/** Color de cada resultado (tabla, filtros y ficha): fríos mientras se trabaja, verde al vender, rojos al perder. */
export const COLOR_RESULTADO: Record<ResultadoBdc, string> = {
  PENDIENTE: "#6b7280",
  BUZON: "#b89f00",
  "CONTACTO NO DISPONIBLE": "#d97706",
  "NO CONTACTABLE": "#7f1d1d",
  CONTACTADO: "#614dff",
  "SOLICITA INFO WHATSAPP": "#0e9f6e",
  INTERESADO: "#0891b2",
  "PENDIENTE DECISION TERCERO": "#0369a1",
  COTIZADO: "#9333ea",
  VENDIDO: "#16a34a",
  "NO INTERESADO": "#dc2626",
  "PRECIO FUERA PRESUPUESTO": "#be123c",
};

/** Nombre con que se crea un motivo de pérdida que el resultado necesita y la sucursal aún no tiene. */
export const NOMBRE_MOTIVO: Record<string, string> = {
  no_interesado: "No interesado",
  no_contactable: "No contactable",
  precio_fuera_presupuesto: "Precio fuera de presupuesto",
  // Motivos de cierre de Notion (los siembra la migración 0030; aquí por si una sucursal no los tiene).
  ya_tiene_ge: "Ya tiene GE",
  ya_no_tiene_auto: "Ya no tiene el auto",
  flotilla: "Flotilla o empresa",
  fuera_km_tiempo: "Fuera de km o tiempo",
  uso_no_elegible: "Uso no elegible",
  sin_respuesta_ventana: "Sin respuesta al terminar la ventana",
  pidio_baja: "Pidió baja",
};

/** Resultados que siguen «por contactar»: un contacto efectivo los puede avanzar solo. */
export const SIN_CONTACTO_EFECTIVO: ReadonlySet<ResultadoBdc> = new Set(["PENDIENTE", "BUZON", "CONTACTO NO DISPONIBLE"]);

/**
 * El resultado que corresponde a un estado del lead (al mover la tarjeta, cambiar el estado o el motivo de pérdida). Si el
 * resultado actual ya es de ese estado (y, en perdido, del mismo motivo), se respeta: «BUZON» sigue siendo «BUZON» en
 * «Por contactar». Un estado que no es de los del Sheet deja el resultado como estaba.
 */
export function resultadoDeEstado(etapaClave: string, motivoClave: string | null, actual: ResultadoBdc): ResultadoBdc {
  const d = DESTINO_DE_RESULTADO[actual];
  if (d.etapa === etapaClave && (etapaClave !== "perdido" || !motivoClave || d.motivo === motivoClave)) return actual;
  switch (etapaClave) {
    case "por_contactar":
      return "PENDIENTE";
    case "contactado":
      return "CONTACTADO";
    case "interesado":
      return "INTERESADO";
    case "cotizado":
      return "COTIZADO";
    case "vendido":
      return "VENDIDO";
    case "perdido":
      if (motivoClave === "no_contactable" || motivoClave === "pidio_baja") return "NO CONTACTABLE";
      if (motivoClave === "precio_fuera_presupuesto") return "PRECIO FUERA PRESUPUESTO";
      return "NO INTERESADO";
    default:
      return actual;
  }
}
