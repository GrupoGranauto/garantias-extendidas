/**
 * Etapa del vehículo: en qué punto de su vida está un vehículo vendido, según los meses transcurridos desde una
 * fecha (por omisión la de factura) y el kilometraje que captura el ejecutivo. Funciones puras, sin base de datos.
 *
 * Reglas:
 *  - La fecha da la etapa: la que contenga los meses transcurridos.
 *  - El kilometraje manda cuando se pasa: si el km excede el máximo de la etapa que marca la fecha, el vehículo
 *    sube a la primera etapa cuyo km máximo lo cubra; si excede el de la última etapa, queda EXCLUIDO.
 *  - Un km menor al de la etapa que marca la fecha no la cambia (la fecha manda).
 *  - Una fecha posterior a la última etapa excluye al vehículo; una anterior a la primera, "aún no entra".
 */

export type EtapaCiclo = {
  id: string;
  orden: number;
  nombre: string;
  meses_desde: number;
  meses_hasta: number;
  km_max: number;
};

export type MotivoEtapa = "fecha" | "km" | "excluido_km" | "excluido_fecha" | "aun_no" | "sin_datos" | "sin_configurar";

export type ResultadoEtapa = { etapaId: string | null; motivo: MotivoEtapa };

/** Meses completos entre dos fechas 'YYYY-MM-DD'. Una fecha futura cuenta como 0. */
export function mesesTranscurridos(fecha: string, hoy: string): number {
  const [a1, m1, d1] = fecha.split("-").map(Number);
  const [a2, m2, d2] = hoy.split("-").map(Number);
  const meses = (a2 - a1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  return Math.max(0, meses);
}

export function calcularEtapaVehiculo(p: {
  etapas: EtapaCiclo[];
  /** Fecha de la columna elegida, 'YYYY-MM-DD', o null si no la tiene. */
  fecha: string | null;
  /** Kilometraje capturado, o null si aún no se sabe. */
  km: number | null;
  hoy: string;
}): ResultadoEtapa {
  const etapas = [...p.etapas].sort((a, b) => a.orden - b.orden);
  if (etapas.length === 0) return { etapaId: null, motivo: "sin_configurar" };
  if (p.fecha === null && p.km === null) return { etapaId: null, motivo: "sin_datos" };

  // Por kilometraje: la primera etapa cuyo máximo lo cubre; si ninguna, está por encima de todas.
  let etapaKm: EtapaCiclo | null = null;
  if (p.km !== null) {
    etapaKm = etapas.find((e) => p.km! <= e.km_max) ?? null;
    if (!etapaKm) return { etapaId: null, motivo: "excluido_km" };
  }

  // Sin fecha, el kilometraje decide solo.
  if (p.fecha === null) return { etapaId: etapaKm!.id, motivo: "km" };

  const edad = mesesTranscurridos(p.fecha, p.hoy);
  const primera = etapas[0];
  const ultima = etapas[etapas.length - 1];
  if (edad < primera.meses_desde) return { etapaId: null, motivo: "aun_no" };
  if (edad > ultima.meses_hasta) return { etapaId: null, motivo: "excluido_fecha" };

  const etapaFecha = etapas.find((e) => edad >= e.meses_desde && edad <= e.meses_hasta) ?? ultima;
  if (etapaKm && etapaKm.orden > etapaFecha.orden) return { etapaId: etapaKm.id, motivo: "km" };
  return { etapaId: etapaFecha.id, motivo: "fecha" };
}

export type EtapaEntrada = { nombre: string; meses_desde: number; meses_hasta: number; km_max: number };

/**
 * Revisa la definición de etapas: nombres distintos, meses seguidos y sin huecos (cada etapa empieza un mes
 * después de que termina la anterior) y kilometraje máximo creciente. Devuelve el texto del error, o null.
 */
export function validarEtapas(etapas: EtapaEntrada[]): string | null {
  if (etapas.length === 0) return "Define al menos una etapa.";
  const nombres = new Set<string>();
  for (const [i, e] of etapas.entries()) {
    const n = e.nombre.trim().toLowerCase();
    if (!n) return `La etapa ${i + 1} necesita un nombre.`;
    if (nombres.has(n)) return `Hay dos etapas llamadas «${e.nombre.trim()}».`;
    nombres.add(n);
    if (e.meses_hasta < e.meses_desde) return `En «${e.nombre}», el mes final no puede ser menor al inicial.`;
    if (i > 0) {
      const prev = etapas[i - 1];
      if (e.meses_desde !== prev.meses_hasta + 1) {
        return `«${e.nombre}» debe empezar en el mes ${prev.meses_hasta + 1}, justo después de «${prev.nombre}» (sin huecos ni traslapes).`;
      }
      if (e.km_max <= prev.km_max) return `El kilometraje máximo de «${e.nombre}» debe ser mayor al de «${prev.nombre}».`;
    }
  }
  return null;
}
