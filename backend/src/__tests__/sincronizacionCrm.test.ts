import { describe, expect, it } from "vitest";
import {
  claveContacto,
  clasificarCierre,
  normalizarCp,
  normalizarEstado,
  oportunidadActiva,
  planificar,
  sumarMeses,
  type FilaMaestra,
  type OportunidadExistente,
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

const existente = (extra: Partial<OportunidadExistente> = {}): OportunidadExistente => ({
  id: "id-1",
  clave: "VIN0000000000001|5M|2026-09-01",
  vin: "VIN0000000000001",
  campana: "5M",
  estado_cartera: "ACTIVA",
  ejecutivo: "Ana",
  estado: "abierta",
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

describe("planificar", () => {
  const roster = ["Ana", "Beto"];

  it("coincidencia exacta: actualiza y no migra ni cierra", () => {
    const p = planificar([maestra()], [existente({ clave: "VIN0000000000001|5M|2026-10-01" })], roster);
    expect(p.actualizadas).toHaveLength(1);
    expect(p.migradas).toHaveLength(0);
    expect(p.cerradas).toHaveLength(0);
    expect(p.nuevas).toHaveLength(0);
    expect(p.conflictos).toEqual([]);
  });

  it("un 6M histórico se migra a la 5M activa equivalente", () => {
    const p = planificar([maestra()], [existente({ clave: "VIN0000000000001|6M|2026-08-31", campana: "6M" })], roster);
    expect(p.migradas).toHaveLength(1);
    expect(p.migradas[0].datos.clave).toBe("VIN0000000000001|5M|2026-10-01");
    expect(p.nuevas).toHaveLength(0);
  });

  it("12M_NURTURING no migra: una clave distinta es una oportunidad nueva y la vieja se cierra", () => {
    const m = maestra({ campania_actual: "12M_NURTURING" });
    const p = planificar(
      [m],
      [existente({ clave: "VIN0000000000001|12M_NURTURING|2026-01-01", campana: "12M_NURTURING" })],
      roster,
    );
    expect(p.migradas).toHaveLength(0);
    expect(p.nuevas).toHaveLength(1);
    expect(p.cerradas).toHaveLength(1);
  });

  it("dos filas históricas que reclaman la misma activa son un conflicto (no se escribe)", () => {
    const p = planificar(
      [maestra()],
      [
        existente({ id: "a", clave: "VIN0000000000001|6M|2026-07-01", campana: "6M" }),
        existente({ id: "b", clave: "VIN0000000000001|5M|2026-08-01", campana: "5M" }),
      ],
      roster,
    );
    expect(p.conflictos.join(" ")).toMatch(/Doble migración/);
  });

  it("nunca borra: lo que ya no está activo se cierra con su estado, o no cambia si ya lo tenía", () => {
    const sinActiva = maestra({ en_cartera_operativa: false, tiene_ge: true });
    const p = planificar(
      [sinActiva],
      [
        existente({ id: "x", clave: "VIN0000000000001|5M|2026-09-01" }),
        existente({ id: "y", clave: "VIN0000000000001|48H|2026-09-02", campana: "48H", estado_cartera: "YA_TIENE_GE" }),
      ],
      roster,
    );
    expect(p.cerradas).toEqual([{ id: "x", estado: "YA_TIENE_GE" }]);
    expect(p.sinCambio).toBe(1);
  });

  it("un VIN que ya no está en la maestra se cierra como NO_EN_MAESTRA", () => {
    const p = planificar([maestra({ vin: "OTRO" })], [existente()], roster);
    expect(p.cerradas).toEqual([{ id: "id-1", estado: "NO_EN_MAESTRA" }]);
  });

  it("las nuevas van al ejecutivo con menos cartera que seguirá activa (sin contar lo que se cierra hoy)", () => {
    // Ana tiene 2 abiertas que se cierran hoy; Beto tiene 1 que sigue activa: Ana recibe las nuevas primero.
    const m = [maestra({ vin: "V-BETO" }), maestra({ vin: "N1" }), maestra({ vin: "N2" })];
    const ex = [
      existente({ id: "a1", clave: "VX1|5M|2026-09-01", vin: "VX1", ejecutivo: "Ana" }),
      existente({ id: "a2", clave: "VX2|5M|2026-09-01", vin: "VX2", ejecutivo: "Ana" }),
      existente({ id: "b1", clave: "V-BETO|5M|2026-10-01", vin: "V-BETO", ejecutivo: "Beto" }),
    ];
    const p = planificar(m, ex, roster);
    expect(p.nuevas.map((n) => n.ejecutivo)).toEqual(["Ana", "Ana"]);
  });

  it("reparte las nuevas de forma equilibrada", () => {
    const m = Array.from({ length: 6 }, (_, i) => maestra({ vin: `N${i}` }));
    const p = planificar(m, [], roster);
    const por = (e: string) => p.nuevas.filter((n) => n.ejecutivo === e).length;
    expect([por("Ana"), por("Beto")]).toEqual([3, 3]);
  });

  it("es idempotente: aplicar el plan y volver a planificar no deja nada por hacer", () => {
    const m = [maestra()];
    const primero = planificar(m, [], roster);
    expect(primero.nuevas).toHaveLength(1);
    const ya = existente({ id: "n", clave: primero.nuevas[0].clave, ejecutivo: primero.nuevas[0].ejecutivo });
    const segundo = planificar(m, [ya], roster);
    expect(segundo.nuevas).toHaveLength(0);
    expect(segundo.migradas).toHaveLength(0);
    expect(segundo.cerradas).toHaveLength(0);
    expect(segundo.actualizadas).toHaveLength(1);
  });

  it("deduplica contactos por clave, quedándose con la factura más reciente", () => {
    const m = [
      maestra({ vin: "A", fecha_factura: "2025-01-01", cliente: "Viejo" }),
      maestra({ vin: "B", fecha_factura: "2026-05-01", cliente: "Nuevo" }),
    ];
    const p = planificar(m, [], roster);
    expect(p.contactos.size).toBe(1);
    expect([...p.contactos.values()][0].cliente).toBe("Nuevo");
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
