import { describe, expect, it } from "vitest";
import {
  claveContacto,
  clasificarCierre,
  normalizarCp,
  normalizarEstado,
  oportunidadActiva,
  sumarMeses,
  type FilaMaestra,
} from "../lib/sincronizacionCrm.js";

/** Fila de la maestra con valores razonables; cada prueba cambia solo lo que le importa. */
const maestra = (extra: FilaMaestra = {}): FilaMaestra => ({
  vin: "VIN0000000000001",
  fecha_factura: "2026-01-15",
  fecha_reporte: "2026-09-30",
  cliente: "Cliente Uno",
  telefono_principal: "(662) 123-4567",
  correo: null,
  es_contactable: true,
  tiene_ge: false,
  en_cartera_operativa: true,
  campania_actual: "5M",
  fecha_inicio_5m: "2026-10-01",
  fecha_fin_5m: "2026-10-31",
  etapa: "ETAPA_1",
  ...extra,
});

describe("sumarMeses", () => {
  it("suma meses y recorta el día al fin de mes", () => {
    expect(sumarMeses("2026-01-15", 11)).toBe("2026-12-15");
    expect(sumarMeses("2026-01-31", 1)).toBe("2026-02-28");
    expect(sumarMeses("2024-01-31", 1)).toBe("2024-02-29");
    expect(sumarMeses("2026-02-10", 11)).toBe("2027-01-10");
  });
});

describe("oportunidadActiva", () => {
  it("arma la clave VIN|campaña|inicio", () => {
    expect(oportunidadActiva(maestra())?.clave).toBe("VIN0000000000001|5M|2026-10-01");
  });

  it("48H empieza en la fecha de reporte", () => {
    const o = oportunidadActiva(maestra({ campania_actual: "48H", fecha_fin_48h: "2026-10-02" }));
    expect(o?.fecha_inicio_campana).toBe("2026-09-30");
    expect(o?.fecha_fin_campana).toBe("2026-10-02");
  });

  it("12M_NURTURING empieza 11 meses después de la factura", () => {
    expect(oportunidadActiva(maestra({ campania_actual: "12M_NURTURING" }))?.fecha_inicio_campana).toBe("2026-12-15");
  });

  it("no es activa fuera de la cartera operativa, sin campaña o sin fecha de inicio", () => {
    expect(oportunidadActiva(maestra({ en_cartera_operativa: false }))).toBeNull();
    expect(oportunidadActiva(maestra({ campania_actual: null }))).toBeNull();
    expect(oportunidadActiva(maestra({ fecha_inicio_5m: null }))).toBeNull();
  });

  it("conserva a quien no es contactable: pertenecer a la cartera no es lo mismo que poder contactarlo", () => {
    expect(oportunidadActiva(maestra({ es_contactable: false }))).not.toBeNull();
  });
});

describe("claveContacto", () => {
  it("usa los últimos 10 dígitos del teléfono, ignorando formato y lada", () => {
    expect(claveContacto(maestra({ telefono_principal: "+52 1 (662) 123-4567" }))).toBe("6621234567");
  });
  it("cae al correo en minúsculas, y luego al VIN", () => {
    expect(claveContacto(maestra({ telefono_principal: "123", correo: "A@B.COM" }))).toBe("a@b.com");
    expect(claveContacto(maestra({ telefono_principal: null, correo: null }))).toBe("vin:VIN0000000000001");
  });
});

describe("clasificarCierre", () => {
  it("clasifica por el estado actual del VIN", () => {
    expect(clasificarCierre(undefined)).toBe("NO_EN_MAESTRA");
    expect(clasificarCierre(maestra({ tiene_ge: true }))).toBe("YA_TIENE_GE");
    expect(clasificarCierre(maestra({ es_contactable: false }))).toBe("NO_CONTACTABLE_FUENTE");
    expect(clasificarCierre(maestra({ en_cartera_operativa: false }))).toBe("FUERA_DE_VENTANA");
  });
  it("tener GE gana sobre no ser contactable", () => {
    expect(clasificarCierre(maestra({ tiene_ge: true, es_contactable: false }))).toBe("YA_TIENE_GE");
  });
});

describe("datos para emitir desde la maestra", () => {
  it("normaliza el estado a como lo escribe el portal", () => {
    expect(normalizarEstado("SONORA")).toBe("Sonora");
    expect(normalizarEstado("ciudad de mexico")).toBe("Ciudad de México");
    expect(normalizarEstado("  Nuevo León ")).toBe("Nuevo León");
    expect(normalizarEstado("Texas")).toBe("Texas");
    expect(normalizarEstado("")).toBeNull();
  });

  it("deja el código postal en 5 dígitos", () => {
    expect(normalizarCp(85800)).toBe("85800");
    expect(normalizarCp("5800")).toBe("05800");
    expect(normalizarCp("C.P. 85000")).toBe("85000");
    expect(normalizarCp("123")).toBeNull();
    expect(normalizarCp(null)).toBeNull();
  });

  it("las columnas de emisión no se mezclan con los datos extra de la fuente", () => {
    const d = oportunidadActiva({
      vin: "VIN1", campania_actual: "5M", en_cartera_operativa: true, fecha_inicio_5m: "2026-10-01",
      numero_factura: "A1", dir_cp: "85800", otra_columna: "x",
    });
    expect(d?.fuente).toEqual({ fecha_inicio_5m: "2026-10-01", en_cartera_operativa: true, otra_columna: "x" });
  });
});
