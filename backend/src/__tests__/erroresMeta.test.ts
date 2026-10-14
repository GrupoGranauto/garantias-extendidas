import { describe, expect, it } from "vitest";
import { motivoFallaWhatsApp } from "../lib/erroresMeta.js";

describe("motivo de falla de WhatsApp en español", () => {
  it("traduce por el código de Meta", () => {
    expect(motivoFallaWhatsApp(131049, "This message was not delivered to maintain healthy ecosystem engagement.")).toMatch(/no saturar/);
    expect(motivoFallaWhatsApp(131050, "x")).toMatch(/no recibir mensajes de marketing/);
    expect(motivoFallaWhatsApp(131042, null)).toMatch(/método de pago/);
  });

  it("sin código, reconoce el texto en inglés que ya estaba guardado", () => {
    expect(motivoFallaWhatsApp(null, "This message was not delivered to maintain healthy ecosystem engagement.")).toMatch(/no saturar/);
    expect(motivoFallaWhatsApp(null, "Message undeliverable.")).toMatch(/no tiene WhatsApp/);
    expect(motivoFallaWhatsApp(undefined, "Re-engagement message")).toMatch(/24 horas/);
  });

  it("lo que no reconoce (o ya está en español) lo deja igual", () => {
    expect(motivoFallaWhatsApp(null, "No se pudo contactar a WhatsApp (ETIMEDOUT)")).toBe("No se pudo contactar a WhatsApp (ETIMEDOUT)");
    expect(motivoFallaWhatsApp(999999, "Some new error")).toBe("Some new error");
    expect(motivoFallaWhatsApp(null, null)).toBeNull();
  });
});
