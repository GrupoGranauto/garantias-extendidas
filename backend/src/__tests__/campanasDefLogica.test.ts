import { describe, expect, it } from "vitest";
import {
  asignarCampana,
  describirDefinicion,
  diasTranscurridos,
  horaDelPaso,
  inicioEnCampana,
  mesAtras,
  perteneceACampana,
  validarDefiniciones,
  validarDefinicion,
  type DefinicionCampana,
} from "../lib/campanasDefLogica.js";

const base = {
  columna_fecha: "fecha_factura",
  dias_desde: null,
  dias_hasta: null,
  meses_atras: null,
  dia_envio: null,
  hora_envio: null,
  etapa_orden: null,
  activa: true,
} as const;

const porDias = (nombre: string, desde: number, hasta: number, extra: Partial<DefinicionCampana> = {}): DefinicionCampana => ({
  ...base,
  nombre,
  tipo: "dias",
  dias_desde: desde,
  dias_hasta: hasta,
  ...extra,
});
const porMeses = (nombre: string, atras: number, extra: Partial<DefinicionCampana> = {}): DefinicionCampana => ({
  ...base,
  nombre,
  tipo: "meses",
  meses_atras: atras,
  dia_envio: 5,
  hora_envio: "10:00",
  ...extra,
});

const HOY = "2026-10-03";
const lead = (fecha: string | null, etapaOrden: number | null = null) => ({ fecha, etapaOrden });

describe("fechas", () => {
  it("cuenta días completos", () => {
    expect(diasTranscurridos("2026-09-30", "2026-10-03")).toBe(3);
    expect(diasTranscurridos("2025-10-03", "2026-10-03")).toBe(365);
    expect(diasTranscurridos("2026-10-04", "2026-10-03")).toBe(-1);
  });
  it("calcula el mes de la cohorte, también cruzando años", () => {
    expect(mesAtras("2026-10-03", 5)).toBe("2026-05");
    expect(mesAtras("2026-10-03", 28)).toBe("2024-06");
    expect(mesAtras("2026-01-15", 1)).toBe("2025-12");
    expect(mesAtras("2026-01-15", 0)).toBe("2026-01");
    expect(mesAtras("2026-03-31", 12)).toBe("2025-03");
  });
});

describe("campaña por días", () => {
  const h48 = porDias("48H", 1, 4); // BigQuery: de 1 a 3 días
  it("entra con el desde y el último día antes del hasta", () => {
    expect(perteneceACampana(h48, lead("2026-10-02"), HOY)).toBe(true); // 1 día
    expect(perteneceACampana(h48, lead("2026-09-30"), HOY)).toBe(true); // 3 días
  });
  it("no entra el mismo día, ni con el hasta, ni en el futuro", () => {
    expect(perteneceACampana(h48, lead("2026-10-03"), HOY)).toBe(false); // 0
    expect(perteneceACampana(h48, lead("2026-09-29"), HOY)).toBe(false); // 4 = hasta
    expect(perteneceACampana(h48, lead("2026-10-10"), HOY)).toBe(false);
  });
  it("sale solo con el paso de los días (12 meses nurturing: 334 a 364)", () => {
    const n = porDias("12M_NURTURING", 334, 365);
    expect(perteneceACampana(n, lead("2025-10-03"), HOY)).toBe(false); // 365
    expect(perteneceACampana(n, lead("2025-10-04"), HOY)).toBe(true); // 364
    expect(perteneceACampana(n, lead("2025-11-02"), HOY)).toBe(true); // 335
    expect(perteneceACampana(n, lead("2025-11-03"), HOY)).toBe(true); // 334
    expect(perteneceACampana(n, lead("2025-11-04"), HOY)).toBe(false); // 333
  });
});

describe("campaña por meses", () => {
  const m5 = porMeses("5M", 5);
  it("entra todo el mes de la cohorte, sin importar el día", () => {
    expect(perteneceACampana(m5, lead("2026-05-01"), HOY)).toBe(true);
    expect(perteneceACampana(m5, lead("2026-05-31"), HOY)).toBe(true);
  });
  it("no entra el mes anterior ni el siguiente", () => {
    expect(perteneceACampana(m5, lead("2026-04-30"), HOY)).toBe(false);
    expect(perteneceACampana(m5, lead("2026-06-01"), HOY)).toBe(false);
  });
  it("la cohorte cambia al cambiar el mes", () => {
    expect(perteneceACampana(m5, lead("2026-05-20"), "2026-11-01")).toBe(false);
    expect(perteneceACampana(m5, lead("2026-06-20"), "2026-11-01")).toBe(true);
  });
  it("28 meses cruza años", () => {
    expect(perteneceACampana(porMeses("28M", 28), lead("2024-06-03"), HOY)).toBe(true);
  });
});

describe("condiciones comunes", () => {
  it("sin fecha o con fecha inválida no pertenece", () => {
    expect(perteneceACampana(porDias("a", 0, 10), lead(null), HOY)).toBe(false);
    expect(perteneceACampana(porDias("a", 0, 10), lead("03/10/2026"), HOY)).toBe(false);
  });
  it("una campaña apagada no incluye a nadie", () => {
    expect(perteneceACampana(porDias("a", 0, 10, { activa: false }), lead("2026-10-01"), HOY)).toBe(false);
  });
  it("si pide etapa del vehículo, solo entra quien está en ella", () => {
    const d = porMeses("5M", 5, { etapa_orden: 1 });
    expect(perteneceACampana(d, lead("2026-05-10", 1), HOY)).toBe(true);
    expect(perteneceACampana(d, lead("2026-05-10", 2), HOY)).toBe(false);
    expect(perteneceACampana(d, lead("2026-05-10", null), HOY)).toBe(false);
  });
  it("sin pedir etapa, sirve cualquiera", () => {
    expect(perteneceACampana(porMeses("5M", 5), lead("2026-05-10", 2), HOY)).toBe(true);
  });
});

