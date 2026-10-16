import { describe, expect, it } from "vitest";
import {
  enVentanaExportacion,
  esVentaBdc,
  filaFeedbackVin,
  filaSupresion,
  problemaContraAnterior,
  resumirEnvio,
  type LeadParaEnvio,
  type SupresionParaEnvio,
} from "../lib/exportacionBigQueryLogica.js";

/** Lead sintético; cada prueba cambia solo lo que le importa. */
const lead = (extra: Partial<LeadParaEnvio> = {}): LeadParaEnvio => ({
  sucursal: "granauto",
  vin: " jn8at3mt1tw000001 ",
  campana: "5M",
  estado_cartera: "ACTIVA",
  estado_lead: "abierta",
  etapa: "Por contactar",
  resultado_bdc: null,
  estado_contacto: "sin_intentar",
  motivo_perdida: null,
  ejecutivo: "Ejecutivo Prueba",
  fecha_ultimo_contacto: null,
  ultimo_contacto_efectivo_en: null,
  pagado: false,
  contrato_cancelado: false,
  fecha_venta: null,
  declara_ge: null,
  conserva_auto: null,
  descarte_vin: null,
  bloqueo_telefono: null,
  ...extra,
});

const supresion = (extra: Partial<SupresionParaEnvio> = {}): SupresionParaEnvio => ({
  sucursal: "granauto",
  alcance: "telefono",
  valor: "6620000001",
  motivo: "baja",
  canal: "whatsapp",
  vigente: true,
  creada_en: "2026-10-15T18:00:00.000Z",
  liberada_en: null,
  motivo_liberacion: null,
  ...extra,
});

const CORTE = "2026-10-17T09:00:00.000Z";

describe("venta del BDC", () => {
  it("cuenta el Vendido y el pago o compra capturados, aunque el lead no esté en Vendido", () => {
    expect(esVentaBdc(lead({ estado_lead: "ganada" }))).toBe(true);
    expect(esVentaBdc(lead({ pagado: true }))).toBe(true);
    expect(esVentaBdc(lead())).toBe(false);
    expect(esVentaBdc(lead({ estado_lead: "perdida" }))).toBe(false);
  });
  it("un contrato cancelado (sin otro pagado) deja de contar como venta", () => {
    expect(esVentaBdc(lead({ estado_lead: "ganada", contrato_cancelado: true }))).toBe(false);
    expect(esVentaBdc(lead({ pagado: true, contrato_cancelado: true }))).toBe(false);
  });
});

describe("fila por VIN", () => {
  it("normaliza el VIN y lleva la corrida y el corte", () => {
    const f = filaFeedbackVin(lead(), "run-1", CORTE);
    expect(f).toMatchObject({ run_id: "run-1", corte: CORTE, vin: "JN8AT3MT1TW000001", venta_bdc: false, venta_bdc_pagada: false, fecha_venta_bdc: null });
  });
  it("la fecha de venta solo va si es venta del BDC; «pagada» separa el Vendido sin pago", () => {
    const vendidoSinPago = filaFeedbackVin(lead({ estado_lead: "ganada", fecha_venta: "2026-10-10" }), "r", CORTE);
    expect(vendidoSinPago).toMatchObject({ venta_bdc: true, venta_bdc_pagada: false, fecha_venta_bdc: "2026-10-10" });
    const pagado = filaFeedbackVin(lead({ pagado: true, fecha_venta: "2026-10-12" }), "r", CORTE);
    expect(pagado).toMatchObject({ venta_bdc: true, venta_bdc_pagada: true, fecha_venta_bdc: "2026-10-12" });
    const cancelado = filaFeedbackVin(lead({ pagado: true, contrato_cancelado: true, fecha_venta: "2026-10-12" }), "r", CORTE);
    expect(cancelado).toMatchObject({ venta_bdc: false, venta_bdc_pagada: false, fecha_venta_bdc: null });
  });
  it("tiene exactamente las columnas de la tabla ge_web_feedback_vin (contrato v1)", () => {
    expect(Object.keys(filaFeedbackVin(lead(), "r", CORTE)).sort()).toEqual(
      [
        "run_id", "corte", "sucursal", "vin", "campana", "estado_cartera", "estado_lead", "etapa", "resultado_bdc",
        "estado_contacto", "motivo_perdida", "ejecutivo", "fecha_ultimo_contacto", "ultimo_contacto_efectivo_en",
        "venta_bdc", "venta_bdc_pagada", "fecha_venta_bdc", "declara_ge", "conserva_auto", "descarte_vin", "bloqueo_telefono",
      ].sort(),
    );
  });
});

describe("fila de supresión", () => {
  it("tiene exactamente las columnas de la tabla ge_web_supresiones (contrato v1)", () => {
    expect(Object.keys(filaSupresion(supresion(), "r", CORTE)).sort()).toEqual(
      ["run_id", "corte", "sucursal", "alcance", "valor", "motivo", "canal", "vigente", "creada_en", "liberada_en", "motivo_liberacion"].sort(),
    );
  });
});

describe("freno contra el envío anterior", () => {
  it("sin envío anterior no hay con qué comparar", () => {
    expect(problemaContraAnterior({ filasVin: 10, filasSupresiones: 0 }, null)).toBeNull();
  });
  it("las supresiones nunca bajan (una liberada viaja como no vigente)", () => {
    expect(problemaContraAnterior({ filasVin: 1800, filasSupresiones: 9 }, { filasVin: 1800, filasSupresiones: 10 })).toMatch(/supresiones bajaron/);
    expect(problemaContraAnterior({ filasVin: 1800, filasSupresiones: 10 }, { filasVin: 1800, filasSupresiones: 10 })).toBeNull();
  });
  it("los VIN no caen más de 10 %", () => {
    expect(problemaContraAnterior({ filasVin: 1619, filasSupresiones: 10 }, { filasVin: 1800, filasSupresiones: 10 })).toMatch(/más de 10 %/);
    expect(problemaContraAnterior({ filasVin: 1620, filasSupresiones: 10 }, { filasVin: 1800, filasSupresiones: 10 })).toBeNull();
  });
});

describe("ventana del envío", () => {
  it("sale desde las 02:00 y reintenta hasta antes de las 07:30", () => {
    const m = (h: number, mm: number) => h * 60 + mm;
    expect(enVentanaExportacion(m(1, 59))).toBe(false);
    expect(enVentanaExportacion(m(2, 0))).toBe(true);
    expect(enVentanaExportacion(m(7, 29))).toBe(true);
    expect(enVentanaExportacion(m(7, 30))).toBe(false);
  });
});

describe("resumen para la bitácora", () => {
  it("cuenta ventas del BDC y supresiones vigentes por alcance (solo números)", () => {
    const vin = [filaFeedbackVin(lead({ estado_lead: "ganada" }), "r", CORTE), filaFeedbackVin(lead(), "r", CORTE)];
    const sup = [
      filaSupresion(supresion(), "r", CORTE),
      filaSupresion(supresion({ alcance: "vin", valor: "JN8AT3MT1TW000001", motivo: "flotilla" }), "r", CORTE),
      filaSupresion(supresion({ vigente: false, liberada_en: CORTE }), "r", CORTE),
    ];
    expect(resumirEnvio(vin, sup)).toEqual({ filasVin: 2, filasSupresiones: 3, ventasBdc: 1, descartesVigentes: 1, bloqueosTelefonoVigentes: 1 });
  });
});
