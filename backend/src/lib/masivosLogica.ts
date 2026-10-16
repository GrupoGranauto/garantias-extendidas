import { sumarDias, telefono10, type Ventana } from "./campanasLogica.js";

/**
 * Reglas de los masivos manuales de WhatsApp, sin base de datos (se prueban solas). El admin elige filas y una plantilla;
 * aquí se decide a quién sí le sale y por qué se omite a los demás, y cómo se ve el mensaje.
 */

/** Horario en que salen los mensajes (hora de Hermosillo, todos los días). Lo que se mande fuera espera a que abra. */
export const VENTANA_MASIVOS: Ventana = { dias_semana: [1, 2, 3, 4, 5, 6, 7], hora_inicio: "08:00", hora_fin: "20:00" };

/** Filas que caben en un masivo. */
export const MAX_DESTINATARIOS = 2000;

export const MOTIVOS_OMISION = [
  "otra_campana",
  "otro_estado",
  "otro_resultado",
  "otra_etapa_vehiculo",
  "baja",
  "no_contactable",
  "sin_telefono",
  "sin_celular",
  "mensaje_hoy",
  "telefono_repetido",
  "variable_vacia",
  // Del freno de la base (crm_motivo_no_enviar): supresiones por teléfono o VIN, venta, contrato y campaña.
  "supresion_numero_equivocado",
  "supresion_ya_no_tiene_auto",
  "supresion_flotilla",
  "supresion_uso_no_elegible",
  "supresion_fuera_km_tiempo",
  "contrato_cancelado",
  "fuera_de_regla",
  "lead_ganada",
  "lead_perdida",
  "ya_tiene_ge",
  "pagado",
  "ahora_no",
  "sin_paso_abierto",
  "cartera_inactiva",
  "lead_inexistente",
  "no_permitido",
  // D10: un primer mensaje por teléfono y campaña.
  "cubierto_mismo_telefono",
  "cubierto_en_cola",
] as const;
export type MotivoOmision = (typeof MOTIVOS_OMISION)[number];

/** Cómo se le explica al admin cada motivo. */
export const TEXTO_MOTIVO: Record<string, string> = {
  otra_campana: "la plantilla no es para su campaña",
  otro_estado: "la plantilla no es para su estado del lead",
  otro_resultado: "la plantilla no es para su Resultado BDC",
  otra_etapa_vehiculo: "la plantilla no es para la etapa de su vehículo",
  baja: "pidieron no ser contactados",
  no_contactable: "están marcados como no contactables",
  sin_telefono: "no tienen teléfono válido",
  sin_celular: "su número no es celular",
  mensaje_hoy: "ya recibieron o van a recibir un mensaje hoy",
  telefono_repetido: "comparten teléfono con otra fila elegida",
  variable_vacia: "les falta un dato que usa la plantilla",
  supresion_numero_equivocado: "su teléfono está marcado como número equivocado",
  supresion_ya_no_tiene_auto: "ya no tienen el vehículo",
  supresion_flotilla: "su vehículo es de flotilla",
  supresion_uso_no_elegible: "el uso de su vehículo no es elegible",
  supresion_fuera_km_tiempo: "su vehículo ya pasó el kilometraje o el tiempo de la garantía",
  contrato_cancelado: "su contrato está cancelado",
  fuera_de_regla: "no tienen la venta o la cotización que pide la plantilla",
  lead_ganada: "ya compraron la garantía",
  lead_perdida: "su lead está cerrado como perdido",
  ya_tiene_ge: "ya tienen garantía extendida",
  pagado: "ya tienen un pago o una compra registrada",
  ahora_no: "pidieron «Ahora no» en esta campaña",
  sin_paso_abierto: "su campaña terminó o cambió antes del envío",
  cartera_inactiva: "su campaña ya no está activa",
  lead_inexistente: "ya no están en la base",
  no_permitido: "no cumplen las condiciones para recibirlo",
  cubierto_mismo_telefono: "a su teléfono ya le llegó un mensaje de esta campaña",
  cubierto_en_cola: "a su teléfono ya le va a llegar un mensaje de esta campaña",
  detenido: "el masivo se detuvo antes de enviarles",
  plantilla_no_disponible: "la plantilla dejó de estar aprobada",
};

