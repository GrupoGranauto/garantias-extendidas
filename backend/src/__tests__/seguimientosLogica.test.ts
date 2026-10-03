import { describe, expect, it } from "vitest";
import {
  calcularVencimiento,
  evaluarCondicion,
  evaluarCondiciones,
  fechaLocal,
  rellenarTexto,
  validarCondiciones,
  validarSeguimiento,
  type Condicion,
  type SeguimientoEntrada,
  type TipoCampo,
} from "../lib/seguimientosLogica.js";

const tipos: Record<string, TipoCampo> = {
  etapa_embudo: "texto",
  ejecutivo: "texto",
  kilometraje: "entero",
  intentos: "entero",
  fecha_ultimo_contacto: "fecha",
  entro_a_etapa_en: "fecha_hora",
  tiene_celular: "booleano",
  respondio_whatsapp: "booleano",
};
const c = (campo: string, operador: Condicion["operador"], valor = ""): Condicion => ({ campo, operador, valor });

describe("condiciones de texto", () => {
  it("igual ignora mayúsculas, acentos y espacios", () => {
    expect(evaluarCondicion(c("etapa_embudo", "igual", "por contactar"), "texto", "Por Contactar ")).toBe(true);
    expect(evaluarCondicion(c("etapa_embudo", "igual", "Interesado"), "texto", "Por contactar")).toBe(false);
    expect(evaluarCondicion(c("ejecutivo", "igual", "maria jose nunez"), "texto", "María José Nuñez")).toBe(true);
  });
  it("distinto y contiene", () => {
    expect(evaluarCondicion(c("etapa_embudo", "distinto", "Perdido"), "texto", "Contactado")).toBe(true);
    expect(evaluarCondicion(c("ejecutivo", "contiene", "jose"), "texto", "María José Nuñez")).toBe(true);
    expect(evaluarCondicion(c("ejecutivo", "contiene", "pedro"), "texto", "María José Nuñez")).toBe(false);
  });
  it("vacío y no vacío cuentan null, indefinido y espacios como vacío", () => {
    expect(evaluarCondicion(c("ejecutivo", "vacio"), "texto", null)).toBe(true);
    expect(evaluarCondicion(c("ejecutivo", "vacio"), "texto", "   ")).toBe(true);
    expect(evaluarCondicion(c("ejecutivo", "no_vacio"), "texto", "Ana")).toBe(true);
    expect(evaluarCondicion(c("ejecutivo", "no_vacio"), "texto", undefined)).toBe(false);
  });
});

describe("condiciones numéricas", () => {
  it("compara como números", () => {
    expect(evaluarCondicion(c("kilometraje", "mayor", "9000"), "entero", 10000)).toBe(true);
    expect(evaluarCondicion(c("kilometraje", "menor", "9000"), "entero", 10000)).toBe(false);
    expect(evaluarCondicion(c("intentos", "igual", "2"), "entero", "2")).toBe(true);
  });
  it("un valor ausente no es mayor ni menor, pero sí es distinto", () => {
    expect(evaluarCondicion(c("kilometraje", "mayor", "0"), "entero", null)).toBe(false);
    expect(evaluarCondicion(c("kilometraje", "distinto", "5"), "entero", null)).toBe(true);
    expect(evaluarCondicion(c("kilometraje", "vacio"), "entero", null)).toBe(true);
  });
});

