import { describe, expect, it } from "vitest";
import {
  coberturaYaInicio,
  entradaAlEstado,
  inicioDeCobertura,
  sumarMesesFecha,
  validarReglaContrato,
  validarReglasContrato,
  type ReglaContratoEntrada,
} from "../lib/contratoLogica.js";

describe("entradaAlEstado", () => {
  const ev = (estado: string, en: string) => ({ estado, en });
  it("la hora en que entró al estado actual", () => {
    expect(entradaAlEstado([ev("cotizado", "2026-10-01T10:00:00Z"), ev("orden_pago", "2026-10-02T15:00:00Z")], "orden_pago", null)).toBe("2026-10-02T15:00:00.000Z");
  });
  it("guardar de nuevo el mismo estado no reinicia el reloj", () => {
    const eventos = [ev("cotizado", "2026-10-01T10:00:00Z"), ev("orden_pago", "2026-10-02T15:00:00Z"), ev("orden_pago", "2026-10-02T18:30:00Z")];
    expect(entradaAlEstado(eventos, "orden_pago", null)).toBe("2026-10-02T15:00:00.000Z");
  });
  it("salir del estado y volver a entrar sí empieza otra vez", () => {
    const eventos = [ev("orden_pago", "2026-10-02T15:00:00Z"), ev("cotizado", "2026-10-03T10:00:00Z"), ev("orden_pago", "2026-10-04T09:00:00Z")];
    expect(entradaAlEstado(eventos, "orden_pago", null)).toBe("2026-10-04T09:00:00.000Z");
  });
  it("si todos los eventos son del mismo estado, cuenta desde el primero", () => {
    expect(entradaAlEstado([ev("orden_pago", "2026-10-02T15:00:00Z"), ev("orden_pago", "2026-10-03T15:00:00Z")], "orden_pago", null)).toBe("2026-10-02T15:00:00.000Z");
  });
  it("sin eventos usa el respaldo; sin nada, null", () => {
    expect(entradaAlEstado([], "orden_pago", "2026-10-05T12:00:00Z")).toBe("2026-10-05T12:00:00.000Z");
    expect(entradaAlEstado([], "orden_pago", null)).toBeNull();
  });
  it("tolera eventos mal formados", () => {
    expect(entradaAlEstado([{ estado: "orden_pago" }, null as any], "orden_pago", "2026-10-05T12:00:00Z")).toBe("2026-10-05T12:00:00.000Z");
    expect(entradaAlEstado(null as any, "orden_pago", null)).toBeNull();
  });
});

describe("inicio de la cobertura (36 meses después de la factura)", () => {
  it("suma 36 meses exactos", () => {
    expect(inicioDeCobertura("2026-08-10")).toBe("2029-08-10"); // el ejemplo del portal de Assurant
    expect(inicioDeCobertura("2023-10-05")).toBe("2026-10-05");
  });
  it("no se pasa del fin de mes", () => {
    expect(sumarMesesFecha("2026-01-31", 1)).toBe("2026-02-28");
    expect(sumarMesesFecha("2027-01-31", 1)).toBe("2027-02-28");
    expect(sumarMesesFecha("2028-01-31", 1)).toBe("2028-02-29");
    expect(inicioDeCobertura("2024-02-29")).toBe("2027-02-28");
  });
  it("cruza años", () => {
    expect(sumarMesesFecha("2026-11-15", 3)).toBe("2027-02-15");
    expect(sumarMesesFecha("2026-12-31", 12)).toBe("2027-12-31");
  });
  it("la cobertura ya inició el mismo día en que se cumplen los 36 meses, no antes", () => {
    expect(coberturaYaInicio("2023-10-05", "2026-10-05")).toBe(true);
    expect(coberturaYaInicio("2023-10-05", "2026-10-04")).toBe(false);
    expect(coberturaYaInicio("2023-10-05", "2027-01-01")).toBe(true);
  });
  it("sin fecha de factura válida nunca", () => {
    expect(coberturaYaInicio(null, "2030-01-01")).toBe(false);
    expect(coberturaYaInicio("hoy", "2030-01-01")).toBe(false);
  });
});

const regla: ReglaContratoEntrada = { nombre: "Liga por vencer", activa: false, estado: "orden_pago", espera_horas: 20, titulo: "Recontactar a {cliente}", descripcion: null, vence_horas: 2 };

describe("validación de reglas del contrato", () => {
  it("acepta una regla correcta", () => {
    expect(validarReglaContrato(regla)).toBeNull();
  });
  it("exige nombre, título, estado válido y espera dentro de rango", () => {
    expect(validarReglaContrato({ ...regla, nombre: " " })).toMatch(/nombre/);
    expect(validarReglaContrato({ ...regla, titulo: "" })).toMatch(/título/);
    expect(validarReglaContrato({ ...regla, estado: "cancelado" })).toMatch(/estado/);
    expect(validarReglaContrato({ ...regla, estado: "sin_contrato" })).toMatch(/estado/);
    expect(validarReglaContrato({ ...regla, espera_horas: -1 })).toMatch(/espera/);
    expect(validarReglaContrato({ ...regla, espera_horas: 9000 })).toMatch(/espera/);
    expect(validarReglaContrato({ ...regla, vence_horas: -5 })).toMatch(/vencimiento/);
  });
  it("una espera de 0 horas es válida (actúa en cuanto entra al estado)", () => {
    expect(validarReglaContrato({ ...regla, espera_horas: 0 })).toBeNull();
  });
  it("nombres repetidos y más de 20 reglas se rechazan", () => {
    expect(validarReglasContrato([regla, { ...regla, nombre: "liga por vencer" }])).toMatch(/dos reglas/);
    expect(validarReglasContrato(Array.from({ length: 21 }, (_, i) => ({ ...regla, nombre: `R${i}` })))).toMatch(/20/);
  });
});
