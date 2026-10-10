import { telefono10, type Ventana } from "./campanasLogica.js";

/**
 * Reglas de los masivos manuales de WhatsApp, sin base de datos (se prueban solas). El admin elige filas y una plantilla;
 * aquí se decide a quién sí le sale y por qué se omite a los demás, y cómo se ve el mensaje.
 */

/** Horario en que salen los mensajes (hora de Hermosillo, todos los días). Lo que se mande fuera espera a que abra. */
export const VENTANA_MASIVOS: Ventana = { dias_semana: [1, 2, 3, 4, 5, 6, 7], hora_inicio: "08:00", hora_fin: "20:00" };

/** Filas que caben en un masivo. */
export const MAX_DESTINATARIOS = 2000;

export const MOTIVOS_OMISION = ["baja", "no_contactable", "sin_telefono", "sin_celular", "mensaje_hoy", "telefono_repetido", "variable_vacia"] as const;
export type MotivoOmision = (typeof MOTIVOS_OMISION)[number];

/** Cómo se le explica al admin cada motivo. */
export const TEXTO_MOTIVO: Record<string, string> = {
  baja: "pidieron no ser contactados",
  no_contactable: "están marcados como no contactables",
  sin_telefono: "no tienen teléfono válido",
  sin_celular: "su número no es celular",
  mensaje_hoy: "ya recibieron o van a recibir un mensaje hoy",
  telefono_repetido: "comparten teléfono con otra fila elegida",
  variable_vacia: "les falta un dato que usa la plantilla",
  detenido: "el masivo se detuvo antes de enviarles",
  plantilla_no_disponible: "la plantilla dejó de estar aprobada",
};

export type Candidato = {
  oportunidadId: string;
  telefono: unknown;
  /** null = no se sabe (se intenta). */
  tieneCelular: boolean | null;
  /** La persona pidió no ser contactada (en el contacto o en el lead). */
  baja: boolean;
  /** Clave de estado_contacto del lead. */
  estadoContacto: string | null;
  parametros: string[];
};

export type Destinatario = { oportunidadId: string; tel10: string | null; motivo: MotivoOmision | null };

/**
 * A quién le sale el mensaje. Cada persona recibe a lo sumo uno por día: se omite a quien ya recibió (o tiene en cola)
 * un mensaje hoy, y si dos filas elegidas comparten teléfono, solo la primera que sí puede recibirlo.
 */
export function clasificarDestinatarios(candidatos: Candidato[], telefonosConMensajeHoy: Set<string>): Destinatario[] {
  const vistos = new Set<string>();
  return candidatos.map((c) => {
    const tel10 = telefono10(c.telefono);
    let motivo: MotivoOmision | null = null;
    if (c.baja || c.estadoContacto === "baja") motivo = "baja";
    else if (c.estadoContacto === "no_contactable") motivo = "no_contactable";
    else if (!tel10) motivo = "sin_telefono";
    else if (c.tieneCelular === false) motivo = "sin_celular";
    else if (telefonosConMensajeHoy.has(tel10)) motivo = "mensaje_hoy";
    else if (c.parametros.some((p) => p === "")) motivo = "variable_vacia";
    else if (vistos.has(tel10)) motivo = "telefono_repetido";
    if (!motivo && tel10) vistos.add(tel10);
    return { oportunidadId: c.oportunidadId, tel10, motivo };
  });
}

/** Cuántas filas se omiten por cada motivo. */
export function contarOmitidos(destinatarios: Destinatario[]): Partial<Record<MotivoOmision, number>> {
  const cuenta: Partial<Record<MotivoOmision, number>> = {};
  for (const d of destinatarios) if (d.motivo) cuenta[d.motivo] = (cuenta[d.motivo] ?? 0) + 1;
  return cuenta;
}

export type Componentes = {
  header?: { tipo: string; texto?: string | null } | null;
  body?: { texto: string } | null;
  footer?: string | { texto?: string } | null;
  botones?: { tipo: string; texto: string }[] | null;
};

/** Los {{n}} del cuerpo, en orden y sin repetir. */
export function indicesCuerpo(cuerpo: string): number[] {
  return [...new Set([...cuerpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/**
 * Por qué una plantilla no sirve para un masivo, o null si sirve. Solo se mandan plantillas aprobadas cuyo encabezado no
 * lleve archivo ni datos, y con cada dato del cuerpo ligado a una columna.
 */
export function plantillaNoUsable(p: { estado: string; componentes: Componentes | null }, indicesLigados: number[]): string | null {
  if (p.estado !== "aprobada") return "Todavía no está aprobada por Meta.";
  const c = p.componentes;
  if (!c?.body?.texto) return "No tiene texto.";
  if (c.header && c.header.tipo !== "texto") return "Lleva una imagen o un archivo en el encabezado; los masivos solo mandan texto.";
  if (c.header?.texto && /\{\{\d+\}\}/.test(c.header.texto)) return "Su encabezado lleva datos; los masivos solo los llenan en el cuerpo.";
  const faltan = indicesCuerpo(c.body.texto).filter((i) => !indicesLigados.includes(i));
  if (faltan.length > 0) return `Falta ligar ${faltan.map((i) => `{{${i}}}`).join(", ")} a una columna en «Plantillas».`;
  return null;
}

/** El texto del cuerpo con los valores puestos. */
export function llenarCuerpo(cuerpo: string, indices: number[], parametros: string[]): string {
  return cuerpo.replace(/\{\{(\d+)\}\}/g, (_m, n) => parametros[indices.indexOf(Number(n))] ?? "");
}

/** El mensaje tal como lo verá el cliente: encabezado, cuerpo, pie y botones. */
export function vistaMensaje(c: Componentes, parametros: string[]) {
  const cuerpo = c.body?.texto ?? "";
  const pie = typeof c.footer === "string" ? c.footer : (c.footer?.texto ?? null);
  return {
    encabezado: c.header?.tipo === "texto" ? (c.header.texto ?? null) : null,
    cuerpo: llenarCuerpo(cuerpo, indicesCuerpo(cuerpo), parametros),
    pie: pie || null,
    botones: (c.botones ?? []).map((b) => b.texto),
  };
}