describe("condiciones de fecha", () => {
  it("compara fechas", () => {
    expect(evaluarCondicion(c("fecha_ultimo_contacto", "mayor", "2026-10-01"), "fecha", "2026-10-03")).toBe(true);
    expect(evaluarCondicion(c("fecha_ultimo_contacto", "menor", "2026-10-01"), "fecha", "2026-10-03")).toBe(false);
    expect(evaluarCondicion(c("fecha_ultimo_contacto", "igual", "2026-10-03"), "fecha", "2026-10-03")).toBe(true);
  });
  it("una fecha-hora se compara por su día en Hermosillo", () => {
    // 02:00 UTC del 4 de octubre son las 19:00 del 3 en Hermosillo.
    expect(fechaLocal("2026-10-04T02:00:00Z")).toBe("2026-10-03");
    expect(evaluarCondicion(c("entro_a_etapa_en", "igual", "2026-10-03"), "fecha_hora", "2026-10-04T02:00:00Z")).toBe(true);
  });
  it("sin fecha no cumple igual, mayor ni menor", () => {
    expect(evaluarCondicion(c("fecha_ultimo_contacto", "mayor", "2026-10-01"), "fecha", null)).toBe(false);
  });
});

describe("condiciones sí/no", () => {
  it("respondió = no", () => {
    expect(evaluarCondicion(c("respondio_whatsapp", "igual", "false"), "booleano", false)).toBe(true);
    expect(evaluarCondicion(c("respondio_whatsapp", "igual", "false"), "booleano", true)).toBe(false);
    expect(evaluarCondicion(c("respondio_whatsapp", "igual", "true"), "booleano", true)).toBe(true);
  });
  it("un dato desconocido no cumple ni sí ni no", () => {
    expect(evaluarCondicion(c("tiene_celular", "igual", "true"), "booleano", null)).toBe(false);
    expect(evaluarCondicion(c("tiene_celular", "igual", "false"), "booleano", null)).toBe(false);
  });
});

describe("todas las condiciones juntas", () => {
  const fila = { etapa_embudo: "Por contactar", respondio_whatsapp: false, kilometraje: 12000 };
  it("sin condiciones siempre cumple", () => {
    expect(evaluarCondiciones([], fila, tipos).cumple).toBe(true);
  });
  it("exige todas y avisa cuál falló", () => {
    const ok = evaluarCondiciones([c("etapa_embudo", "igual", "Por contactar"), c("respondio_whatsapp", "igual", "false")], fila, tipos);
    expect(ok.cumple).toBe(true);
    const mal = evaluarCondiciones([c("etapa_embudo", "igual", "Por contactar"), c("kilometraje", "menor", "10000")], fila, tipos);
    expect(mal.cumple).toBe(false);
    expect(mal.falla?.campo).toBe("kilometraje");
  });
  it("una columna que no existe no se cumple (más vale omitir que mandar a quien no debía)", () => {
    expect(evaluarCondiciones([c("columna_fantasma", "igual", "x")], fila, { ...tipos, columna_fantasma: "texto" }).cumple).toBe(false);
    expect(evaluarCondiciones([c("sin_tipo", "igual", "x")], { sin_tipo: "x" }, tipos).cumple).toBe(false);
  });
});

describe("validación de condiciones", () => {
  it("acepta lo correcto", () => {
    expect(validarCondiciones([c("etapa_embudo", "igual", "Interesado"), c("ejecutivo", "vacio")], tipos)).toBeNull();
  });
  it("rechaza columnas inexistentes, operadores que no aplican y valores vacíos o mal formados", () => {
    expect(validarCondiciones([c("nada", "igual", "x")], tipos)).toMatch(/no existe/);
    expect(validarCondiciones([c("etapa_embudo", "mayor", "x")], tipos)).toMatch(/operador/);
    expect(validarCondiciones([c("etapa_embudo", "igual", " ")], tipos)).toMatch(/Falta el valor/);
    expect(validarCondiciones([c("kilometraje", "mayor", "abc")], tipos)).toMatch(/número/);
    expect(validarCondiciones([c("fecha_ultimo_contacto", "mayor", "hoy")], tipos)).toMatch(/fecha/);
    expect(validarCondiciones([c("respondio_whatsapp", "igual", "tal vez")], tipos)).toMatch(/Sí o No/);
  });
  it("limita a 8 condiciones", () => {
    expect(validarCondiciones(Array.from({ length: 9 }, () => c("ejecutivo", "vacio")), tipos)).toMatch(/8/);
  });
});

