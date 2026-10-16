import { describe, expect, it } from "vitest";
import { elegirConversacion } from "../lib/vinculoWhatsapp.js";

const conv = (id: string, wa_id: string, ultimo_mensaje_en: string | Date | null = null) => ({ id, wa_id, ultimo_mensaje_en });

describe("elegirConversacion", () => {
  it("la del masivo (52 + 10) recibe la respuesta de Meta (521 + 10)", () => {
    const masivo = conv("a", "526621234567", "2026-10-14T18:00:00Z");
    expect(elegirConversacion([masivo], "5216621234567")).toBe(masivo);
  });

  it("prefiere la de wa_id exacto aunque haya otra más reciente del mismo teléfono", () => {
    const exacta = conv("a", "5216621234567", "2026-10-01T00:00:00Z");
    const otra = conv("b", "526621234567", "2026-10-14T00:00:00Z");
    expect(elegirConversacion([otra, exacta], "5216621234567")).toBe(exacta);
  });

  it("sin exacta, la más reciente del teléfono; las que nunca tuvieron mensaje van al final", () => {
    const vieja = conv("a", "526621234567", new Date("2026-10-01T00:00:00Z"));
    const nueva = conv("b", "+52 662 123 4567", new Date("2026-10-10T00:00:00Z"));
    const vacia = conv("c", "6621234567", null);
    expect(elegirConversacion([vieja, vacia, nueva], "5216621234567")).toBe(nueva);
    expect(elegirConversacion([vacia], "5216621234567")).toBe(vacia);
  });

  it("no cruza teléfonos distintos ni números cortos", () => {
    expect(elegirConversacion([conv("a", "526621234568")], "5216621234567")).toBeNull();
    expect(elegirConversacion([conv("a", "12345")], "012345")).toBeNull();
    expect(elegirConversacion([conv("a", "12345")], "12345")?.id).toBe("a");
    expect(elegirConversacion([], "5216621234567")).toBeNull();
  });
});