/**
 * El motivo del freno de la base (crm_motivo_no_enviar) como motivo de omisión. La supresión por baja es la misma baja,
 * las carteras que no están activas se agrupan en una, y un motivo que el código todavía no conoce se omite igual.
 */
export function motivoDelFreno(motivo: string | null | undefined): MotivoOmision | null {
  if (!motivo) return null;
  if (motivo === "supresion_baja") return "baja";
  if (motivo.startsWith("cartera_")) return "cartera_inactiva";
  return (MOTIVOS_OMISION as readonly string[]).includes(motivo) ? (motivo as MotivoOmision) : "no_permitido";
}

/**
 * A quién se le puede mandar una plantilla. Cada lista vacía = cualquiera; sin campañas, la plantilla es «General».
 * uso: «servicio» para las de póliza y cobro; sin dato, «campana».
 */
export type ReglasPlantilla = {
  campanas: string[];
  estados: string[];
  resultados: string[];
  etapasVehiculo: string[];
  uso?: "campana" | "servicio";
};

export const SIN_REGLAS: ReglasPlantilla = { campanas: [], estados: [], resultados: [], etapasVehiculo: [] };

/** Lo del lead que se compara con las reglas de la plantilla. */
export type DatosLead = { campana: string | null; estadoId: string | null; resultado: string | null; etapaVehiculoId: string | null };

/** Por qué la plantilla no es para este lead, o null si sí lo es. */
export function motivoPorReglas(r: ReglasPlantilla, d: DatosLead): MotivoOmision | null {
  if (r.campanas.length > 0 && !r.campanas.includes(d.campana ?? "")) return "otra_campana";
  if (r.estados.length > 0 && !r.estados.includes(d.estadoId ?? "")) return "otro_estado";
  if (r.resultados.length > 0 && !r.resultados.includes(d.resultado ?? "")) return "otro_resultado";
  if (r.etapasVehiculo.length > 0 && !r.etapasVehiculo.includes(d.etapaVehiculoId ?? "")) return "otra_etapa_vehiculo";
  return null;
}

/**
 * Las reglas con que se decide un envío. En una plantilla de servicio el estado del lead lo decide el freno de la base:
 * además del estado acepta lo que ya capturó el BDC (la venta o la fecha de compra para «Vendido», el contrato en cobro
 * para «Cotizado»). Para contar a quién le corresponde una plantilla se usan las reglas tal cual.
 */
export function reglasParaEnvio(r: ReglasPlantilla): ReglasPlantilla {
  return r.uso === "servicio" ? { ...r, estados: [] } : r;
}

/**
 * El uso de una plantilla: el que tiene guardado en sus reglas o, si todavía no tiene reglas, el que le daría su categoría
 * de Meta al guardarlas (utilidad = servicio; las demás, campaña).
 */
export function usoDePlantilla(uso: string | null | undefined, categoria: string | null | undefined): "campana" | "servicio" {
  if (uso === "campana" || uso === "servicio") return uso;
  return categoria === "utility" ? "servicio" : "campana";
}

/**
 * El primer mensaje automático va ligado al paso de campaña para el que se armó. Si al despacharlo ese ya no es el paso
 * abierto del lead (cambió de campaña, salió de la ventana o su campaña volvió a empezar), ya no le toca: lo que siga lo
 * decide el masivo automático del paso nuevo. Los masivos manuales no dependen del paso.
 */
export function motivoPorPaso(e: { automatico: boolean; pasoEnvio: string | null; pasoAbierto: string | null }): MotivoOmision | null {
  if (!e.automatico) return null;
  return e.pasoEnvio !== null && e.pasoEnvio === e.pasoAbierto ? null : "sin_paso_abierto";
}

/** Nombre de una campaña para la pantalla: 48H → «48 horas», 12M_NURTURING → «12 meses». */
export function etiquetaCampana(codigo: string): string {
  const horas = /^(\d+)H$/i.exec(codigo);
  if (horas) return `${horas[1]} horas`;
  const meses = /^(\d+)M(?:_|$)/i.exec(codigo);
  if (meses) return `${meses[1]} meses`;
  return codigo;
}