const base: SeguimientoEntrada = {
  nombre: "Llamar si no respondió",
  desde: "primer_envio",
  espera_horas: 48,
  accion: "llamada",
  condiciones: [],
  titulo: "Llamar a {cliente}",
  descripcion: null,
  vence_horas: 0,
  hora: "10:00",
  plantilla_id: null,
  vigencia_horas: 48,
  activa: false,
};

describe("validación del seguimiento", () => {
  it("acepta uno correcto", () => {
    expect(validarSeguimiento(base, tipos)).toBeNull();
  });
  it("exige nombre, título y, en llamadas, para cuándo", () => {
    expect(validarSeguimiento({ ...base, nombre: " " }, tipos)).toMatch(/nombre/);
    expect(validarSeguimiento({ ...base, titulo: "" }, tipos)).toMatch(/título/);
    expect(validarSeguimiento({ ...base, vence_horas: null }, tipos)).toMatch(/para cuándo/);
  });
  it("una tarea puede quedar sin fecha", () => {
    expect(validarSeguimiento({ ...base, accion: "tarea", vence_horas: null, hora: null }, tipos)).toBeNull();
  });
  it("un WhatsApp activo necesita plantilla; apagado puede esperar", () => {
    const wa = { ...base, accion: "whatsapp" as const, titulo: null };
    expect(validarSeguimiento({ ...wa, activa: true }, tipos)).toMatch(/plantilla/);
    expect(validarSeguimiento({ ...wa, activa: false }, tipos)).toBeNull();
  });
  it("revisa la espera y la hora", () => {
    expect(validarSeguimiento({ ...base, espera_horas: -1 }, tipos)).toMatch(/espera/);
    expect(validarSeguimiento({ ...base, espera_horas: 9000 }, tipos)).toMatch(/espera/);
    expect(validarSeguimiento({ ...base, hora: "25:00" }, tipos)).toMatch(/hora/);
  });
  it("revisa también las condiciones", () => {
    expect(validarSeguimiento({ ...base, condiciones: [c("nada", "igual", "x")] }, tipos)).toMatch(/no existe/);
  });
});

describe("vencimiento de tareas y llamadas", () => {
  // 2026-10-03 12:00 en Hermosillo = 19:00 UTC.
  const ahora = new Date("2026-10-03T19:00:00Z");
  it("sin horas no tiene fecha", () => {
    expect(calcularVencimiento(ahora, null, "10:00")).toBeNull();
  });
  it("solo horas: ahora más esas horas", () => {
    expect(calcularVencimiento(ahora, 5, null)?.toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });
  it("con hora: ese día a esa hora de Hermosillo", () => {
    // +24 h = 4 de octubre; a las 10:00 locales = 17:00 UTC.
    expect(calcularVencimiento(ahora, 24, "10:00")?.toISOString()).toBe("2026-10-04T17:00:00.000Z");
  });
  it("si la hora de hoy ya pasó, pasa al día siguiente", () => {
    // ahora son las 12:00 locales; hoy a las 09:00 ya pasó.
    expect(calcularVencimiento(ahora, 0, "09:00")?.toISOString()).toBe("2026-10-04T16:00:00.000Z");
    // pero hoy a las 15:00 todavía no.
    expect(calcularVencimiento(ahora, 0, "15:00")?.toISOString()).toBe("2026-10-03T22:00:00.000Z");
  });
});

describe("texto con datos del cliente", () => {
  it("rellena los marcadores conocidos y deja los demás", () => {
    expect(rellenarTexto("Llamar a {cliente} ({vin}) de {agencia}, campaña {campana}, ejecutivo {ejecutivo} {otro}", { cliente: "Ana", vin: "V1", agencia: "Navojoa", campana: "5M", ejecutivo: "Luis" })).toBe(
      "Llamar a Ana (V1) de Navojoa, campaña 5M, ejecutivo Luis {otro}",
    );
  });
});
