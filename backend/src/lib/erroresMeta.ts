/**
 * Por qué WhatsApp no entregó un mensaje, en español y con qué hacer. Meta manda un código y un texto en inglés;
 * se traduce por código y, si no viene (mensajes que ya estaban guardados), por el texto.
 */
const POR_CODIGO: Record<number, string> = {
  131049: "Meta no lo entregó para no saturar a la persona con mensajes de marketing. Inténtalo de nuevo en uno o más días.",
  131050: "La persona pidió en WhatsApp no recibir mensajes de marketing de este negocio.",
  130472: "Meta no lo entregó porque el número participa en una prueba de Meta sobre mensajes de marketing.",
  131026: "No se pudo entregar: el número no tiene WhatsApp, no aceptó los términos más recientes o su app está desactualizada.",
  131047: "Pasaron más de 24 horas desde el último mensaje del cliente: solo se le puede escribir con una plantilla.",
  131053: "WhatsApp no pudo descargar el archivo adjunto (imagen, video o documento).",
  131042: "Hay un problema con el método de pago de la cuenta de WhatsApp: revísalo en la configuración de pagos de Meta.",
  141006: "Hay un problema con el método de pago de la cuenta de WhatsApp: revísalo en la configuración de pagos de Meta.",
  131031: "La cuenta de WhatsApp del negocio está bloqueada o restringida.",
  368: "La cuenta de WhatsApp está bloqueada temporalmente por infringir políticas.",
  131048: "Meta limitó los envíos porque muchos mensajes se marcaron como spam.",
  131056: "Se mandaron demasiados mensajes seguidos a este número: espera unos minutos.",
  130429: "Se alcanzó el límite de envíos por segundo: inténtalo de nuevo en un momento.",
  131008: "Falta un dato de la plantilla (por ejemplo, el nombre del cliente).",
  131009: "Un dato de la plantilla no es válido.",
  132000: "La cantidad de datos no coincide con la plantilla.",
  132001: "La plantilla no existe en WhatsApp o no está aprobada en ese idioma.",
  132007: "La plantilla infringe las políticas de WhatsApp.",
  132012: "Un dato de la plantilla no tiene el formato correcto.",
  132015: "La plantilla está pausada por baja calidad.",
  132016: "La plantilla está desactivada por baja calidad.",
  131021: "No se le puede mandar un mensaje al mismo número del negocio.",
  131051: "WhatsApp no acepta ese tipo de mensaje.",
  131057: "La cuenta de WhatsApp está en mantenimiento.",
  133010: "El número del negocio no está registrado en WhatsApp.",
  131000: "WhatsApp tuvo un error temporal: inténtalo de nuevo.",
};

/** Para los que solo traen el texto en inglés. */
const POR_TEXTO: [RegExp, number][] = [
  [/healthy ecosystem/i, 131049],
  [/(chosen|choose|opted) to stop receiving marketing|stopped marketing/i, 131050],
  [/experiment/i, 130472],
  [/undeliverable/i, 131026],
  [/re-?engagement|more than 24 hours/i, 131047],
  [/media (upload|download)/i, 131053],
  [/payment/i, 131042],
  [/spam rate/i, 131048],
  [/pair rate limit/i, 131056],
  [/required parameter is missing/i, 131008],
];

/** El motivo en español; si no se reconoce, el texto tal como llegó (o null si no hay nada). */
export function motivoFallaWhatsApp(codigo: number | null | undefined, texto?: string | null): string | null {
  if (codigo != null && POR_CODIGO[codigo]) return POR_CODIGO[codigo];
  if (texto) {
    for (const [patron, c] of POR_TEXTO) if (patron.test(texto)) return POR_CODIGO[c];
  }
  return texto ?? null;
}
