import { describe, expect, it } from "vitest";
import { VISTA_POR_DEFECTO, columnasDeVista, normalizarVista, vistaSchema } from "../lib/vistaTarjetaLogica.js";

const CAMPOS = ["cliente", "linea", "anio_vin", "agencia", "telefono_principal", "ejecutivo", "campana", "vin", "entro_a_etapa_en", "apv", "motivo_perdida"];

describe("normalizarVista", () => {
  it("sin configuración usa la vista por defecto", () => {
    expect(normalizarVista(null, CAMPOS)).toEqual(VISTA_POR_DEFECTO);
  });

  it("respeta lo que eligió el admin y deja vacío un lugar puesto en null", () => {
    const v = normalizarVista({ ...VISTA_POR_DEFECTO, subtitulo: null, detalle: "apv", ultimo_mensaje: true }, CAMPOS);
    expect(v.subtitulo).toBeNull();
    expect(v.detalle).toBe("apv");
    expect(v.ultimo_mensaje).toBe(true);
  });

  it("descarta campos que ya no existen en la sucursal", () => {
    const v = normalizarVista({ ...VISTA_POR_DEFECTO, arriba: "borrado", etiquetas: ["campana", "borrado", "vin"] }, CAMPOS);
    expect(v.arriba).toBeNull();
    expect(v.etiquetas).toEqual(["campana", "vin"]);
  });

  it("el nombre nunca queda vacío", () => {
    expect(normalizarVista({ titulo: "borrado" }, CAMPOS).titulo).toBe("cliente");
    expect(normalizarVista({ titulo: "borrado" }, ["linea", "vin"]).titulo).toBe("linea");
  });

  it("quita etiquetas repetidas y corta en el máximo", () => {
    const v = normalizarVista({ etiquetas: ["vin", "vin", "campana", "apv", "linea", "agencia", "ejecutivo", "cliente"] }, CAMPOS);
    expect(v.etiquetas).toEqual(["vin", "campana", "apv", "linea", "agencia", "ejecutivo"]);
  });

  it("ignora basura en las opciones", () => {
    const v = normalizarVista({ avatar: "sí", tareas: 0 }, CAMPOS);
    expect(v.avatar).toBe(true);
    expect(v.tareas).toBe(true);
  });
});

describe("columnasDeVista", () => {
  it("pide lo que se muestra más lo que usa el tablero, en el orden de la sucursal", () => {
    const v = normalizarVista({ ...VISTA_POR_DEFECTO, subtitulo: null, detalle: "apv", etiquetas: ["vin"], llamar: true }, CAMPOS);
    expect(columnasDeVista(v, CAMPOS)).toEqual(["cliente", "linea", "anio_vin", "telefono_principal", "ejecutivo", "vin", "entro_a_etapa_en", "apv", "motivo_perdida"]);
  });

  it("sin botón de llamar no pide el teléfono si no se muestra", () => {
    const v = normalizarVista({ ...VISTA_POR_DEFECTO, detalle: null, llamar: false }, CAMPOS);
    expect(columnasDeVista(v, CAMPOS)).not.toContain("telefono_principal");
  });
});

describe("vistaSchema", () => {
  it("exige un campo para el nombre", () => {
    expect(vistaSchema.safeParse({ ...VISTA_POR_DEFECTO, titulo: "" }).success).toBe(false);
  });

  it("limita las etiquetas", () => {
    expect(vistaSchema.safeParse({ ...VISTA_POR_DEFECTO, etiquetas: ["a", "b", "c", "d", "e", "f", "g"] }).success).toBe(false);
  });
});
