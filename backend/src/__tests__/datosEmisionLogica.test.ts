import { describe, expect, it } from "vitest";
import { evaluarCompletitud, normalizarDatosEmision, type BaseEmision } from "../lib/datosEmisionLogica.js";

const base: BaseEmision = {
  vin: "JN8AT3MT1TW067049",
  modelo: "Xtrail",
  version: "Advance",
  ano_modelo: 2026,
  fecha_factura: "2026-04-30",
  kilometraje: 8000,
  correo: "cliente@correo.com",
  numero_factura: "A-1234",
  valor_factura: 520000,
  numero_motor: "QR25DE123456",
  estado_circulacion: "Sonora",
  direccion: "Calle 1 #2, Navojoa, Sonora",
};

describe("normalizarDatosEmision", () => {
  it("limpia espacios y pone mayúsculas en factura y motor", () => {
    const r = normalizarDatosEmision({ numero_factura: "  a-12  34 ", numero_motor: " qr25 de-99 " });
    expect(r).toEqual({ datos: { numero_factura: "A-12 34", numero_motor: "QR25DE-99" } });
  });

  it("acepta el valor con signo de pesos y comas", () => {
    expect(normalizarDatosEmision({ valor_factura: "$385,000.50" })).toEqual({ datos: { valor_factura: 385000.5 } });
    expect(normalizarDatosEmision({ valor_factura: 385000 })).toEqual({ datos: { valor_factura: 385000 } });
  });

  it("rechaza montos inválidos", () => {
    for (const v of ["abc", "0", "-5", "12.345", "100000000", "1e6"]) {
      expect("error" in normalizarDatosEmision({ valor_factura: v }), v).toBe(true);
    }
  });

  it("un texto vacío borra el dato", () => {
    expect(normalizarDatosEmision({ numero_factura: "", valor_factura: "  ", numero_motor: null, direccion: "", estado_circulacion: " " })).toEqual({
      datos: { numero_factura: null, valor_factura: null, numero_motor: null, direccion: null, estado_circulacion: null },
    });
  });

  it("solo toca los campos que vienen", () => {
    expect(normalizarDatosEmision({ direccion: "Calle 5" })).toEqual({ datos: { direccion: "Calle 5" } });
    expect(normalizarDatosEmision({})).toEqual({ datos: {} });
  });

  it("rechaza caracteres raros y textos largos", () => {
    expect("error" in normalizarDatosEmision({ numero_motor: "QR25;DROP" })).toBe(true);
    expect("error" in normalizarDatosEmision({ numero_factura: "A<script>" })).toBe(true);
    expect("error" in normalizarDatosEmision({ numero_motor: "A".repeat(31) })).toBe(true);
    expect("error" in normalizarDatosEmision({ direccion: "x".repeat(301) })).toBe(true);
    expect("error" in normalizarDatosEmision({ estado_circulacion: "x".repeat(61) })).toBe(true);
  });
});

describe("evaluarCompletitud", () => {
  it("verde cuando está todo y cumple los requisitos", () => {
    const c = evaluarCompletitud(base, "2026-10-05");
    expect(c.semaforo).toBe("verde");
    expect(c.faltan).toEqual([]);
    expect(c.bloqueos).toEqual([]);
    expect(c.completos).toBe(c.total);
  });

  it("ámbar cuando faltan datos, y dice cuáles", () => {
    const c = evaluarCompletitud({ ...base, numero_motor: null, direccion: "  ", valor_factura: null }, "2026-10-05");
    expect(c.semaforo).toBe("ambar");
    expect(c.faltan.map((f) => f.campo)).toEqual(["valor_factura", "numero_motor", "direccion"]);
    expect(c.faltan.every((f) => f.capturable)).toBe(true);
  });

  it("falta el km o el correo: ámbar, pero no capturable aquí", () => {
    const c = evaluarCompletitud({ ...base, kilometraje: null, correo: null }, "2026-10-05");
    expect(c.semaforo).toBe("ambar");
    expect(c.faltan.map((f) => [f.campo, f.capturable])).toEqual([["kilometraje", false], ["correo", false]]);
  });

  it("rojo si el km pasa de 59,000", () => {
    const c = evaluarCompletitud({ ...base, kilometraje: 59001 }, "2026-10-05");
    expect(c.semaforo).toBe("rojo");
    expect(c.bloqueos).toHaveLength(1);
    expect(evaluarCompletitud({ ...base, kilometraje: 59000 }, "2026-10-05").semaforo).toBe("verde");
  });

  it("rojo si la garantía original ya terminó (36 meses desde la factura)", () => {
    expect(evaluarCompletitud({ ...base, fecha_factura: "2023-10-05" }, "2026-10-05").semaforo).toBe("rojo");
    expect(evaluarCompletitud({ ...base, fecha_factura: "2023-10-06" }, "2026-10-05").semaforo).toBe("verde");
  });

  it("el rojo manda aunque falten datos", () => {
    const c = evaluarCompletitud({ ...base, kilometraje: 70000, numero_motor: null }, "2026-10-05");
    expect(c.semaforo).toBe("rojo");
    expect(c.faltan.map((f) => f.campo)).toEqual(["numero_motor"]);
  });
});