describe("asignarCampana", () => {
  it("elige la primera de la lista y avisa de los traslapes", () => {
    const defs = [porDias("A", 0, 100), porDias("B", 0, 50)];
    const r = asignarCampana(defs, () => lead("2026-09-20"), HOY);
    expect(r.elegida?.nombre).toBe("A");
    expect(r.todas.map((d) => d.nombre)).toEqual(["A", "B"]);
  });
  it("sin coincidencias no hay campaña", () => {
    expect(asignarCampana([porDias("A", 0, 2)], () => lead("2026-01-01"), HOY).elegida).toBeNull();
  });
  it("cada campaña puede leer su propia columna de fecha", () => {
    const defs = [porDias("F", 0, 5, { columna_fecha: "fecha_factura" }), porDias("R", 0, 5, { columna_fecha: "fecha_reporte" })];
    const fechas = { fecha_factura: "2026-01-01", fecha_reporte: "2026-10-01" };
    const r = asignarCampana(defs, (d) => lead(fechas[d.columna_fecha]), HOY);
    expect(r.elegida?.nombre).toBe("R");
  });
});

describe("validación", () => {
  it("acepta definiciones correctas", () => {
    expect(validarDefinicion(porDias("48H", 1, 4))).toBeNull();
    expect(validarDefinicion(porMeses("5M", 5))).toBeNull();
  });
  it("rechaza rangos de días al revés o iguales", () => {
    expect(validarDefinicion(porDias("X", 5, 5))).toMatch(/mayor/);
    expect(validarDefinicion(porDias("X", 9, 3))).toMatch(/mayor/);
  });
  it("rechaza día de envío fuera de 1 a 28 y hora inválida", () => {
    expect(validarDefinicion(porMeses("X", 5, { dia_envio: 31 }))).toMatch(/1 y 28/);
    expect(validarDefinicion(porMeses("X", 5, { dia_envio: 0 }))).toMatch(/1 y 28/);
    expect(validarDefinicion(porMeses("X", 5, { hora_envio: "25:00" }))).toMatch(/hora/);
  });
  it("rechaza nombre vacío y nombres repetidos sin importar mayúsculas", () => {
    expect(validarDefinicion(porDias("  ", 1, 4))).toMatch(/nombre/);
    expect(validarDefiniciones([porDias("48H", 1, 4), porMeses("48h", 5)])).toMatch(/dos campañas/);
  });
  it("el nombre solo admite letras, números y guion bajo (así se usa en la pestaña de WhatsApp)", () => {
    expect(validarDefinicion(porDias("12M_NURTURING", 1, 4))).toBeNull();
    expect(validarDefinicion(porDias("Mi campaña", 1, 4))).toMatch(/guion bajo/);
    expect(validarDefinicion(porDias("a".repeat(31), 1, 4))).toMatch(/30/);
  });
  it("limita a 20 campañas", () => {
    const muchas = Array.from({ length: 21 }, (_, i) => porDias(`C${i}`, 1, 4));
    expect(validarDefiniciones(muchas)).toMatch(/20/);
  });
});

describe("inicio de la campaña", () => {
  it("por días: la fecha del vehículo más el desde", () => {
    expect(inicioEnCampana(porDias("48H", 1, 4), "2026-09-30", HOY)).toBe("2026-10-01");
    expect(inicioEnCampana(porDias("12M", 334, 365), "2025-11-03", HOY)).toBe("2026-10-03");
  });
  it("por días: cruza fin de mes y de año", () => {
    expect(inicioEnCampana(porDias("X", 3, 9), "2026-12-30", HOY)).toBe("2027-01-02");
  });
  it("por meses: el día de envío del mes actual", () => {
    expect(inicioEnCampana(porMeses("5M", 5, { dia_envio: 5 }), "2026-05-20", HOY)).toBe("2026-10-05");
    expect(inicioEnCampana(porMeses("5M", 5, { dia_envio: 28 }), "2026-05-20", "2026-02-10")).toBe("2026-02-28");
  });
  it("por meses: un lead que llega tarde queda con inicio ya pasado (el motor decide por la vigencia)", () => {
    const inicio = inicioEnCampana(porMeses("5M", 5, { dia_envio: 5 }), "2026-05-20", "2026-10-20");
    expect(inicio).toBe("2026-10-05");
    expect(diasTranscurridos(inicio, "2026-10-20")).toBe(15);
  });
  it("la hora del primer mensaje: la del paso, la de la campaña o al abrir la ventana", () => {
    expect(horaDelPaso("11:00", "09:00")).toBe("11:00");
    expect(horaDelPaso(null, "09:00")).toBe("09:00");
    expect(horaDelPaso(null, null)).toBeNull();
  });
});

describe("descripción", () => {
  it("explica la regla con las palabras del usuario", () => {
    expect(describirDefinicion(porDias("48H", 1, 4))).toContain("de 1 a 3 días");
    const m = describirDefinicion(porMeses("5M", 5));
    expect(m).toContain("de hace 5 meses");
    expect(m).toContain("día 5 a las 10:00");
    expect(describirDefinicion(porMeses("X", 1))).toContain("del mes pasado");
  });
});
