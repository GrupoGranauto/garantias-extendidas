/**
 * Mensaje automático de seguimiento para leads en «Contactado» (pedido de Miguel Borbón, 19-oct-2026). Funciones puras,
 * sin base de datos.
 *
 * Cuando el lead sigue en «Contactado» y pasó el tiempo configurado desde su última interacción (la última llamada
 * registrada o el último mensaje de WhatsApp de su conversación, con el mismo peso), el motor le manda una sola vez, por paso
 * de campaña, la plantilla de seguimiento elegida.
 */

export const ESPERA_POR_OMISION_HORAS = 48;
export const ESPERA_MAXIMA_HORAS = 720;

export type ConfigSeguimiento = {
  activa: boolean;
  plantillaId: string | null;
  esperaHoras: number;
  telefonosPrueba: string[];
};

/** null si la configuración se puede guardar; si no, por qué. */
export function validarConfigSeguimiento(cfg: ConfigSeguimiento): string | null {
  if (!Number.isInteger(cfg.esperaHoras) || cfg.esperaHoras < 1 || cfg.esperaHoras > ESPERA_MAXIMA_HORAS) {
    return `El tiempo de espera va de 1 hora a ${ESPERA_MAXIMA_HORAS / 24} días.`;
  }
  if (cfg.activa && !cfg.plantillaId) return "Para encenderlo, elige la plantilla.";
  if (cfg.telefonosPrueba.some((t) => !/^\d{10}$/.test(t))) return "Los teléfonos de prueba van a 10 dígitos.";
  return null;
}

/**
 * Cuándo le toca el seguimiento a un lead: su última interacción más la espera. null si no tiene ninguna interacción
 * registrada (sin llamada ni mensaje no hay de dónde contar).
 */
export function cuandoTocaSeguimiento(ultimaLlamada: Date | null, ultimoMensaje: Date | null, esperaHoras: number): Date | null {
  const ultima = [ultimaLlamada, ultimoMensaje].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0];
  return ultima ? new Date(ultima.getTime() + esperaHoras * 3_600_000) : null;
}
