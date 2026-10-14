import { aMinutos, deMinutos, diaSemana, sumarDias, type AhoraLocal } from "./campanasLogica.js";
import { VENTANA_MASIVOS } from "./masivosLogica.js";

/**
 * Primer mensaje automático por campaña, como funciones puras: cuándo le toca correr a una campaña, cuándo es el próximo
 * envío y cuándo se reintenta. El motor (primerMensaje.ts y masivos.ts) solo reúne los datos y ejecuta.
 */

export type ConfigPrimerMensaje = {
  activa: boolean;
  plantillaId: string | null;
  /** 1 = lunes … 7 = domingo. */
  diasSemana: number[];
  /** "HH:MM": a partir de esta hora sale ese día. */
  hora: string;
  /** Modo prueba: si tiene teléfonos (10 dígitos), solo se les manda a ellos. */
  telefonosPrueba: string[];
};

/** Si a esta hora la base de hoy todavía no se actualiza, sale con la que haya para no perder el día. */
export const HORA_SIN_BASE = "18:00";

/** Código de Meta del límite de mensajes de marketing por persona: el único fallo que se reintenta (una vez). */
export const CODIGO_LIMITE_MARKETING = 131049;

export type Espera = "apagada" | "ya_corrio" | "dia" | "hora" | "horario" | "base";

/** Si hoy, a esta hora, le toca armar el masivo del primer mensaje; si no, qué está esperando. */
export function tocaCorrer(
  cfg: ConfigPrimerMensaje,
  ahora: AhoraLocal,
  estado: { yaCorrioHoy: boolean; baseActualizadaHoy: boolean },
): { toca: true } | { toca: false; espera: Espera } {
  if (!cfg.activa || !cfg.plantillaId || cfg.diasSemana.length === 0) return { toca: false, espera: "apagada" };
  if (estado.yaCorrioHoy) return { toca: false, espera: "ya_corrio" };
  if (!cfg.diasSemana.includes(diaSemana(ahora.fecha))) return { toca: false, espera: "dia" };
  if (ahora.minutos < aMinutos(cfg.hora)) return { toca: false, espera: "hora" };
  if (ahora.minutos >= aMinutos(VENTANA_MASIVOS.hora_fin)) return { toca: false, espera: "horario" };
  if (!estado.baseActualizadaHoy && ahora.minutos < aMinutos(HORA_SIN_BASE)) return { toca: false, espera: "base" };
  return { toca: true };
}

/**
 * Cuándo sale el siguiente (fecha y hora de Hermosillo): hoy a la hora configurada si todavía no corre, o el siguiente
 * día permitido. null si está apagada. Si hoy ya pasó la hora pero aún no corre (esperando la base), es hoy.
 */
export function proximoEnvio(cfg: ConfigPrimerMensaje, ahora: AhoraLocal, yaCorrioHoy: boolean): { fecha: string; hora: string } | null {
  if (!cfg.activa || !cfg.plantillaId || cfg.diasSemana.length === 0) return null;
  const hora = deMinutos(aMinutos(cfg.hora));
  const hoyPermitido = cfg.diasSemana.includes(diaSemana(ahora.fecha));
  if (hoyPermitido && !yaCorrioHoy && ahora.minutos < aMinutos(VENTANA_MASIVOS.hora_fin)) {
    return { fecha: ahora.fecha, hora: ahora.minutos > aMinutos(cfg.hora) ? deMinutos(ahora.minutos) : hora };
  }
  let f = sumarDias(ahora.fecha, 1);
  for (let i = 0; i < 7; i++) {
    if (cfg.diasSemana.includes(diaSemana(f))) return { fecha: f, hora };
    f = sumarDias(f, 1);
  }
  return null;
}

/**
 * Si un paso cuyo primer mensaje ya se intentó puede recibir un segundo intento hoy: solo si el primero no se entregó por el
 * límite de marketing de Meta, y no fue hoy mismo (Meta pide esperar).
 */
export function puedeReintentar(primero: { estado: string; errorCodigo: number | null; fecha: string }, hoy: string): boolean {
  return primero.estado === "fallido" && primero.errorCodigo === CODIGO_LIMITE_MARKETING && primero.fecha < hoy;
}

/** Lo que se guarda tiene que tener sentido; devuelve el error en palabras, o null si está bien. */
export function validarConfig(cfg: ConfigPrimerMensaje): string | null {
  if (!/^\d{2}:\d{2}$/.test(cfg.hora)) return "La hora no es válida.";
  const min = aMinutos(cfg.hora);
  if (min < aMinutos(VENTANA_MASIVOS.hora_inicio) || min >= aMinutos(VENTANA_MASIVOS.hora_fin)) {
    return `La hora tiene que estar entre las ${VENTANA_MASIVOS.hora_inicio} y antes de las ${VENTANA_MASIVOS.hora_fin}.`;
  }
  if (cfg.diasSemana.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return "Algún día de la semana no es válido.";
  if (cfg.activa && cfg.diasSemana.length === 0) return "Elige al menos un día de la semana.";
  if (cfg.activa && !cfg.plantillaId) return "Elige la plantilla del primer mensaje.";
  if (cfg.telefonosPrueba.some((t) => !/^\d{10}$/.test(t))) return "Los teléfonos de prueba van a 10 dígitos.";
  return null;
}
