import { DESTINO_DE_RESULTADO, SIN_CONTACTO_EFECTIVO, type ResultadoBdc } from "./resultadoBdcLogica.js";

/**
 * Campos de gestión del ejecutivo BDC (Notion: «Pipeline y campos del ejecutivo BDC», tabla «Campos de la oportunidad ·
 * revisión»). Cada lista tiene códigos internos fijos y una etiqueta que cada grupo puede cambiar (crm_catalogo_opciones):
 * el BI compara por código y el portal muestra la etiqueta. Aquí viven los catálogos de arranque y las reglas puras de
 * cómo cada respuesta mueve el lead.
 */

export type Opcion = { clave: string; etiqueta: string };

/** Catálogos de arranque, en el orden de Notion. La migración siembra los mismos valores por sucursal. */
export const CATALOGOS = {
  respuesta_titular: [
    { clave: "PIDE_INFORMACION", etiqueta: "Pide información" },
    { clave: "PIDE_PRECIO", etiqueta: "Pide precio o cotización" },
    { clave: "QUIERE_PAGAR", etiqueta: "Quiere pagar ya" },
    { clave: "LLAMAR_DESPUES", etiqueta: "Llamar después" },
    { clave: "LO_VA_A_PENSAR", etiqueta: "Lo va a pensar" },
    { clave: "NO_INTERESADO", etiqueta: "No interesado" },
    { clave: "YA_TIENE_GE", etiqueta: "Ya tiene GE" },
    { clave: "YA_NO_TIENE_AUTO", etiqueta: "Ya no tiene el auto" },
    { clave: "FLOTILLA", etiqueta: "Es flotilla o empresa" },
    { clave: "QUEJA_SERVICIO", etiqueta: "Queja de servicio" },
    { clave: "NO_CONTACTAR", etiqueta: "Pide no ser contactado" },
  ],
  motivo_no_interes: [
    { clave: "PRECIO_ALTO", etiqueta: "Precio alto" },
    { clave: "NO_LO_NECESITA", etiqueta: "No lo necesita" },
    { clave: "VA_A_VENDER", etiqueta: "Va a vender el auto" },
    { clave: "MALA_EXPERIENCIA", etiqueta: "Mala experiencia con la agencia" },
    { clave: "TALLER_EXTERNO", etiqueta: "Prefiere taller externo" },
    { clave: "OTRO", etiqueta: "Otro" },
  ],
  donde_obtuvo_ge: [
    { clave: "AL_COMPRAR", etiqueta: "Al comprar el auto" },
    { clave: "ESTA_AGENCIA", etiqueta: "Después, en esta agencia" },
    { clave: "CALL_CENTER", etiqueta: "Por llamada de otro proveedor o call center" },
    { clave: "OTRA_AGENCIA", etiqueta: "En otra agencia" },
    { clave: "NO_SABE", etiqueta: "No sabe" },
  ],
  origen_venta: [
    { clave: "BDC", etiqueta: "BDC" },
    { clave: "MOSTRADOR", etiqueta: "Mostrador (al vender el auto)" },
    { clave: "SERVICIO", etiqueta: "Servicio" },
    { clave: "ORGANICA", etiqueta: "Orgánica" },
  ],
  clasificacion_respuesta: [
    { clave: "TITULAR", etiqueta: "Titular" },
    { clave: "OTRA_PERSONA", etiqueta: "Otra persona" },
    { clave: "BAJA", etiqueta: "Pide baja o STOP" },
    { clave: "SPAM", etiqueta: "Spam o no relacionado" },
    { clave: "NUMERO_EQUIVOCADO", etiqueta: "Número equivocado" },
  ],
} as const satisfies Record<string, readonly Opcion[]>;

export type Catalogo = keyof typeof CATALOGOS;
export const NOMBRES_CATALOGO = Object.keys(CATALOGOS) as Catalogo[];
export type RespuestaTitular = (typeof CATALOGOS.respuesta_titular)[number]["clave"];
export type MotivoNoInteres = (typeof CATALOGOS.motivo_no_interes)[number]["clave"];
export type ClasificacionRespuesta = (typeof CATALOGOS.clasificacion_respuesta)[number]["clave"];

