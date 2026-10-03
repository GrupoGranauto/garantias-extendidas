import { describe, expect, it } from "vitest";
import { automatizacionSchema, validarRespuesta } from "../lib/motorCrm.js";
import { ejecutivoRestringido, esUuid, puedeTocar } from "../lib/permisos.js";
import { validarFechaCoherente } from "../lib/entidades.js";

describe("validarRespuesta", () => {
  it("exige respuesta", () => {
    expect(validarRespuesta({ tipo_respuesta: "texto" }, "  ")).toHaveProperty("error");
    expect(validarRespuesta({ tipo_respuesta: "texto" }, null)).toHaveProperty("error");
  });

  it("valida por tipo", () => {
    expect(validarRespuesta({ tipo_respuesta: "numero" }, "12.5")).toEqual({ valor: "12.5" });
    expect(validarRespuesta({ tipo_respuesta: "numero" }, "abc")).toHaveProperty("error");
    expect(validarRespuesta({ tipo_respuesta: "si_no" }, "Sí")).toEqual({ valor: "Sí" });
    expect(validarRespuesta({ tipo_respuesta: "si_no" }, "tal vez")).toHaveProperty("error");
    expect(validarRespuesta({ tipo_respuesta: "opcion", opciones: ["a", "b"] }, "b")).toEqual({ valor: "b" });
    expect(validarRespuesta({ tipo_respuesta: "opcion", opciones: ["a", "b"] }, "c")).toHaveProperty("error");
  });

  it("las fechas no pueden ser futuras ni inexistentes", () => {
    expect(validarRespuesta({ tipo_respuesta: "fecha" }, "2099-01-01")).toHaveProperty("error");
    expect(validarRespuesta({ tipo_respuesta: "fecha" }, "2026-02-31")).toHaveProperty("error");
    expect(validarRespuesta({ tipo_respuesta: "fecha" }, "2026-02-10")).toEqual({ valor: "2026-02-10" });
  });
});

describe("automatizacionSchema", () => {
  const tarea = { tipo: "tarea", nombre: "n", config: { titulo: "Llamar a {cliente}" } };

  it("acepta una tarea al entrar a la etapa", () => {
    expect(automatizacionSchema.safeParse(tarea).success).toBe(true);
  });

  it("una tarea necesita título", () => {
    expect(automatizacionSchema.safeParse({ ...tarea, config: { titulo: "" } }).success).toBe(false);
  });

  it("el disparo por tiempo exige horas y no admite WhatsApp", () => {
    expect(automatizacionSchema.safeParse({ ...tarea, evento: "tiempo_en_etapa" }).success).toBe(false);
    expect(
      automatizacionSchema.safeParse({ ...tarea, evento: "tiempo_en_etapa", config: { titulo: "x", horas: 24 } }).success,
    ).toBe(true);
    expect(
      automatizacionSchema.safeParse({ tipo: "whatsapp", nombre: "n", evento: "tiempo_en_etapa", config: { horas: 5 } }).success,
    ).toBe(false);
  });

  it("una pregunta de opción necesita al menos dos opciones", () => {
    const pregunta = { tipo: "pregunta", nombre: "p", config: { texto: "¿?", tipo_respuesta: "opcion", opciones: ["solo una"] } };
    expect(automatizacionSchema.safeParse(pregunta).success).toBe(false);
  });

  it("una respuesta de fecha solo se guarda en una columna de fecha, y viceversa", () => {
    const base = { tipo: "pregunta", nombre: "p" };
    const config = (tipo_respuesta: string, campo_destino: string) => ({ ...base, config: { texto: "?", tipo_respuesta, campo_destino } });
    expect(automatizacionSchema.safeParse(config("fecha", "comentarios")).success).toBe(false);
    expect(automatizacionSchema.safeParse(config("texto", "fecha_compra")).success).toBe(false);
    expect(automatizacionSchema.safeParse(config("fecha", "fecha_compra")).success).toBe(true);
  });
});

describe("permisos por ejecutivo", () => {
  it("un asesor con ejecutivo asignado queda restringido; admin y asesor sin ejecutivo, no", () => {
    expect(ejecutivoRestringido({ rol: "asesor", ejecutivo_asignado: "Ana" })).toBe("Ana");
    expect(ejecutivoRestringido({ rol: "admin", ejecutivo_asignado: "Ana" })).toBeNull();
    expect(ejecutivoRestringido({ rol: "asesor", ejecutivo_asignado: null })).toBeNull();
    expect(ejecutivoRestringido(undefined)).toBeNull();
  });

  it("puedeTocar compara con el dueño", () => {
    const asesor = { rol: "asesor", ejecutivo_asignado: "Ana" };
    expect(puedeTocar(asesor, "Ana")).toBe(true);
    expect(puedeTocar(asesor, "Beto")).toBe(false);
    expect(puedeTocar(asesor, null)).toBe(false);
    expect(puedeTocar({ rol: "admin", ejecutivo_asignado: null }, "Beto")).toBe(true);
  });

  it("esUuid rechaza lo que no es un uuid", () => {
    expect(esUuid("3393d1c7-ae81-4617-990b-e5bc70fa5ca3")).toBe(true);
    expect(esUuid("123")).toBe(false);
    expect(esUuid("'; drop table x; --")).toBe(false);
  });
});

describe("validarFechaCoherente", () => {
  it("rechaza formatos raros, fechas inexistentes, antiguas y futuras", () => {
    expect(validarFechaCoherente("2026/01/01", "x")).not.toBeNull();
    expect(validarFechaCoherente("2026-02-31", "x")).not.toBeNull();
    expect(validarFechaCoherente("1999-12-31", "x")).not.toBeNull();
    expect(validarFechaCoherente("2099-01-01", "x")).not.toBeNull();
    expect(validarFechaCoherente("2026-02-10", "x")).toBeNull();
  });
});
