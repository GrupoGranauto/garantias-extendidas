import { describe, expect, it } from "vitest";
import { evaluarCompletitud, normalizarDatosEmision, type BaseEmision } from "../lib/datosEmisionLogica.js";
import { PROGRAMA_POR_OMISION as P, type ProgramaGe } from "../lib/programaGeLogica.js";

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
  dir_cp: "85800",
  dir_estado: "Sonora",
  dir_municipio: "Navojoa",
  dir_colonia: "Centro",
  dir_calle: "Calle 1",
  dir_num_ext: "2",
  dir_num_int: null,
  plazo_meses: 24,
  metodo_pago: "financiado",
  msi_meses: 6,
  vendedor: "Ana Pérez",
  direccion: null,
};

const norm = (e: Parameters<typeof normalizarDatosEmision>[0], p: ProgramaGe = P, metodo: "contado" | "financiado" | null = null) =>
  normalizarDatosEmision(e, p, { metodo_pago: metodo });

describe("normalizarDatosEmision", () => {
  it("limpia espacios y pone mayúsculas en factura y motor", () => {
    expect(norm({ numero_factura: "  a-12  34 ", numero_motor: " qr25 de-99 " })).toEqual({ datos: { numero_factura: "A-12 34", numero_motor: "QR25DE-99" } });
  });

  it("acepta el valor con signo de pesos y comas", () => {
    expect(norm({ valor_factura: "$385,000.50" })).toEqual({ datos: { valor_factura: 385000.5 } });
    expect(norm({ valor_factura: 385000 })).toEqual({ datos: { valor_factura: 385000 } });
  });

  it("rechaza montos inválidos", () => {
    for (const v of ["abc", "0", "-5", "12.345", "100000000", "1e6"]) expect("error" in norm({ valor_factura: v }), v).toBe(true);
  });

  it("un texto vacío borra el dato", () => {
    expect(norm({ numero_factura: "", valor_factura: "  ", numero_motor: null, dir_calle: "", estado_circulacion: " " })).toEqual({
      datos: { numero_factura: null, valor_factura: null, numero_motor: null, dir_calle: null, estado_circulacion: null },
    });
  });

  it("solo toca los campos que vienen", () => {
    expect(norm({ dir_calle: "Calle 5" })).toEqual({ datos: { dir_calle: "Calle 5" } });
    expect(norm({})).toEqual({ datos: {} });
  });

  it("rechaza caracteres raros y textos largos", () => {
    expect("error" in norm({ numero_motor: "QR25;DROP" })).toBe(true);
    expect("error" in norm({ numero_factura: "A<script>" })).toBe(true);
    expect("error" in norm({ numero_motor: "A".repeat(31) })).toBe(true);
    expect("error" in norm({ dir_calle: "x".repeat(161) })).toBe(true);
  });

  it("estado de circulación y estado de la dirección: de la lista del programa, con su escritura", () => {
    expect(norm({ estado_circulacion: "sonora", dir_estado: "CIUDAD DE MÉXICO" })).toEqual({ datos: { estado_circulacion: "Sonora", dir_estado: "Ciudad de México" } });
    expect("error" in norm({ estado_circulacion: "Arizona" })).toBe(true);
    // Sin lista en el programa, texto libre.
    expect(norm({ estado_circulacion: "Arizona" }, { ...P, estados_circulacion: [] })).toEqual({ datos: { estado_circulacion: "Arizona" } });
  });

  it("código postal de 5 dígitos", () => {
    expect(norm({ dir_cp: " 85 800 " })).toEqual({ datos: { dir_cp: "85800" } });
    expect("error" in norm({ dir_cp: "8580" })).toBe(true);
    expect("error" in norm({ dir_cp: "ABCDE" })).toBe(true);
  });

  it("el plazo debe ser de los del programa", () => {
    expect(norm({ plazo_meses: "24" })).toEqual({ datos: { plazo_meses: 24 } });
    expect("error" in norm({ plazo_meses: 18 })).toBe(true);
    expect(norm({ plazo_meses: 18 }, { ...P, plazos_meses: [18] })).toEqual({ datos: { plazo_meses: 18 } });
  });

  it("MSI solo con pago financiado y de la lista; contado los borra", () => {
    expect(norm({ metodo_pago: "Financiado", msi_meses: 6 })).toEqual({ datos: { metodo_pago: "financiado", msi_meses: 6 } });
    expect("error" in norm({ metodo_pago: "financiado", msi_meses: 12 })).toBe(true);
    expect("error" in norm({ metodo_pago: "contado", msi_meses: 3 })).toBe(true);
    expect(norm({ metodo_pago: "contado" })).toEqual({ datos: { metodo_pago: "contado", msi_meses: null } });
    // Ya era financiado: se pueden cambiar solo los meses.
    expect(norm({ msi_meses: 9 }, P, "financiado")).toEqual({ datos: { msi_meses: 9 } });
    expect("error" in norm({ msi_meses: 9 }, P, "contado")).toBe(true);
    expect("error" in norm({ metodo_pago: "tarjeta" })).toBe(true);
  });

  it("vendedor de la lista si el programa tiene; si no, libre", () => {
    expect(norm({ vendedor: "Juan" })).toEqual({ datos: { vendedor: "Juan" } });
    const conLista = { ...P, vendedores: ["Ana Pérez"] };
    expect(norm({ vendedor: "ana pérez" }, conLista)).toEqual({ datos: { vendedor: "Ana Pérez" } });
    expect("error" in norm({ vendedor: "Juan" }, conLista)).toBe(true);
  });
});

