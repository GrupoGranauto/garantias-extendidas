import { describe, expect, it } from "vitest";
import { DESTINO_DE_RESULTADO, RESULTADOS_BDC, esResultadoBdc, resultadoDeEstado } from "../lib/resultadoBdcLogica.js";

describe("Resultado BDC", () => {
  it("tiene los 12 valores del Sheet y cada uno lleva a un estado del lead", () => {
    expect(RESULTADOS_BDC).toHaveLength(12);
    for (const r of RESULTADOS_BDC) expect(DESTINO_DE_RESULTADO[r].etapa).toBeTruthy();
    expect(esResultadoBdc("COTIZADO")).toBe(true);
    expect(esResultadoBdc("cotizado")).toBe(false);
  });

  it("los perdidos llevan su motivo de pérdida", () => {
    expect(DESTINO_DE_RESULTADO["NO INTERESADO"]).toMatchObject({ etapa: "perdido", motivo: "no_interesado" });
    expect(DESTINO_DE_RESULTADO["PRECIO FUERA PRESUPUESTO"]).toMatchObject({ etapa: "perdido", motivo: "precio_fuera_presupuesto" });
    expect(DESTINO_DE_RESULTADO["NO CONTACTABLE"]).toMatchObject({ etapa: "perdido", motivo: "no_contactable", contacto: "no_contactable" });
  });

  it("mover la tarjeta pone el resultado base del estado", () => {
    expect(resultadoDeEstado("contactado", null, "PENDIENTE")).toBe("CONTACTADO");
    expect(resultadoDeEstado("cotizado", null, "INTERESADO")).toBe("COTIZADO");
    expect(resultadoDeEstado("por_contactar", null, "CONTACTADO")).toBe("PENDIENTE");
    expect(resultadoDeEstado("vendido", null, "COTIZADO")).toBe("VENDIDO");
  });

  it("si el resultado ya era de ese estado, se respeta", () => {
    expect(resultadoDeEstado("por_contactar", null, "BUZON")).toBe("BUZON");
    expect(resultadoDeEstado("contactado", null, "SOLICITA INFO WHATSAPP")).toBe("SOLICITA INFO WHATSAPP");
    expect(resultadoDeEstado("interesado", null, "PENDIENTE DECISION TERCERO")).toBe("PENDIENTE DECISION TERCERO");
  });

  it("en perdido, el motivo decide el resultado", () => {
    expect(resultadoDeEstado("perdido", "no_contactable", "PENDIENTE")).toBe("NO CONTACTABLE");
    expect(resultadoDeEstado("perdido", "precio_fuera_presupuesto", "COTIZADO")).toBe("PRECIO FUERA PRESUPUESTO");
    expect(resultadoDeEstado("perdido", "otro", "COTIZADO")).toBe("NO INTERESADO");
    expect(resultadoDeEstado("perdido", "no_interesado", "PRECIO FUERA PRESUPUESTO")).toBe("NO INTERESADO");
    expect(resultadoDeEstado("perdido", null, "PRECIO FUERA PRESUPUESTO")).toBe("PRECIO FUERA PRESUPUESTO");
  });

  it("un estado que no es del Sheet deja el resultado como estaba", () => {
    expect(resultadoDeEstado("en_negociacion", null, "INTERESADO")).toBe("INTERESADO");
  });

});
