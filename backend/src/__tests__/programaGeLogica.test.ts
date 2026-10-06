import { describe, expect, it } from "vitest";
import { bandaDeKm, fechasCobertura, kmMaximo, PROGRAMA_POR_OMISION as P, validarPrograma } from "../lib/programaGeLogica.js";

describe("programa por omisión (GEXT de GranAuto)", () => {
  it("es válido y su km máximo es 59,000", () => {
    expect(validarPrograma(P)).toBeNull();
    expect(kmMaximo(P)).toBe(59000);
    expect(P.estados_circulacion).toHaveLength(32);
  });
});

describe("validarPrograma", () => {
  it("rechaza bandas, plazos o MSI desordenados o fuera de rango", () => {
    expect(validarPrograma({ ...P, bandas_km: [59000, 15000] })).not.toBeNull();
    expect(validarPrograma({ ...P, bandas_km: [] })).not.toBeNull();
    expect(validarPrograma({ ...P, plazos_meses: [24, 12] })).not.toBeNull();
    expect(validarPrograma({ ...P, plazos_meses: [0] })).not.toBeNull();
    expect(validarPrograma({ ...P, msi_meses: [3, 3] })).not.toBeNull();
    expect(validarPrograma({ ...P, msi_meses: [] })).toBeNull();
  });

  it("rechaza nombre vacío, garantía o liga fuera de rango y listas con repetidos", () => {
    expect(validarPrograma({ ...P, nombre: " " })).not.toBeNull();
    expect(validarPrograma({ ...P, meses_garantia_original: 0 })).not.toBeNull();
    expect(validarPrograma({ ...P, liga_pago_horas: 0 })).not.toBeNull();
    expect(validarPrograma({ ...P, estados_circulacion: ["Sonora", "sonora"] })).not.toBeNull();
    expect(validarPrograma({ ...P, vendedores: ["Ana", "Ana"] })).not.toBeNull();
    expect(validarPrograma({ ...P, estados_circulacion: [], vendedores: [] })).toBeNull();
  });
});

describe("bandaDeKm", () => {
  it("cae en la banda correcta, con los límites incluidos", () => {
    expect(bandaDeKm(0, P.bandas_km)?.etiqueta).toBe("0 - 15,000 km");
    expect(bandaDeKm(15000, P.bandas_km)?.etiqueta).toBe("0 - 15,000 km");
    expect(bandaDeKm(15001, P.bandas_km)).toEqual({ desde: 15001, hasta: 59000, etiqueta: "15,001 - 59,000 km" });
    expect(bandaDeKm(59000, P.bandas_km)?.hasta).toBe(59000);
  });

  it("null si pasa del máximo o no hay km", () => {
    expect(bandaDeKm(59001, P.bandas_km)).toBeNull();
    expect(bandaDeKm(null, P.bandas_km)).toBeNull();
    expect(bandaDeKm(-1, P.bandas_km)).toBeNull();
  });
});

describe("fechasCobertura", () => {
  it("como el portal: factura 10/08/2026, 24 meses → del 10/08/2029 al 09/08/2031", () => {
    expect(fechasCobertura("2026-08-10", 36, 24)).toEqual({ inicio: "2029-08-10", fin: "2031-08-09" });
  });

  it("fin de mes y otros plazos", () => {
    expect(fechasCobertura("2026-01-31", 36, 12)).toEqual({ inicio: "2029-01-31", fin: "2030-01-30" });
    expect(fechasCobertura("2026-03-01", 36, 36)).toEqual({ inicio: "2029-03-01", fin: "2032-02-29" });
    expect(fechasCobertura("no-es-fecha", 36, 12)).toBeNull();
  });
});
