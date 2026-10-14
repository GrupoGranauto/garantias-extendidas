/** Cómo se lee cada «Resultado BDC» en pantalla; el valor guardado sigue siendo el del Sheet (BUZON, CONTACTADO…). */
const ETIQUETA_RESULTADO: Record<string, string> = {
  PENDIENTE: "Pendiente",
  BUZON: "Buzón",
  "CONTACTO NO DISPONIBLE": "Contacto no disponible",
  "NO CONTACTABLE": "No contactable",
  CONTACTADO: "Contactado",
  "SOLICITA INFO WHATSAPP": "Solicita info por WhatsApp",
  INTERESADO: "Interesado",
  "PENDIENTE DECISION TERCERO": "Pendiente de decisión de un tercero",
  COTIZADO: "Cotizado",
  VENDIDO: "Vendido",
  "NO INTERESADO": "No interesado",
  "PRECIO FUERA PRESUPUESTO": "Precio fuera de presupuesto",
};

export function textoResultado(valor: string): string {
  return ETIQUETA_RESULTADO[valor] ?? valor.charAt(0) + valor.slice(1).toLowerCase();
}
