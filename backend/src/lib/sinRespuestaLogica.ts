import { ETIQUETA_LLAMADA, type ResultadoLlamada } from "./gestionLogica.js";

/**
 * Mensaje automático por llamadas sin respuesta (pedido de Miguel Borbón, 16-oct-2026). Funciones puras, sin base de datos.
 *
 * Cuando a un lead se le registraron N llamadas en su campaña actual con alguno de los resultados elegidos (por omisión no
 * contesta, buzón, cuelga y ocupado), el motor le manda una sola vez, por paso de campaña, la plantilla configurada.
 */

/** Los resultados de llamada que se pueden contar, en el orden de la ficha. */
export const RESULTADOS_LLAMADA = Object.keys(ETIQUETA_LLAMADA) as ResultadoLlamada[];

/** Por omisión cuentan las llamadas en las que no se habló con nadie. */
export const RESULTADOS_POR_OMISION: ResultadoLlamada[] = ["NO_CONTESTA", "BUZON", "CUELGA", "OCUPADO"];

export const INTENTOS_POR_OMISION = 3;
export const INTENTOS_MAXIMOS = 20;

export type ConfigSinRespuesta = {
  activa: boolean;
  plantillaId: string | null;
  intentos: number;
  resultados: string[];
  telefonosPrueba: string[];
};

/** null si la configuración se puede guardar; si no, por qué. */
export function validarConfigSinRespuesta(cfg: ConfigSinRespuesta): string | null {
  if (!Number.isInteger(cfg.intentos) || cfg.intentos < 1 || cfg.intentos > INTENTOS_MAXIMOS) {
    return `El número de llamadas va de 1 a ${INTENTOS_MAXIMOS}.`;
  }
  if (cfg.resultados.length === 0) return "Elige al menos un resultado de llamada que cuente.";
  const validos = new Set<string>(RESULTADOS_LLAMADA);
  if (cfg.resultados.some((r) => !validos.has(r))) return "Hay un resultado de llamada que no existe.";
  if (cfg.resultados.includes("CONTESTA_TITULAR")) return "«Contesta el titular» no es una llamada sin respuesta.";
  if (cfg.activa && !cfg.plantillaId) return "Para encenderlo, elige la plantilla.";
  if (cfg.telefonosPrueba.some((t) => !/^\d{10}$/.test(t))) return "Los teléfonos de prueba van a 10 dígitos.";
  return null;
}

/**
 * Cómo va un lead hacia el mensaje: cuántas llamadas que cuentan lleva en su campaña actual y cuántas le faltan. `listo`
 * cuando ya llegó al número configurado.
 */
export function avanceSinRespuesta(contadas: number, intentos: number): { contadas: number; faltan: number; listo: boolean } {
  const faltan = Math.max(0, intentos - contadas);
  return { contadas, faltan, listo: faltan === 0 };
}
