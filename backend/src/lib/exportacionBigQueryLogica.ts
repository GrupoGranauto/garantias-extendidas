import { aMinutos } from "./campanasLogica.js";

/**
 * Envío nocturno de la web a BigQuery (contrato versión 1; diseño en Notion: «Envío nocturno de la web a BigQuery:
 * contrato y cambios a la base maestra»). Cada noche la web manda lo que la base maestra necesita para dejar de listar
 * lo que ya se resolvió en la web: ventas del BDC, descartes del vehículo, bajas y números equivocados. La web solo agrega
 * filas (nunca borra ni actualiza); cada envío lleva su run_id y termina con su fila en ge_web_envios, así que un envío
 * sin esa fila quedó incompleto y la base maestra no lo usa.
 */

export const VERSION_CONTRATO = 1;

const DATASET_ENVIO = "base-maestra-gn.app_ge";
export const TABLAS_ENVIO = {
  envios: `${DATASET_ENVIO}.ge_web_envios`,
  vin: `${DATASET_ENVIO}.ge_web_feedback_vin`,
  supresiones: `${DATASET_ENVIO}.ge_web_supresiones`,
} as const;

/**
 * Ventana del envío (hora de Hermosillo): sale a las 02:00 y, si falla, se reintenta hasta las 07:30, una hora antes de
 * que la base maestra se rehaga (08:30).
 */
export const VENTANA_EXPORTACION = { desde: "02:00", hasta: "07:30" } as const;

export function enVentanaExportacion(minutos: number): boolean {
  return minutos >= aMinutos(VENTANA_EXPORTACION.desde) && minutos < aMinutos(VENTANA_EXPORTACION.hasta);
}

/** Un lead (un VIN) tal como se lee de la base de la web para el envío. */
export type LeadParaEnvio = {
  sucursal: string;
  vin: string;
  campana: string | null;
  estado_cartera: string | null;
  /** abierta | ganada | perdida */
  estado_lead: string;
  etapa: string | null;
  resultado_bdc: string | null;
  estado_contacto: string | null;
  motivo_perdida: string | null;
  ejecutivo: string | null;
  fecha_ultimo_contacto: string | null;
  ultimo_contacto_efectivo_en: string | null;
  /** Fecha de pago, fecha de compra o contrato pagado (misma regla que «pagado» en el freno de envíos). */
  pagado: boolean;
  /** Tiene un contrato cancelado y ninguno pagado. */
  contrato_cancelado: boolean;
  /** Fecha de la venta: compra, pago o el día en que el lead quedó en Vendido. */
  fecha_venta: string | null;
  declara_ge: boolean | null;
  conserva_auto: boolean | null;
  /** Descarte vigente del vehículo (motivo), o null. */
  descarte_vin: string | null;
  /** Bloqueo vigente del teléfono del lead: baja o numero_equivocado (la baja primero), o null. */
  bloqueo_telefono: string | null;
};

export type SupresionParaEnvio = {
  sucursal: string;
  alcance: string;
  valor: string;
  motivo: string;
  canal: string | null;
  vigente: boolean;
  creada_en: string;
  liberada_en: string | null;
  motivo_liberacion: string | null;
};

export type FilaFeedbackVin = Omit<LeadParaEnvio, "pagado" | "contrato_cancelado" | "fecha_venta"> & {
  run_id: string;
  corte: string;
  venta_bdc: boolean;
  venta_bdc_pagada: boolean;
  fecha_venta_bdc: string | null;
};

export type FilaSupresion = SupresionParaEnvio & { run_id: string; corte: string };

/**
 * Venta del BDC: el lead está en Vendido o tiene pago o compra capturados, y no tiene un contrato cancelado sin otro
 * pagado. Es lo que la base maestra marca VENDIDA_BDC (cuenta para el BDC aunque después el sistema de ventas la registre).
 */
export function esVentaBdc(l: Pick<LeadParaEnvio, "estado_lead" | "pagado" | "contrato_cancelado">): boolean {
  return (l.estado_lead === "ganada" || l.pagado) && !l.contrato_cancelado;
}

export function filaFeedbackVin(l: LeadParaEnvio, runId: string, corte: string): FilaFeedbackVin {
  const { pagado, contrato_cancelado, fecha_venta, ...resto } = l;
  const venta = esVentaBdc(l);
  return {
    run_id: runId,
    corte,
    ...resto,
    vin: l.vin.trim().toUpperCase(),
    venta_bdc: venta,
    venta_bdc_pagada: venta && pagado,
    fecha_venta_bdc: venta ? fecha_venta : null,
  };
}

export function filaSupresion(s: SupresionParaEnvio, runId: string, corte: string): FilaSupresion {
  return { run_id: runId, corte, ...s };
}

export type ConteoEnvio = { filasVin: number; filasSupresiones: number };

/**
 * Freno antes de enviar, contra el último envío completo. Las supresiones nunca se borran en la web (una liberada viaja
 * como no vigente), así que su número no puede bajar; los VIN tampoco deberían caer de golpe. Si pasa, algo se leyó mal
 * y no se envía: la base maestra sigue con el envío anterior y la web sigue frenando en tiempo real.
 */
export function problemaContraAnterior(actual: ConteoEnvio, anterior: ConteoEnvio | null): string | null {
  if (!anterior) return null;
  if (actual.filasSupresiones < anterior.filasSupresiones) {
    return `Las supresiones bajaron de ${anterior.filasSupresiones} a ${actual.filasSupresiones}; no se envía.`;
  }
  if (actual.filasVin < Math.floor(anterior.filasVin * 0.9)) {
    return `Los VIN cayeron más de 10 % (de ${anterior.filasVin} a ${actual.filasVin}); no se envía.`;
  }
  return null;
}

/** Conteos para la bitácora del servidor (solo números, nunca datos de clientes). */
export function resumirEnvio(vin: FilaFeedbackVin[], supresiones: FilaSupresion[]) {
  const vigentes = supresiones.filter((s) => s.vigente);
  return {
    filasVin: vin.length,
    filasSupresiones: supresiones.length,
    ventasBdc: vin.filter((f) => f.venta_bdc).length,
    descartesVigentes: vigentes.filter((s) => s.alcance === "vin").length,
    bloqueosTelefonoVigentes: vigentes.filter((s) => s.alcance === "telefono").length,
  };
}