export const esClaveDe = (catalogo: Catalogo, v: unknown): boolean =>
  typeof v === "string" && (CATALOGOS[catalogo] as readonly Opcion[]).some((o) => o.clave === v);

/* ============================================================
   Resultado de una llamada
   ============================================================ */

/** Los 8 resultados de una llamada (antes eran 4: contesto, no_contesto, buzon, numero_equivocado). */
export const RESULTADOS_LLAMADA = [
  "NO_CONTESTA",
  "BUZON",
  "CUELGA",
  "OCUPADO",
  "NUMERO_EQUIVOCADO",
  "NUMERO_INVALIDO",
  "CONTESTA_OTRA_PERSONA",
  "CONTESTA_TITULAR",
] as const;
export type ResultadoLlamada = (typeof RESULTADOS_LLAMADA)[number];

export const ETIQUETA_LLAMADA: Record<ResultadoLlamada, string> = {
  NO_CONTESTA: "No contesta",
  BUZON: "Buzón",
  CUELGA: "Cuelga sin hablar",
  OCUPADO: "Ocupado",
  NUMERO_EQUIVOCADO: "Número equivocado",
  NUMERO_INVALIDO: "Número inválido o fuera de servicio",
  CONTESTA_OTRA_PERSONA: "Contesta otra persona",
  CONTESTA_TITULAR: "Contesta el titular",
};

/**
 * El resultado «grueso» de siempre (contesto · no_contesto · buzon · numero_equivocado), que se sigue guardando en el
 * historial junto al detallado: los reportes, los seguimientos y las campañas cuentan los contactos con él.
 */
export const RESULTADO_GRUESO: Record<ResultadoLlamada, "contesto" | "no_contesto" | "buzon" | "numero_equivocado"> = {
  NO_CONTESTA: "no_contesto",
  BUZON: "buzon",
  CUELGA: "no_contesto",
  OCUPADO: "no_contesto",
  NUMERO_EQUIVOCADO: "numero_equivocado",
  NUMERO_INVALIDO: "numero_equivocado",
  CONTESTA_OTRA_PERSONA: "no_contesto",
  CONTESTA_TITULAR: "contesto",
};

/** Los códigos viejos que todavía puede mandar un cliente o que están en el historial. */
const LLAMADA_ANTERIOR: Record<string, ResultadoLlamada> = {
  contesto: "CONTESTA_TITULAR",
  no_contesto: "NO_CONTESTA",
  buzon: "BUZON",
  numero_equivocado: "NUMERO_EQUIVOCADO",
};

export function normalizarLlamada(v: unknown): ResultadoLlamada | null {
  if (typeof v !== "string") return null;
  if ((RESULTADOS_LLAMADA as readonly string[]).includes(v)) return v as ResultadoLlamada;
  return LLAMADA_ANTERIOR[v] ?? null;
}

/**
 * Estado de contacto y resultado BDC tras una llamada. Solo habla con el titular cuenta como contacto efectivo (Notion:
 * «Contacto efectivo: solo el titular»). Quien ya estaba contactado no retrocede por un «no contesta»; un número
 * equivocado o inválido deja el contacto como no contactable, pero cerrar la campaña lo decide el ejecutivo.
 */
