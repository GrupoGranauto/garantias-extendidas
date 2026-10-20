import { describe, expect, it } from "vitest";
import { nombrePilaDe } from "../lib/nombrePila.js";

describe("nombre para saludar sacado del nombre completo", () => {
  it("toma el primer nombre después de los dos apellidos", () => {
    expect(nombrePilaDe("Romero Perez Rafael")).toBe("Rafael");
    expect(nombrePilaDe("Diaz Gutierrez Luis Angel")).toBe("Luis");
    expect(nombrePilaDe("Sanchez Romo Rosa Isela")).toBe("Rosa");
  });
  it("deja completos los nombres que se usan compuestos", () => {
    expect(nombrePilaDe("Aguilar Chon Maria Jose")).toBe("Maria Jose");
    expect(nombrePilaDe("Castillo Robles Jose Luis")).toBe("Jose Luis");
    expect(nombrePilaDe("Tellez Barraza Maria De Los Angeles")).toBe("Maria de los Angeles");
    expect(nombrePilaDe("Rodriguez Valenzuela Maria Del Rosario")).toBe("Maria del Rosario");
    expect(nombrePilaDe("Lopez Soto Ma. Guadalupe")).toBe("Maria Guadalupe");
    expect(nombrePilaDe("Valenzuela Cazares Mariela Del Carmen")).toBe("Mariela");
  });
  it("respeta los apellidos con partículas y salta las iniciales", () => {
    expect(nombrePilaDe("De Los Reyes Melendrez Gladys")).toBe("Gladys");
    expect(nombrePilaDe("Zarate Torres J. Natividad")).toBe("Natividad");
  });
  it("acepta espacios especiales y ajusta mayúsculas sin agregar acentos", () => {
    expect(nombrePilaDe("Romero\u00a0Perez\u00a0Rafael")).toBe("Rafael");
    expect(nombrePilaDe("ROMERO PEREZ MARIA DEL CARMEN")).toBe("Maria del Carmen");
  });
  it("no adivina: empresas, nombres cortos o raros quedan vacíos", () => {
    expect(nombrePilaDe("Nr Finance Mexico")).toBeNull();
    expect(nombrePilaDe("Vinos Y Licores Tonys")).toBeNull();
    expect(nombrePilaDe("Rojo Desarrolladora Y Residencial")).toBeNull();
    expect(nombrePilaDe("Superacion Integral De Guaymas Manos Amigas")).toBeNull();
    expect(nombrePilaDe("Ab&C Leasing De Mexico")).toBeNull();
    expect(nombrePilaDe("Rancho El 17")).toBeNull();
    expect(nombrePilaDe("Angel Ramos")).toBeNull();
    expect(nombrePilaDe("Sin Factura")).toBeNull();
    expect(nombrePilaDe("")).toBeNull();
    expect(nombrePilaDe(null)).toBeNull();
  });
});
