import { describe, expect, it } from "vitest";
import { construirDonde, type CampoEntidad } from "../lib/entidades.js";

const campo = (nombre: string, tipo: CampoEntidad["tipo"] = "texto"): CampoEntidad => ({
  nombre_tecnico: nombre,
  nombre_visible: nombre,
  tipo,
  longitud: null,
  requerido: false,
  origen: "api",
});

const todas = [campo("cliente"), campo("estado_fuente"), campo("etapa_embudo"), campo("kilometraje", "entero")];
const tarjeta = [campo("cliente"), campo("etapa_embudo")]; // el embudo pide solo estas

// «Activa»: el botón principal del panel filtra por Estado fuente.
const activa = { columna: "estado_fuente", valores: ["ACTIVA"] };

describe("construirDonde: filtros y columnas pedidas", () => {
  it("la tabla filtra por una columna que sí pide", () => {
    const r = construirDonde(todas, { filtros: [activa] });
    expect("error" in r).toBe(false);
  });

  it("regresión: el embudo pide pocas columnas y aun así debe poder filtrar por «Activa»", () => {
    // Sin camposFiltro esto fallaba con «No se puede filtrar por 'estado_fuente'» (el embudo respondía 500).
    expect(construirDonde(tarjeta, { filtros: [activa] })).toEqual({ error: "No se puede filtrar por 'estado_fuente'." });
    const r = construirDonde(tarjeta, { filtros: [activa], camposFiltro: todas });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.sql).toContain('"estado_fuente"');
  });

  it("un filtro por una columna que no existe sigue rechazándose aunque haya camposFiltro", () => {
    expect(construirDonde(tarjeta, { filtros: [{ columna: "no_existe", valores: ["x"] }], camposFiltro: todas })).toEqual({ error: "No se puede filtrar por 'no_existe'." });
  });

  it("la búsqueda con camposFiltro recorre las mismas columnas que la tabla", () => {
    const r = construirDonde(tarjeta, { busquedas: ["versa"], camposFiltro: todas });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.sql).toContain('"estado_fuente"::text ILIKE');
      expect(r.sql).toContain('"kilometraje"::text ILIKE');
    }
  });

  it("sin camposFiltro todo funciona como antes", () => {
    const r = construirDonde(tarjeta, { busquedas: ["versa"] });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.sql).not.toContain('"estado_fuente"');
  });

  it("los valores van siempre como parámetros, nunca dentro del SQL", () => {
    const r = construirDonde(todas, { filtros: [{ columna: "estado_fuente", valores: ["ACTIVA'; DROP TABLE x;--"] }] });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.sql).not.toContain("DROP");
      expect(JSON.stringify(r.params)).toContain("drop table x");
    }
  });
});