/** Para ordenar campañas de la más corta a la más larga (48H, 5M, 6M, 12M, 28M); las demás al final, por nombre. */
export function ordenCampana(codigo: string): number {
  const horas = /^(\d+)H$/i.exec(codigo);
  if (horas) return Number(horas[1]);
  const meses = /^(\d+)M(?:_|$)/i.exec(codigo);
  if (meses) return Number(meses[1]) * 24 * 30;
  return Number.MAX_SAFE_INTEGER;
}

export type Candidato = {
  oportunidadId: string;
  /** La plantilla no es para este lead (campaña, estado, resultado o etapa del vehículo). */
  fueraDeReglas?: MotivoOmision | null;
  /** Lo que dijo el freno de la base (supresiones, venta, contrato, campaña), ya como motivo de omisión. */
  freno?: MotivoOmision | null;
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
 * Teléfonos que ya recibieron (o tienen en cola) un mensaje hoy, sin los exentos. Solo se exentan los teléfonos de prueba
 * del primer mensaje automático (modo prueba): son del equipo y hay que poder repetir las pruebas el mismo día. A los
 * clientes el límite de un mensaje por día se les aplica siempre.
 */
export function telefonosOcupadosHoy(ocupados: string[], exentos: string[] = []): Set<string> {
  const fuera = new Set(exentos);
  return new Set(ocupados.filter((t) => !fuera.has(t)));
}

/**
 * A quién le sale el mensaje. Cada persona recibe a lo sumo uno por día: se omite a quien ya recibió (o tiene en cola)
 * un mensaje hoy, y si dos filas elegidas comparten teléfono, solo la primera que sí puede recibirlo.
 */
export function clasificarDestinatarios(candidatos: Candidato[], telefonosConMensajeHoy: Set<string>): Destinatario[] {
  const vistos = new Set<string>();
  return candidatos.map((c) => {
    const tel10 = telefono10(c.telefono);
    let motivo: MotivoOmision | null = null;
    // Primero, si la plantilla es para él: si no, ni siquiera es destinatario.
    if (c.fueraDeReglas) motivo = c.fueraDeReglas;
    else if (c.baja || c.estadoContacto === "baja") motivo = "baja";
    else if (c.freno) motivo = c.freno;
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

export type Omitido = { motivo: string; texto: string; n: number };

/** Un solo resumen de omitidos: el que se guardó al armar el masivo más las filas que quedaron omitidas, por motivo. */
export function juntarOmitidos(resumen: Omitido[], filas: { motivo: string; n: number }[]): Omitido[] {
  const porMotivo = new Map<string, Omitido>();
  for (const o of [...resumen, ...filas.map((f) => ({ ...f, texto: TEXTO_MOTIVO[f.motivo] ?? f.motivo }))]) {
    const ya = porMotivo.get(o.motivo);
    porMotivo.set(o.motivo, ya ? { ...ya, n: ya.n + o.n } : { motivo: o.motivo, texto: o.texto, n: o.n });
  }
  return [...porMotivo.values()];
}

/**
 * Si un envío pudo llegarle al teléfono: Meta lo aceptó, o falló sin un código de Meta (se interrumpió o no se confirmó;
 * no se sabe si salió). Con la duda se cuenta como entregado: es preferible perder un mensaje a mandarlo dos veces.
 * Misma regla que PUDO_LLEGAR en masivos.ts.
 */
export function pudoLlegar(e: { estado: string; errorCodigo: number | null }): boolean {
  return ["enviado", "entregado", "leido"].includes(e.estado) || (e.estado === "fallido" && e.errorCodigo === null);
}

/**
 * D10: días hacia atrás, desde el inicio de la campaña del candidato, en que un mensaje de esa misma campaña a su teléfono
 * lo cubre. Cubre las ventanas de las campañas (~31 días) y los vehículos comprados en días cercanos, que entran a la misma
 * campaña con unos días de diferencia; un segundo vehículo que entra meses después sí recibe su primer mensaje.
 */
export const VENTANA_COBERTURA_DIAS = 35;

/**
 * Un mensaje de la misma campaña ya registrado, de cualquier paso: un primer mensaje o un envío de un masivo manual ligado a
 * un paso de esa campaña. fecha: día de Hermosillo en que salió (o se creó, si sigue en cola).
 */
export type EnvioPrevio = { id: string; tel10: string | null; estado: string; errorCodigo: number | null; fecha: string };

/**
 * D10, un primer mensaje por teléfono y campaña. Un paso queda cubierto si a su teléfono ya le pudo llegar un mensaje de la
 * misma campaña (de este o de otro vehículo) desde VENTANA_COBERTURA_DIAS antes de que empezara la campaña de este (inicio,
 * fecha de Hermosillo): cubiertoPor es ese envío. Si el que lo cubriría sigue en cola, se salta hoy sin marcarlo (el
 * siguiente día se sabe si salió).
 */
export function cubiertoPorTelefono(
  c: { tel10: string | null; inicio: string },
  previos: EnvioPrevio[],
): { cubiertoPor: string | null; saltarHoy: boolean } {
  if (!c.tel10) return { cubiertoPor: null, saltarHoy: false };
  const desde = sumarDias(c.inicio, -VENTANA_COBERTURA_DIAS);
  const mismos = previos.filter((p) => p.tel10 === c.tel10 && p.fecha >= desde);
  const cubre = mismos
    .filter((p) => pudoLlegar(p))
    // Primero uno que Meta aceptó; luego el más antiguo.
    .sort((a, b) => Number(a.estado === "fallido") - Number(b.estado === "fallido") || a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id))[0];
  if (cubre) return { cubiertoPor: cubre.id, saltarHoy: false };
  return { cubiertoPor: null, saltarHoy: mismos.some((p) => p.estado === "pendiente") };
}

export type Componentes = {
  header?: { tipo: string; texto?: string | null; media_url?: string | null; nombre_archivo?: string | null } | null;
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
  if (c.header && c.header.tipo !== "texto" && !esUrlPublica(c.header.media_url)) {
    return "Su encabezado lleva un archivo que no está guardado en la plataforma; vuelve a subirlo en «Plantillas».";
  }
  if (c.header?.texto && /\{\{\d+\}\}/.test(c.header.texto)) return "Su encabezado lleva datos; los masivos solo los llenan en el cuerpo.";
  const faltan = indicesCuerpo(c.body.texto).filter((i) => !indicesLigados.includes(i));
  if (faltan.length > 0) return `Falta ligar ${faltan.map((i) => `{{${i}}}`).join(", ")} a una columna en «Plantillas».`;
  return null;
}

/** Meta descarga el archivo del encabezado de esta URL: tiene que ser pública (no una vista previa local del navegador). */
export function esUrlPublica(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https:\/\//i.test(url);
}

/** El archivo del encabezado (imagen, video o documento) que se manda con cada mensaje, o null si no lleva. */
export function encabezadoArchivo(c: Componentes | null): { tipo: "imagen" | "video" | "documento"; url: string; nombreArchivo: string | null } | null {
  const h = c?.header;
  if (!h || !h.media_url || !esUrlPublica(h.media_url)) return null;
  if (h.tipo !== "imagen" && h.tipo !== "video" && h.tipo !== "documento") return null;
  return { tipo: h.tipo, url: h.media_url, nombreArchivo: h.nombre_archivo ?? null };
}

/** El texto del cuerpo con los valores puestos. */
export function llenarCuerpo(cuerpo: string, indices: number[], parametros: string[]): string {
  return cuerpo.replace(/\{\{(\d+)\}\}/g, (_m, n) => parametros[indices.indexOf(Number(n))] ?? "");
}

/** El mensaje tal como lo verá el cliente: encabezado, cuerpo, pie y botones. */
export function vistaMensaje(c: Componentes, parametros: string[]) {
  const cuerpo = c.body?.texto ?? "";
  const pie = typeof c.footer === "string" ? c.footer : (c.footer?.texto ?? null);
  const archivo = encabezadoArchivo(c);
  return {
    encabezado: c.header?.tipo === "texto" ? (c.header.texto ?? null) : null,
    archivo: archivo ? { tipo: archivo.tipo, url: archivo.url, nombre: archivo.nombreArchivo } : null,
    cuerpo: llenarCuerpo(cuerpo, indicesCuerpo(cuerpo), parametros),
    pie: pie || null,
    botones: (c.botones ?? []).map((b) => b.texto),
  };
}