export function efectoLlamada(
  r: ResultadoLlamada,
  contactoActual: string,
  resultadoActual: ResultadoBdc,
): { contacto: string; resultado: ResultadoBdc; efectivo: boolean } {
  const efectivo = r === "CONTESTA_TITULAR";
  let contacto: string;
  if (efectivo) contacto = "contactado";
  else if (r === "NUMERO_EQUIVOCADO" || r === "NUMERO_INVALIDO") contacto = "no_contactable";
  else if (contactoActual === "contactado") contacto = "contactado";
  else contacto = r === "BUZON" ? "buzon" : "intentando";
  if (contactoActual === "baja") contacto = "baja";

  let resultado = resultadoActual;
  if (SIN_CONTACTO_EFECTIVO.has(resultadoActual)) {
    if (efectivo) resultado = "CONTACTADO";
    else if (r === "BUZON") resultado = "BUZON";
    else if (r !== "NUMERO_EQUIVOCADO" && r !== "NUMERO_INVALIDO" && resultadoActual === "PENDIENTE") resultado = "CONTACTO NO DISPONIBLE";
  }
  return { contacto, resultado, efectivo };
}

/* ============================================================
   Respuesta del titular
   ============================================================ */

/** Respuestas que piden agendar el próximo contacto (Notion: obligatorio con «Llamar después» o «Lo va a pensar»). */
export const RESPUESTAS_CON_PROXIMO: ReadonlySet<string> = new Set(["LLAMAR_DESPUES", "LO_VA_A_PENSAR"]);

/** Avance del embudo según el estado del lead: un resultado positivo nunca hace retroceder. */
const RANGO: Record<string, number> = { por_contactar: 0, contactado: 1, interesado: 2, cotizado: 3, vendido: 4 };

export type EfectoRespuesta = {
  /** Resultado BDC que corresponde, o null si el lead ya va más adelante y se queda como está. */
  resultado: ResultadoBdc | null;
  /** Motivo de pérdida (clave) cuando la respuesta cierra la oportunidad. */
  motivo: string | null;
  requiereProximoContacto: boolean;
  requiereMotivoNoInteres: boolean;
  /** Datos que la respuesta deja marcados en el lead. */
  marcas: { declara_ge?: true; conserva_auto?: false; escalar_posventa?: true; no_contactar?: true };
};

/**
 * Cómo mueve el lead la respuesta del titular (Notion, sección 3 «Cómo se mueve el hito»): pide precio o quiere pagar →
 * Interesado; no interesado, ya tiene GE, ya no tiene el auto, flotilla o pide no ser contactado → cierra con su motivo;
 * el resto deja el lead contactado. «No interesado» por precio es el «PRECIO FUERA PRESUPUESTO» del Sheet.
 */
export function efectoRespuesta(
  respuesta: RespuestaTitular,
  motivoNoInteres: MotivoNoInteres | null,
  resultadoActual: ResultadoBdc,
): EfectoRespuesta {
  const base: EfectoRespuesta = { resultado: null, motivo: null, requiereProximoContacto: false, requiereMotivoNoInteres: false, marcas: {} };
  const avanzar = (destino: ResultadoBdc): ResultadoBdc | null => {
    if (resultadoActual === "VENDIDO") return null;
    const actual = DESTINO_DE_RESULTADO[resultadoActual].etapa;
    if (actual === "perdido") return destino; // Volvió a hablar con el titular: la oportunidad se reabre.
    return RANGO[DESTINO_DE_RESULTADO[destino].etapa] > (RANGO[actual] ?? 0) ? destino : null;
  };
  const cerrar = (motivo: string, resultado: ResultadoBdc): EfectoRespuesta =>
    resultadoActual === "VENDIDO" ? base : { ...base, resultado, motivo };

  switch (respuesta) {
    case "PIDE_INFORMACION":
      return { ...base, resultado: avanzar("CONTACTADO") };
    case "PIDE_PRECIO":
    case "QUIERE_PAGAR":
      return { ...base, resultado: avanzar("INTERESADO") };
    case "LLAMAR_DESPUES":
    case "LO_VA_A_PENSAR":
      return { ...base, resultado: avanzar("CONTACTADO"), requiereProximoContacto: RESPUESTAS_CON_PROXIMO.has(respuesta) };
    case "QUEJA_SERVICIO":
      return { ...base, resultado: avanzar("CONTACTADO"), marcas: { escalar_posventa: true } };
    case "NO_INTERESADO":
      return motivoNoInteres === "PRECIO_ALTO"
        ? { ...cerrar("precio_fuera_presupuesto", "PRECIO FUERA PRESUPUESTO"), requiereMotivoNoInteres: true }
        : { ...cerrar("no_interesado", "NO INTERESADO"), requiereMotivoNoInteres: true };
    case "YA_TIENE_GE":
      return { ...cerrar("ya_tiene_ge", "NO INTERESADO"), marcas: { declara_ge: true } };
    case "YA_NO_TIENE_AUTO":
      return { ...cerrar("ya_no_tiene_auto", "NO INTERESADO"), marcas: { conserva_auto: false } };
    case "FLOTILLA":
      return cerrar("flotilla", "NO INTERESADO");
    case "NO_CONTACTAR":
      return { ...cerrar("pidio_baja", "NO CONTACTABLE"), marcas: { no_contactar: true } };
  }
}

