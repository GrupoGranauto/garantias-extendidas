import { describe, expect, it } from "vitest";
import { calcularEtapaVehiculo, mesesTranscurridos, validarEtapas, type EtapaCiclo } from "../lib/cicloVehiculoLogica.js";

/** Ejemplo: etapa 1 = meses 0 a 12 y hasta 15,000 km; etapa 2 = meses 13 a 36 y hasta 45,000 km. */
const ETAPAS: EtapaCiclo[] = [
  { id: "e1", orden: 1, nombre: "Etapa 1", meses_desde: 0, meses_hasta: 12, km_max: 15000 },
  { id: "e2", orden: 2, nombre: "Etapa 2", meses_desde: 13, meses_hasta: 36, km_max: 45000 },
];
const HOY = "2026-10-03";

describe("mesesTranscurridos", () => {
  it("cuenta meses completos", () => {
    expect(mesesTranscurridos("2026-05-04", HOY)).toBe(4); // le falta un día para el quinto mes
    expect(mesesTranscurridos("2026-05-03", HOY)).toBe(5);
    expect(mesesTranscurridos("2025-10-03", HOY)).toBe(12);
    expect(mesesTranscurridos("2024-06-30", HOY)).toBe(27);
  });
  it("una fecha futura cuenta como 0", () => {
    expect(mesesTranscurridos("2026-12-01", HOY)).toBe(0);
  });
});

describe("calcularEtapaVehiculo", () => {
  it("por fecha, sin kilometraje", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2026-05-03", km: null, hoy: HOY })).toEqual({ etapaId: "e1", motivo: "fecha" });
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2025-01-10", km: null, hoy: HOY })).toEqual({ etapaId: "e2", motivo: "fecha" });
  });

  it("con kilometraje, manda el kilometraje (primer parámetro)", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2026-05-03", km: 9000, hoy: HOY })).toEqual({ etapaId: "e1", motivo: "km" });
  });

  it("km por encima de la etapa 1 aunque la fecha siga en la etapa 1: pasa a la etapa 2 por km", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2026-05-03", km: 20000, hoy: HOY })).toEqual({ etapaId: "e2", motivo: "km" });
  });

  it("km por encima de la etapa 2 aunque la fecha siga en la etapa 2: excluido por km", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2025-01-10", km: 60000, hoy: HOY })).toEqual({ etapaId: null, motivo: "excluido_km" });
  });

  it("km por encima de la última etapa excluye aunque la fecha sea reciente", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2026-09-01", km: 99999, hoy: HOY })).toEqual({ etapaId: null, motivo: "excluido_km" });
  });

  it("km bajo en un auto con más meses: manda el km", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2025-01-10", km: 5000, hoy: HOY })).toEqual({ etapaId: "e1", motivo: "km" });
  });

  it("el máximo de km es inclusivo", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2026-05-03", km: 15000, hoy: HOY })).toEqual({ etapaId: "e1", motivo: "km" });
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2026-05-03", km: 15001, hoy: HOY })).toEqual({ etapaId: "e2", motivo: "km" });
  });

  it("fecha posterior a la última etapa: excluido por fecha", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2022-01-01", km: null, hoy: HOY })).toEqual({ etapaId: null, motivo: "excluido_fecha" });
    // y un km bajo no lo rescata
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: "2022-01-01", km: 1000, hoy: HOY })).toEqual({ etapaId: null, motivo: "excluido_fecha" });
  });

  it("sin fecha, el kilometraje decide solo; sin ninguno de los dos, sin datos", () => {
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: null, km: 30000, hoy: HOY })).toEqual({ etapaId: "e2", motivo: "km" });
    expect(calcularEtapaVehiculo({ etapas: ETAPAS, fecha: null, km: null, hoy: HOY })).toEqual({ etapaId: null, motivo: "sin_datos" });
  });

  it("sin etapas configuradas", () => {
    expect(calcularEtapaVehiculo({ etapas: [], fecha: "2026-05-03", km: 1000, hoy: HOY })).toEqual({ etapaId: null, motivo: "sin_configurar" });
  });

  it("antes de la primera etapa: aún no entra", () => {
    const e: EtapaCiclo[] = [{ id: "a", orden: 1, nombre: "A", meses_desde: 3, meses_hasta: 12, km_max: 20000 }];
    expect(calcularEtapaVehiculo({ etapas: e, fecha: "2026-09-20", km: null, hoy: HOY })).toEqual({ etapaId: null, motivo: "aun_no" });
  });
});

describe("validarEtapas", () => {
  const ok = [
    { nombre: "Etapa 1", meses_desde: 0, meses_hasta: 12, km_max: 15000 },
    { nombre: "Etapa 2", meses_desde: 13, meses_hasta: 36, km_max: 45000 },
  ];
  it("acepta una definición correcta", () => {
    expect(validarEtapas(ok)).toBeNull();
  });
  it("rechaza vacío, nombres repetidos y rangos al revés", () => {
    expect(validarEtapas([])).not.toBeNull();
    expect(validarEtapas([ok[0], { ...ok[1], nombre: "etapa 1" }])).toMatch(/dos etapas/);
    expect(validarEtapas([{ ...ok[0], meses_desde: 10, meses_hasta: 5 }])).not.toBeNull();
  });
  it("rechaza huecos, traslapes y km que no crece", () => {
    expect(validarEtapas([ok[0], { ...ok[1], meses_desde: 15 }])).toMatch(/justo después/);
    expect(validarEtapas([ok[0], { ...ok[1], meses_desde: 12 }])).toMatch(/justo después/);
    expect(validarEtapas([ok[0], { ...ok[1], km_max: 15000 }])).toMatch(/mayor/);
  });
});
