import { describe, expect, it } from "vitest";
import {
  CATALOGOS,
  efectoClasificacion,
  efectoLlamada,
  efectoRespuesta,
  esClaveDe,
  estadoOportunidad,
  fechaCapturaValida,
  normalizarLlamada,
  validarRespuesta,
} from "../lib/gestionLogica.js";
import { resultadoDeEstado } from "../lib/resultadoBdcLogica.js";

describe("catálogos de Notion", () => {
  it("tienen las opciones de la revisión, sin claves repetidas", () => {
    expect(CATALOGOS.respuesta_titular).toHaveLength(11);
    expect(CATALOGOS.motivo_no_interes).toHaveLength(6);
    expect(CATALOGOS.donde_obtuvo_ge).toHaveLength(5);
    expect(CATALOGOS.origen_venta).toHaveLength(4);
    expect(CATALOGOS.clasificacion_respuesta).toHaveLength(5);
    for (const lista of Object.values(CATALOGOS)) {
      expect(new Set(lista.map((o) => o.clave)).size).toBe(lista.length);
    }
    expect(esClaveDe("origen_venta", "BDC")).toBe(true);
    expect(esClaveDe("origen_venta", "Mostrador")).toBe(false);
  });
});

describe("resultado de una llamada", () => {
  it("acepta los códigos viejos", () => {
    expect(normalizarLlamada("contesto")).toBe("CONTESTA_TITULAR");
    expect(normalizarLlamada("no_contesto")).toBe("NO_CONTESTA");
    expect(normalizarLlamada("OCUPADO")).toBe("OCUPADO");
    expect(normalizarLlamada("otra_cosa")).toBeNull();
  });

  it("solo el titular es contacto efectivo", () => {
    expect(efectoLlamada("CONTESTA_TITULAR", "sin_intentar", "PENDIENTE")).toEqual({ contacto: "contactado", resultado: "CONTACTADO", efectivo: true });
    expect(efectoLlamada("CONTESTA_OTRA_PERSONA", "sin_intentar", "PENDIENTE")).toEqual({
      contacto: "intentando",
      resultado: "CONTACTO NO DISPONIBLE",
      efectivo: false,
    });
  });

  it("buzón, cuelga y ocupado no hacen retroceder a quien ya fue contactado", () => {
    expect(efectoLlamada("BUZON", "sin_intentar", "PENDIENTE")).toMatchObject({ contacto: "buzon", resultado: "BUZON" });
    expect(efectoLlamada("CUELGA", "contactado", "INTERESADO")).toMatchObject({ contacto: "contactado", resultado: "INTERESADO" });
    expect(efectoLlamada("OCUPADO", "buzon", "BUZON")).toMatchObject({ contacto: "intentando", resultado: "BUZON" });
  });

  it("número equivocado o inválido: no contactable, el resultado lo decide el ejecutivo", () => {
    expect(efectoLlamada("NUMERO_INVALIDO", "intentando", "CONTACTO NO DISPONIBLE")).toMatchObject({
      contacto: "no_contactable",
      resultado: "CONTACTO NO DISPONIBLE",
    });
  });

  it("una baja se respeta", () => {
    expect(efectoLlamada("CONTESTA_TITULAR", "baja", "PENDIENTE").contacto).toBe("baja");
  });
});