describe("evaluarCompletitud", () => {
  it("verde cuando está todo y cumple los requisitos; arma el producto y las fechas", () => {
    const c = evaluarCompletitud(base, "2026-10-05", P);
    expect(c.semaforo).toBe("verde");
    expect(c.faltan).toEqual([]);
    expect(c.bloqueos).toEqual([]);
    expect(c.completos).toBe(c.total);
    expect(c.producto).toEqual({
      nombre: "NISSAN NUEVOS MSI 2026 · 0 - 15,000 km · 24 meses",
      banda: "0 - 15,000 km",
      cobertura: { inicio: "2029-04-30", fin: "2031-04-29" },
    });
  });

  it("ámbar cuando faltan datos, y dice cuáles", () => {
    const c = evaluarCompletitud({ ...base, numero_motor: null, dir_calle: "  ", valor_factura: null }, "2026-10-05", P);
    expect(c.semaforo).toBe("ambar");
    expect(c.faltan.map((f) => f.campo)).toEqual(["valor_factura", "numero_motor", "dir_calle"]);
    expect(c.faltan.every((f) => f.capturable)).toBe(true);
  });

  it("el número interior es opcional; los MSI solo se piden con pago financiado", () => {
    expect(evaluarCompletitud({ ...base, dir_num_int: null }, "2026-10-05", P).semaforo).toBe("verde");
    expect(evaluarCompletitud({ ...base, msi_meses: null }, "2026-10-05", P).faltan.map((f) => f.campo)).toEqual(["msi_meses"]);
    expect(evaluarCompletitud({ ...base, metodo_pago: "contado", msi_meses: null }, "2026-10-05", P).semaforo).toBe("verde");
  });

  it("falta el km o el correo: ámbar, pero no capturable aquí", () => {
    const c = evaluarCompletitud({ ...base, kilometraje: null, correo: null }, "2026-10-05", P);
    expect(c.semaforo).toBe("ambar");
    expect(c.faltan.map((f) => [f.campo, f.capturable])).toEqual([["kilometraje", false], ["correo", false]]);
    expect(c.producto).toBeNull();
  });

  it("rojo si el km pasa del máximo del programa", () => {
    const c = evaluarCompletitud({ ...base, kilometraje: 59001 }, "2026-10-05", P);
    expect(c.semaforo).toBe("rojo");
    expect(c.bloqueos).toHaveLength(1);
    expect(evaluarCompletitud({ ...base, kilometraje: 59000 }, "2026-10-05", P).semaforo).toBe("verde");
    expect(evaluarCompletitud({ ...base, kilometraje: 59000 }, "2026-10-05", P).producto?.banda).toBe("15,001 - 59,000 km");
    // Otro programa con otro máximo.
    expect(evaluarCompletitud({ ...base, kilometraje: 59001 }, "2026-10-05", { ...P, bandas_km: [20000, 80000] }).semaforo).toBe("verde");
  });

  it("rojo si la garantía original ya terminó (meses del programa desde la factura)", () => {
    expect(evaluarCompletitud({ ...base, fecha_factura: "2023-10-05" }, "2026-10-05", P).semaforo).toBe("rojo");
    expect(evaluarCompletitud({ ...base, fecha_factura: "2023-10-06" }, "2026-10-05", P).semaforo).toBe("verde");
    expect(evaluarCompletitud({ ...base, fecha_factura: "2023-10-05" }, "2026-10-05", { ...P, meses_garantia_original: 48 }).semaforo).toBe("verde");
  });

  it("el rojo manda aunque falten datos", () => {
    const c = evaluarCompletitud({ ...base, kilometraje: 70000, numero_motor: null }, "2026-10-05", P);
    expect(c.semaforo).toBe("rojo");
    expect(c.faltan.map((f) => f.campo)).toEqual(["numero_motor"]);
  });
});
