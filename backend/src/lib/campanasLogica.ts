/**
 * Reglas de los envíos automáticos por campaña, como funciones puras (sin base de datos ni red) para
 * poder probarlas a fondo. El motor (campanasEnvio.ts) solo reúne los datos y ejecuta la decisión.
 *
 * Todo se calcula en hora de Hermosillo, que no cambia de horario: la ventana de envío "09:00–19:00"
 * significa lo mismo todo el año.
 */

export const ZONA_ENVIOS = "America/Hermosillo";

/** Las campañas que hoy produce la cartera maestra. */
export const CAMPANAS_CONOCIDAS = ["48H", "5M", "12M_NURTURING", "28M"] as const;

export type Ventana = {
  /** 1 = lunes … 7 = domingo. */
  dias_semana: number[];
  /** "HH:MM" o "HH:MM:SS". */
  hora_inicio: string;
  hora_fin: string;
};

/** "09:30" o "09:30:00" a minutos desde la medianoche. */
export function aMinutos(hora: string): number {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function deMinutos(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Día de la semana de una fecha 'YYYY-MM-DD': 1 = lunes … 7 = domingo. */
export function diaSemana(fecha: string): number {
  const d = new Date(`${fecha}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return d === 0 ? 7 : d;
}

export function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** La misma fecha si ese día se puede enviar; si no, el siguiente día permitido. */
export function proximoDiaPermitido(fecha: string, dias: number[]): string {
  if (dias.length === 0) return fecha; // sin días configurados no hay ventana: la validación lo impide al guardar
  let f = fecha;
  for (let i = 0; i < 8; i++) {
    if (dias.includes(diaSemana(f))) return f;
    f = sumarDias(f, 1);
  }
  return fecha;
}

/**
 * Cuándo toca un paso: `diasDespues` desde el inicio de la campaña, a la hora pedida (o al abrir la
 * ventana). Si cae en un día no permitido pasa al siguiente que sí; si la hora queda fuera de la ventana,
 * se ajusta a ella. Devuelve fecha y hora locales.
 */
export function calcularProgramacion(
  fechaInicio: string,
  diasDespues: number,
  hora: string | null,
  ventana: Ventana,
): { fecha: string; hora: string } {
  const fecha = proximoDiaPermitido(sumarDias(fechaInicio, diasDespues), ventana.dias_semana);
  const ini = aMinutos(ventana.hora_inicio);
  const fin = aMinutos(ventana.hora_fin);
  const pedida = hora ? aMinutos(hora) : ini;
  return { fecha, hora: deMinutos(Math.min(Math.max(pedida, ini), fin - 1)) };
}

export type AhoraLocal = { fecha: string; minutos: number };

/** Fecha y minutos del día en Hermosillo para un instante. */
export function ahoraLocal(instante: Date = new Date()): AhoraLocal {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_ENVIOS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instante);
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "00";
  return { fecha: `${g("year")}-${g("month")}-${g("day")}`, minutos: Number(g("hour")) * 60 + Number(g("minute")) };
}

export function dentroDeVentana(ahora: AhoraLocal, v: Ventana): boolean {
  return v.dias_semana.includes(diaSemana(ahora.fecha)) && ahora.minutos >= aMinutos(v.hora_inicio) && ahora.minutos < aMinutos(v.hora_fin);
}

/** El próximo momento (fecha y hora locales) en que se abre la ventana de envío. */
export function siguienteApertura(ahora: AhoraLocal, v: Ventana): { fecha: string; hora: string } {
  const ini = aMinutos(v.hora_inicio);
  const hoyPermitido = v.dias_semana.includes(diaSemana(ahora.fecha));
  if (hoyPermitido && ahora.minutos < ini) return { fecha: ahora.fecha, hora: deMinutos(ini) };
  return { fecha: proximoDiaPermitido(sumarDias(ahora.fecha, 1), v.dias_semana), hora: deMinutos(ini) };
}

/** Teléfono a 10 dígitos (últimos 10), o null si no alcanza. */
export function telefono10(valor: unknown): string | null {
  const d = String(valor ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export type ContextoEnvio = {
  ahora: AhoraLocal;
  ahoraMs: number;
  programadoMs: number;
  /** Motivo con que se pospuso antes: si vence la vigencia, ese es el motivo final. */
  motivoPrevio: string | null;
  vigenciaDias: number;
  configActiva: boolean;
  ventana: Ventana;
  maxPorDia: number;
  enviadosHoy: number;
  oportunidad: { campana: string | null; campanaEsperada: string; estadoCartera: string; estado: string; etapa: string | null };
  contacto: { consentimiento: boolean | null; baja: boolean; telefono10: string | null; tieneCelular: boolean | null };
  paso: { etapas: string[]; soloSinRespuesta: boolean; soloSinContacto: boolean };
  respondio: boolean;
  yaContactado: boolean;
  /** Se le escribió desde OTRA campaña dentro del periodo de descanso. */
  enviadoRecienteOtraCampana: boolean;
  whatsappListo: boolean;
  plantillaDisponible: boolean;
};

export type Decision =
  | { accion: "enviar" }
  | { accion: "omitir"; motivo: string }
  | { accion: "posponer"; motivo: string; hasta: "ventana" | "dia_siguiente" | { minutos: number } };

const MS_DIA = 86_400_000;

/**
 * Qué hacer con un envío pendiente que ya le toca. Va de lo definitivo a lo temporal:
 *  - se OMITE (queda registrado el motivo) cuando ya no tiene sentido enviarlo: la oportunidad cambió,
 *    el contacto pidió la baja, falta teléfono, ya respondió, etc.;
 *  - se POSPONE cuando solo hay que esperar: sin consentimiento aún, fuera de horario, tope del día,
 *    descanso entre campañas, plantilla no disponible;
 *  - se ENVÍA solo si pasa todo. Sin consentimiento registrado no se envía nunca.
 * Si algo sigue pospuesto cuando vence la vigencia del paso, se omite con ese motivo.
 */
export function decidirEnvio(c: ContextoEnvio): Decision {
  const vencido = c.ahoraMs > c.programadoMs + c.vigenciaDias * MS_DIA;

  if (!c.configActiva) return { accion: "posponer", motivo: "campana_apagada", hasta: { minutos: 60 } };

  const o = c.oportunidad;
  if (o.campana !== o.campanaEsperada || o.estadoCartera !== "ACTIVA" || o.estado !== "abierta") {
    return { accion: "omitir", motivo: "ya_no_aplica" };
  }
  if (c.contacto.baja) return { accion: "omitir", motivo: "baja" };
  if (!c.contacto.telefono10) return { accion: "omitir", motivo: "sin_telefono" };
  if (c.contacto.tieneCelular === false) return { accion: "omitir", motivo: "sin_celular" };
  if (c.paso.etapas.length > 0 && (!o.etapa || !c.paso.etapas.includes(o.etapa))) return { accion: "omitir", motivo: "etapa_no_permitida" };
  if (c.paso.soloSinRespuesta && c.respondio) return { accion: "omitir", motivo: "respondio" };
  if (c.paso.soloSinContacto && c.yaContactado) return { accion: "omitir", motivo: "ya_contactado" };

  // De aquí en adelante solo se espera. Si la vigencia ya venció, se cierra con el motivo que lo detenía.
  const esperar = (motivo: string, hasta: "ventana" | "dia_siguiente" | { minutos: number }): Decision =>
    vencido ? { accion: "omitir", motivo: c.motivoPrevio ?? motivo } : { accion: "posponer", motivo, hasta };

  if (c.contacto.consentimiento !== true) return esperar("sin_consentimiento", { minutos: 60 });
  if (c.enviadoRecienteOtraCampana) return esperar("descanso_entre_campanas", { minutos: 360 });
  if (!dentroDeVentana(c.ahora, c.ventana)) return esperar("fuera_de_ventana", "ventana");
  if (c.enviadosHoy >= c.maxPorDia) return esperar("tope_diario", "dia_siguiente");
  if (!c.whatsappListo) return esperar("whatsapp_no_configurado", { minutos: 60 });
  if (!c.plantillaDisponible) return esperar("plantilla_no_disponible", { minutos: 60 });

  if (vencido) return { accion: "omitir", motivo: "fuera_de_vigencia" };
  return { accion: "enviar" };
}

/** Normaliza un texto entrante para detectar una petición de baja ("BAJA", "Stop.", "no más"). */
export function normalizarTexto(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PALABRAS_BAJA = new Set(["baja", "stop", "alto", "cancelar", "no mas", "ya no", "no quiero mas mensajes", "no me escriban", "dejen de escribirme"]);

/** ¿El mensaje es una petición clara de dejar de recibir mensajes? Solo coincidencias exactas: no se adivina. */
export function esPeticionDeBaja(texto: string): boolean {
  return PALABRAS_BAJA.has(normalizarTexto(texto));
}