describe("respuesta del titular", () => {
  it("pide precio o quiere pagar → Interesado", () => {
    expect(efectoRespuesta("PIDE_PRECIO", null, "CONTACTADO").resultado).toBe("INTERESADO");
    expect(efectoRespuesta("QUIERE_PAGAR", null, "PENDIENTE").resultado).toBe("INTERESADO");
  });

  it("una respuesta positiva no hace retroceder ni toca una venta", () => {
    expect(efectoRespuesta("PIDE_INFORMACION", null, "COTIZADO").resultado).toBeNull();
    expect(efectoRespuesta("PIDE_PRECIO", null, "VENDIDO").resultado).toBeNull();
    expect(efectoRespuesta("NO_INTERESADO", "NO_LO_NECESITA", "VENDIDO").resultado).toBeNull();
  });

  it("reabre una oportunidad perdida si el titular vuelve a pedir precio", () => {
    expect(efectoRespuesta("PIDE_PRECIO", null, "NO INTERESADO").resultado).toBe("INTERESADO");
  });

  it("no interesado cierra con su motivo; por precio es «Precio fuera de presupuesto»", () => {
    expect(efectoRespuesta("NO_INTERESADO", "NO_LO_NECESITA", "CONTACTADO")).toMatchObject({ resultado: "NO INTERESADO", motivo: "no_interesado" });
    expect(efectoRespuesta("NO_INTERESADO", "PRECIO_ALTO", "INTERESADO")).toMatchObject({
      resultado: "PRECIO FUERA PRESUPUESTO",
      motivo: "precio_fuera_presupuesto",
    });
  });

  it("ya tiene GE, ya no tiene el auto, flotilla y no contactar cierran y dejan su marca", () => {
    expect(efectoRespuesta("YA_TIENE_GE", null, "CONTACTADO")).toMatchObject({ motivo: "ya_tiene_ge", marcas: { declara_ge: true } });
    expect(efectoRespuesta("YA_NO_TIENE_AUTO", null, "CONTACTADO")).toMatchObject({ motivo: "ya_no_tiene_auto", marcas: { conserva_auto: false } });
    expect(efectoRespuesta("FLOTILLA", null, "CONTACTADO").motivo).toBe("flotilla");
    expect(efectoRespuesta("NO_CONTACTAR", null, "CONTACTADO")).toMatchObject({
      resultado: "NO CONTACTABLE",
      motivo: "pidio_baja",
      marcas: { no_contactar: true },
    });
  });

  it("queja de servicio se escala a posventa", () => {
    expect(efectoRespuesta("QUEJA_SERVICIO", null, "PENDIENTE")).toMatchObject({ resultado: "CONTACTADO", marcas: { escalar_posventa: true } });
  });

  it("valida los campos condicionales", () => {
    const ahora = new Date("2026-10-09T18:00:00Z");
    const base = { motivoNoInteres: null, proximoContacto: null, comentario: null, ahora };
    expect(validarRespuesta({ ...base, respuesta: "LLAMAR_DESPUES" })).toMatch(/cuándo/);
    expect(validarRespuesta({ ...base, respuesta: "LLAMAR_DESPUES", proximoContacto: "2026-10-08T10:00:00Z" })).toMatch(/futuro/);
    expect(validarRespuesta({ ...base, respuesta: "LO_VA_A_PENSAR", proximoContacto: "2026-10-12T10:00:00Z" })).toBeNull();
    expect(validarRespuesta({ ...base, respuesta: "NO_INTERESADO" })).toMatch(/motivo/);
    expect(validarRespuesta({ ...base, respuesta: "NO_INTERESADO", motivoNoInteres: "OTRO" })).toMatch(/comentario/);
    expect(validarRespuesta({ ...base, respuesta: "NO_INTERESADO", motivoNoInteres: "OTRO", comentario: "Se muda" })).toBeNull();
    expect(validarRespuesta({ ...base, respuesta: "PIDE_PRECIO" })).toBeNull();
  });

  it("perdido por baja conserva «NO CONTACTABLE» al ajustar resultados", () => {
    expect(resultadoDeEstado("perdido", "pidio_baja", "NO INTERESADO")).toBe("NO CONTACTABLE");
    expect(resultadoDeEstado("perdido", "ya_tiene_ge", "CONTACTADO")).toBe("NO INTERESADO");
  });
});

describe("clasificación de la respuesta y estado calculado", () => {
  it("clasificación", () => {
    expect(efectoClasificacion("TITULAR")).toEqual({ efectivo: true, noContactar: false, numeroEquivocado: false });
    expect(efectoClasificacion("BAJA").noContactar).toBe(true);
    expect(efectoClasificacion("SPAM")).toEqual({ efectivo: false, noContactar: false, numeroEquivocado: false });
  });

  it("estado de la oportunidad", () => {
    const base = { estado: "abierta", estadoContacto: "contactado", noContactar: false, estadoCartera: "ACTIVA" };
    expect(estadoOportunidad(base)).toBe("Abierta");
    expect(estadoOportunidad({ ...base, estadoCartera: "FUERA_DE_VENTANA" })).toBe("Expirada");
    expect(estadoOportunidad({ ...base, estado: "ganada", estadoCartera: "FUERA_DE_VENTANA" })).toBe("Ganada");
    expect(estadoOportunidad({ ...base, estado: "perdida" })).toBe("Perdida");
    expect(estadoOportunidad({ ...base, estado: "perdida", noContactar: true })).toBe("Baja");
    expect(estadoOportunidad({ ...base, estado: "ganada", noContactar: true })).toBe("Ganada");
  });
});

describe("fechas capturadas a mano", () => {
  it("solo días reales, desde el 2000 y no a futuro", () => {
    const hoy = "2026-10-09";
    expect(fechaCapturaValida("2026-10-09", hoy)).toBe(true);
    expect(fechaCapturaValida("2024-02-29", hoy)).toBe(true);
    expect(fechaCapturaValida("0002-10-05", hoy)).toBe(false);
    expect(fechaCapturaValida("1999-12-31", hoy)).toBe(false);
    expect(fechaCapturaValida("2026-02-30", hoy)).toBe(false);
    expect(fechaCapturaValida("2026-10-10", hoy)).toBe(false);
    expect(fechaCapturaValida("10/09/2026", hoy)).toBe(false);
  });
});
