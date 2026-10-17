import { describe, expect, it } from "vitest";
import {
  RESULTADOS_LLAMADA,
  RESULTADOS_POR_OMISION,
  avanceSinRespuesta,
  validarConfigSinRespuesta,
  type ConfigSinRespuesta,
} from "../lib/sinRespuestaLogica.js";

const cfg = (extra: Partial<ConfigSinRespuesta> = {}): ConfigSinRespuesta => ({
  activa: true,
  plantillaId: "p1",
  intentos: 3,
  resultados: [...RESULTADOS_POR_OMISION],
  telefonosPrueba: [],
  ...extra,
});

describe("configuración del mensaje por llamadas sin respuesta", () => {
  it("por omisión cuentan no contesta, buzón, cuelga y ocupado; nunca «contesta el titular»", () => {
    expect(RESULTADOS_POR_OMISION).toEqual(["NO_CONTESTA", "BUZON", "CUELGA", "OCUPADO"]);
    expect(RESULTADOS_LLAMADA).toContain("CONTESTA_TITULAR");
    expect(validarConfigSinRespuesta(cfg({ resultados: ["NO_CONTESTA", "CONTESTA_TITULAR"] }))).toMatch(/titular/);
  });
  it("valida el número de llamadas, los resultados, la plantilla y los teléfonos de prueba", () => {
    expect(validarConfigSinRespuesta(cfg())).toBeNull();
    expect(validarConfigSinRespuesta(cfg({ intentos: 0 }))).toMatch(/1 a 20/);
    expect(validarConfigSinRespuesta(cfg({ intentos: 21 }))).toMatch(/1 a 20/);
    expect(validarConfigSinRespuesta(cfg({ resultados: [] }))).toMatch(/al menos un resultado/);
    expect(validarConfigSinRespuesta(cfg({ resultados: ["INVENTADO"] }))).toMatch(/no existe/);
    expect(validarConfigSinRespuesta(cfg({ plantillaId: null }))).toMatch(/plantilla/);
    expect(validarConfigSinRespuesta(cfg({ activa: false, plantillaId: null }))).toBeNull();
    expect(validarConfigSinRespuesta(cfg({ telefonosPrueba: ["662358"] }))).toMatch(/10 dígitos/);
  });
});

describe("avance hacia el mensaje", () => {
  it("cuenta las llamadas que faltan y avisa cuando ya llegó", () => {
    expect(avanceSinRespuesta(0, 3)).toEqual({ contadas: 0, faltan: 3, listo: false });
    expect(avanceSinRespuesta(2, 3)).toEqual({ contadas: 2, faltan: 1, listo: false });
    expect(avanceSinRespuesta(3, 3)).toEqual({ contadas: 3, faltan: 0, listo: true });
    expect(avanceSinRespuesta(5, 3)).toEqual({ contadas: 5, faltan: 0, listo: true });
  });
});
