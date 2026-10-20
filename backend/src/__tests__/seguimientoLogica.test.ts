import { describe, expect, it } from "vitest";
import { cuandoTocaSeguimiento, validarConfigSeguimiento, type ConfigSeguimiento } from "../lib/seguimientoLogica.js";

const cfg = (extra: Partial<ConfigSeguimiento> = {}): ConfigSeguimiento => ({
  activa: true,
  plantillaId: "p1",
  esperaHoras: 48,
  telefonosPrueba: [],
  ...extra,
});

describe("configuración del seguimiento", () => {
  it("valida la espera, la plantilla y los teléfonos de prueba", () => {
    expect(validarConfigSeguimiento(cfg())).toBeNull();
    expect(validarConfigSeguimiento(cfg({ esperaHoras: 0 }))).toMatch(/1 hora a 30 días/);
    expect(validarConfigSeguimiento(cfg({ esperaHoras: 721 }))).toMatch(/1 hora a 30 días/);
    expect(validarConfigSeguimiento(cfg({ esperaHoras: 1.5 }))).toMatch(/1 hora/);
    expect(validarConfigSeguimiento(cfg({ plantillaId: null }))).toMatch(/plantilla/);
    expect(validarConfigSeguimiento(cfg({ activa: false, plantillaId: null }))).toBeNull();
    expect(validarConfigSeguimiento(cfg({ telefonosPrueba: ["662358"] }))).toMatch(/10 dígitos/);
  });
});

describe("cuándo toca el seguimiento", () => {
  const llamada = new Date("2026-10-19T16:00:00Z");
  const mensaje = new Date("2026-10-20T18:30:00Z");
  it("cuenta desde la última interacción, sea llamada o mensaje", () => {
    expect(cuandoTocaSeguimiento(llamada, mensaje, 24)?.toISOString()).toBe("2026-10-21T18:30:00.000Z");
    expect(cuandoTocaSeguimiento(mensaje, llamada, 24)?.toISOString()).toBe("2026-10-21T18:30:00.000Z");
    expect(cuandoTocaSeguimiento(llamada, null, 2)?.toISOString()).toBe("2026-10-19T18:00:00.000Z");
    expect(cuandoTocaSeguimiento(null, mensaje, 1)?.toISOString()).toBe("2026-10-20T19:30:00.000Z");
  });
  it("sin ninguna interacción no hay de dónde contar", () => {
    expect(cuandoTocaSeguimiento(null, null, 48)).toBeNull();
  });
});