/** Valida lo que pide cada respuesta (campos condicionales de Notion). Devuelve el error o null. */
export function validarRespuesta(p: {
  respuesta: RespuestaTitular;
  motivoNoInteres: MotivoNoInteres | null;
  proximoContacto: string | null;
  comentario: string | null;
  ahora?: Date;
}): string | null {
  const e = efectoRespuesta(p.respuesta, p.motivoNoInteres, "PENDIENTE");
  if (e.requiereMotivoNoInteres && !p.motivoNoInteres) return "Elige el motivo de no interés.";
  if (p.motivoNoInteres === "OTRO" && !p.comentario?.trim()) return "Con «Otro» como motivo de no interés, escribe un comentario.";
  if (e.requiereProximoContacto) {
    if (!p.proximoContacto) return "Indica cuándo volver a contactarlo.";
    const t = new Date(p.proximoContacto).getTime();
    if (Number.isNaN(t)) return "La fecha del próximo contacto no es válida.";
    if (t < (p.ahora ?? new Date()).getTime() - 60_000) return "El próximo contacto debe ser a futuro.";
  }
  return null;
}

/**
 * Una fecha capturada a mano (pago, envío del link, compra de la GE): día real del calendario, desde el 2000 y no a
 * futuro. Evita que un año a medio teclear («0002») o un 30 de febrero lleguen a la base.
 */
export function fechaCapturaValida(valor: string, hoy: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const d = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) return false;
  return valor >= "2000-01-01" && valor <= hoy;
}

/* ============================================================
   Clasificación de una respuesta por WhatsApp
   ============================================================ */

/**
 * Qué hace la clasificación de una respuesta al mensaje: «Titular» es contacto efectivo; «Pide baja» es no contactar;
 * «Número equivocado» deja el teléfono como no contactable. «Otra persona» y «Spam» solo se registran.
 */
export function efectoClasificacion(c: ClasificacionRespuesta): { efectivo: boolean; noContactar: boolean; numeroEquivocado: boolean } {
  return { efectivo: c === "TITULAR", noContactar: c === "BAJA", numeroEquivocado: c === "NUMERO_EQUIVOCADO" };
}

/* ============================================================
   Estado de la oportunidad (calculado)
   ============================================================ */

export type EstadoOportunidad = "Abierta" | "Ganada" | "Perdida" | "Expirada" | "Baja";

/**
 * Abierta · Ganada · Perdida · Expirada (salió de la campaña sin cerrarse) · Baja (pidió no ser contactado). Una venta
 * sigue siendo venta aunque después pida no ser contactado; fuera de eso, la baja gana sobre todo.
 */
export function estadoOportunidad(p: { estado: string; estadoContacto: string; noContactar: boolean; estadoCartera: string }): EstadoOportunidad {
  if (p.estado === "ganada") return "Ganada";
  if (p.noContactar || p.estadoContacto === "baja") return "Baja";
  if (p.estado === "perdida") return "Perdida";
  if (p.estadoCartera !== "ACTIVA") return "Expirada";
  return "Abierta";
}
