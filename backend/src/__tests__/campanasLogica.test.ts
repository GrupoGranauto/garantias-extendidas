import { describe, expect, it } from "vitest";
import {
  aMinutos,
  calcularProgramacion,
  clasificarErrorMeta,
  sanearParametro,
  decidirEnvio,
  dentroDeVentana,
  diaSemana,
  esAhoraNo,
  esPeticionDeBaja,
  proximoDiaPermitido,
  siguienteApertura,
  sumarDias,
  telefono10,
  textoEntrante,
  topeEfectivo,
  type ContextoEnvio,
  type Ventana,
} from "../lib/campanasLogica.js";

const LUN_A_VIE: Ventana = { dias_semana: [1, 2, 3, 4, 5], hora_inicio: "09:00", hora_fin: "19:00" };

describe("fechas y ventana", () => {
  it("diaSemana: 1 = lunes … 7 = domingo", () => {
    expect(diaSemana("2026-10-05")).toBe(1); // lunes
    expect(diaSemana("2026-10-03")).toBe(6); // sábado
    expect(diaSemana("2026-10-04")).toBe(7); // domingo
  });

  it("sumarDias cruza meses y años", () => {
    expect(sumarDias("2026-10-31", 1)).toBe("2026-11-01");
    expect(sumarDias("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("proximoDiaPermitido salta los días que no se envían", () => {
    expect(proximoDiaPermitido("2026-10-03", [1, 2, 3, 4, 5])).toBe("2026-10-05"); // sábado → lunes
    expect(proximoDiaPermitido("2026-10-05", [1, 2, 3, 4, 5])).toBe("2026-10-05");
  });

  it("calcularProgramacion: días después, hora pedida y ajuste a la ventana", () => {
    // Campaña empieza el jueves 1 oct; paso 0 a las 10:30 → ese jueves.
    expect(calcularProgramacion("2026-10-01", 0, "10:30", LUN_A_VIE)).toEqual({ fecha: "2026-10-01", hora: "10:30" });
    // 2 días después cae en sábado → pasa al lunes.
    expect(calcularProgramacion("2026-10-01", 2, "10:30", LUN_A_VIE)).toEqual({ fecha: "2026-10-05", hora: "10:30" });
    // Sin hora: al abrir la ventana. Hora fuera de ventana: se ajusta.
    expect(calcularProgramacion("2026-10-01", 0, null, LUN_A_VIE).hora).toBe("09:00");
    expect(calcularProgramacion("2026-10-01", 0, "07:00", LUN_A_VIE).hora).toBe("09:00");
    expect(calcularProgramacion("2026-10-01", 0, "22:00", LUN_A_VIE).hora).toBe("18:59");
  });

  it("dentroDeVentana respeta día y horas (fin exclusivo)", () => {
    expect(dentroDeVentana({ fecha: "2026-10-05", minutos: aMinutos("09:00") }, LUN_A_VIE)).toBe(true);
    expect(dentroDeVentana({ fecha: "2026-10-05", minutos: aMinutos("19:00") }, LUN_A_VIE)).toBe(false);
    expect(dentroDeVentana({ fecha: "2026-10-05", minutos: aMinutos("08:59") }, LUN_A_VIE)).toBe(false);
    expect(dentroDeVentana({ fecha: "2026-10-03", minutos: aMinutos("12:00") }, LUN_A_VIE)).toBe(false); // sábado
  });

  it("siguienteApertura: hoy si aún no abre; si no, el siguiente día permitido", () => {
    expect(siguienteApertura({ fecha: "2026-10-05", minutos: aMinutos("07:00") }, LUN_A_VIE)).toEqual({ fecha: "2026-10-05", hora: "09:00" });
    expect(siguienteApertura({ fecha: "2026-10-05", minutos: aMinutos("20:00") }, LUN_A_VIE)).toEqual({ fecha: "2026-10-06", hora: "09:00" });
    expect(siguienteApertura({ fecha: "2026-10-09", minutos: aMinutos("20:00") }, LUN_A_VIE)).toEqual({ fecha: "2026-10-12", hora: "09:00" }); // viernes → lunes
  });
});

describe("telefono10 y bajas", () => {
  it("toma los últimos 10 dígitos o devuelve null", () => {
    expect(telefono10("+52 1 (662) 123-4567")).toBe("6621234567");
    expect(telefono10("123")).toBeNull();
    expect(telefono10(null)).toBeNull();
  });

  it("detecta peticiones de baja claras y nada más", () => {
    expect(esPeticionDeBaja("BAJA")).toBe(true);
    expect(esPeticionDeBaja("  Stop. ")).toBe(true);
    expect(esPeticionDeBaja("No más")).toBe(true);
    expect(esPeticionDeBaja("quiero la baja de mi garantía actual")).toBe(false);
    expect(esPeticionDeBaja("hola")).toBe(false);
  });

  it("«Ahora no» pausa la campaña pero NO es baja", () => {
    expect(esAhoraNo("Ahora no")).toBe(true);
    expect(esAhoraNo(" ahorita NO. ")).toBe(true);
    expect(esAhoraNo("No me interesa")).toBe(true);
    expect(esAhoraNo(textoEntrante({ type: "button", button: { text: "Ahora no" } })!)).toBe(true);
    expect(esPeticionDeBaja("Ahora no")).toBe(false);
    expect(esAhoraNo("Baja")).toBe(false);
    expect(esAhoraNo("ahora no puedo, mañana te marco")).toBe(false);
    expect(esAhoraNo("Quiero informes")).toBe(false);
  });
});

/** Contexto base en el que SÍ se envía; cada prueba rompe una sola cosa. */
const base = (extra: Partial<ContextoEnvio> = {}): ContextoEnvio => ({
  ahora: { fecha: "2026-10-05", minutos: aMinutos("11:00") }, // lunes 11:00
  ahoraMs: Date.parse("2026-10-05T18:00:00Z"),
  programadoMs: Date.parse("2026-10-05T17:00:00Z"),
  motivoPrevio: null,
  vigenciaDias: 2,
  configActiva: true,
  ventana: LUN_A_VIE,
  maxPorDia: 100,
  enviadosHoy: 0,
  oportunidad: { campana: "5M", campanaEsperada: "5M", estadoCartera: "ACTIVA", estado: "abierta", etapa: "Por contactar", agencia: "Navojoa" },
  pilotoAgencias: [],
  contacto: { baja: false, telefono10: "6621234567", tieneCelular: true },
  paso: { etapas: [], soloSinRespuesta: false, soloSinContacto: false },
  respondio: false,
  yaContactado: false,
  resultadoBdc: "PENDIENTE",
  enviadoRecienteOtraCampana: false,
  telefonoConMensajeHoy: false,
  whatsappListo: true,
  plantillaDisponible: true,
  ...extra,
});

describe("clasificarErrorMeta", () => {
  it("límites de velocidad y fallas del servidor se reintentan", () => {
    expect(clasificarErrorMeta(429, null)).toBe("reintentar");
    expect(clasificarErrorMeta(500, null)).toBe("reintentar");
    expect(clasificarErrorMeta(503, null)).toBe("reintentar");
    expect(clasificarErrorMeta(400, 130429)).toBe("reintentar"); // exceso de velocidad
    expect(clasificarErrorMeta(400, 131056)).toBe("reintentar"); // demasiados mensajes al mismo par
  });
  it("los rechazos de Meta no se reintentan", () => {
    expect(clasificarErrorMeta(400, 131026)).toBe("definitivo"); // no se pudo entregar (sin WhatsApp)
    expect(clasificarErrorMeta(400, 131049)).toBe("definitivo"); // límite de marketing por persona
    expect(clasificarErrorMeta(400, 132001)).toBe("definitivo"); // la plantilla no existe
    expect(clasificarErrorMeta(400, 132000)).toBe("definitivo"); // parámetros que no coinciden
    expect(clasificarErrorMeta(401, 190)).toBe("definitivo"); // token vencido
    expect(clasificarErrorMeta(404, null)).toBe("definitivo");
  });
});

describe("sanearParametro", () => {
  it("quita saltos de línea y tabuladores y compacta espacios (Meta los rechaza)", () => {
    expect(sanearParametro("Navojoa\nCentro")).toBe("Navojoa Centro");
    expect(sanearParametro("  Versa   Advance\t2026 ")).toBe("Versa Advance 2026");
    expect(sanearParametro("a\r\n\r\nb")).toBe("a b");
  });
  it("un valor vacío o solo de espacios queda vacío", () => {
    expect(sanearParametro("   ")).toBe("");
    expect(sanearParametro("")).toBe("");
  });
});

describe("textoEntrante (botones de respuesta rápida)", () => {
  it("texto normal", () => {
    expect(textoEntrante({ type: "text", text: { body: "hola" } })).toBe("hola");
  });
  it("botón de una plantilla: usa el texto del botón", () => {
    expect(textoEntrante({ type: "button", button: { text: "Baja", payload: "x" } })).toBe("Baja");
    expect(textoEntrante({ type: "button", button: { payload: "baja" } })).toBe("baja");
  });
  it("mensaje interactivo: el título del botón o de la lista", () => {
    expect(textoEntrante({ type: "interactive", interactive: { button_reply: { title: "Quiero informes" } } })).toBe("Quiero informes");
    expect(textoEntrante({ type: "interactive", interactive: { list_reply: { title: "Otro" } } })).toBe("Otro");
  });
  it("fotos, ubicaciones y demás no son texto", () => {
    expect(textoEntrante({ type: "image" })).toBeNull();
    expect(textoEntrante({ type: "location" })).toBeNull();
  });
  it("el botón «Baja» es una petición de baja y «Quiero informes» no", () => {
    expect(esPeticionDeBaja(textoEntrante({ type: "button", button: { text: "Baja" } })!)).toBe(true);
    expect(esPeticionDeBaja(textoEntrante({ type: "button", button: { text: "Quiero informes" } })!)).toBe(false);
  });
});

describe("topeEfectivo (rampa)", () => {
  const rampa = { activa: true, inicial: 20, incremento: 30 };
  it("sin rampa vale el tope diario", () => {
    expect(topeEfectivo({ maxPorDia: 100, rampa: { ...rampa, activa: false }, diasDesdePrimerEnvio: 5 })).toBe(100);
  });
  it("arranca en el valor inicial, antes y el día del primer envío", () => {
    expect(topeEfectivo({ maxPorDia: 100, rampa, diasDesdePrimerEnvio: null })).toBe(20);
    expect(topeEfectivo({ maxPorDia: 100, rampa, diasDesdePrimerEnvio: 0 })).toBe(20);
  });
  it("sube cada día y se detiene en el tope diario", () => {
    expect(topeEfectivo({ maxPorDia: 100, rampa, diasDesdePrimerEnvio: 1 })).toBe(50);
    expect(topeEfectivo({ maxPorDia: 100, rampa, diasDesdePrimerEnvio: 2 })).toBe(80);
    expect(topeEfectivo({ maxPorDia: 100, rampa, diasDesdePrimerEnvio: 3 })).toBe(100);
    expect(topeEfectivo({ maxPorDia: 100, rampa, diasDesdePrimerEnvio: 30 })).toBe(100);
  });
  it("el valor inicial nunca pasa del tope diario", () => {
    expect(topeEfectivo({ maxPorDia: 10, rampa, diasDesdePrimerEnvio: 0 })).toBe(10);
  });
  it("un incremento de 0 mantiene el valor inicial", () => {
    expect(topeEfectivo({ maxPorDia: 100, rampa: { ...rampa, incremento: 0 }, diasDesdePrimerEnvio: 9 })).toBe(20);
  });
});

describe("resultado BDC y un mensaje por teléfono al día", () => {
  it("un lead marcado NO CONTACTABLE ya no recibe mensajes de esa campaña", () => {
    expect(decidirEnvio(base({ resultadoBdc: "NO CONTACTABLE" }))).toEqual({ accion: "omitir", motivo: "no_contactable" });
  });
  it("un número equivocado o inválido (contacto «no contactable») ya no recibe mensajes", () => {
    const oportunidad = { ...base().oportunidad, estadoContacto: "no_contactable" };
    expect(decidirEnvio(base({ oportunidad }))).toEqual({ accion: "omitir", motivo: "no_contactable" });
    expect(decidirEnvio(base({ oportunidad: { ...oportunidad, estadoContacto: "intentando" } }))).toEqual({ accion: "enviar" });
  });
  it("lo que el BDC ya trabajó cuenta como contacto para los pasos «si no lo han contactado»", () => {
    const paso = { etapas: [], soloSinRespuesta: false, soloSinContacto: true };
    expect(decidirEnvio(base({ paso, resultadoBdc: "INTERESADO" }))).toEqual({ accion: "omitir", motivo: "ya_contactado" });
    expect(decidirEnvio(base({ paso, resultadoBdc: "BUZON" }))).toEqual({ accion: "enviar" });
    expect(decidirEnvio(base({ paso, resultadoBdc: "PENDIENTE" }))).toEqual({ accion: "enviar" });
  });
  it("«solicita info por WhatsApp» cuenta como respuesta", () => {
    const paso = { etapas: [], soloSinRespuesta: true, soloSinContacto: false };
    expect(decidirEnvio(base({ paso, resultadoBdc: "SOLICITA INFO WHATSAPP" }))).toEqual({ accion: "omitir", motivo: "respondio" });
  });
  it("si ese teléfono ya recibió un mensaje hoy, espera al día siguiente", () => {
    expect(decidirEnvio(base({ telefonoConMensajeHoy: true }))).toEqual({ accion: "posponer", motivo: "un_mensaje_por_dia", hasta: "dia_siguiente" });
  });
  it("si la vigencia vence esperando, se omite con ese motivo", () => {
    const vencido = base({
      telefonoConMensajeHoy: true,
      motivoPrevio: "un_mensaje_por_dia",
      programadoMs: Date.parse("2026-10-01T17:00:00Z"),
      ahoraMs: Date.parse("2026-10-05T18:00:00Z"),
    });
    expect(decidirEnvio(vencido)).toEqual({ accion: "omitir", motivo: "un_mensaje_por_dia" });
  });
});

describe("piloto por agencia", () => {
  it("sin piloto manda a todas las agencias", () => {
    expect(decidirEnvio(base({ pilotoAgencias: [] }))).toEqual({ accion: "enviar" });
  });
  it("con piloto manda solo a las agencias elegidas", () => {
    expect(decidirEnvio(base({ pilotoAgencias: ["Navojoa"] }))).toEqual({ accion: "enviar" });
  });
  it("fuera del piloto espera al día siguiente", () => {
    expect(decidirEnvio(base({ pilotoAgencias: ["Guaymas"] }))).toEqual({ accion: "posponer", motivo: "fuera_del_piloto", hasta: "dia_siguiente" });
  });
  it("una oportunidad sin agencia queda fuera del piloto", () => {
    const sinAgencia = base({ pilotoAgencias: ["Guaymas"], oportunidad: { ...base().oportunidad, agencia: null } });
    expect(decidirEnvio(sinAgencia)).toEqual({ accion: "posponer", motivo: "fuera_del_piloto", hasta: "dia_siguiente" });
  });
  it("si vence la vigencia sin que se amplíe el piloto, se omite con ese motivo", () => {
    const vencido = base({
      pilotoAgencias: ["Guaymas"],
      motivoPrevio: "fuera_del_piloto",
      programadoMs: Date.parse("2026-10-01T17:00:00Z"),
      ahoraMs: Date.parse("2026-10-05T18:00:00Z"),
    });
    expect(decidirEnvio(vencido)).toEqual({ accion: "omitir", motivo: "fuera_del_piloto" });
  });
  it("las omisiones definitivas pesan más que el piloto (baja, sin teléfono)", () => {
    expect(decidirEnvio(base({ pilotoAgencias: ["Guaymas"], contacto: { baja: true, telefono10: "6621234567", tieneCelular: true } }))).toEqual({ accion: "omitir", motivo: "baja" });
  });
});

describe("decidirEnvio", () => {
  it("envía cuando todo está en orden", () => {
    expect(decidirEnvio(base())).toEqual({ accion: "enviar" });
  });

  it("la baja se respeta siempre", () => {
    const d = decidirEnvio(base({ contacto: { baja: true, telefono10: "6621234567", tieneCelular: true } }));
    expect(d).toEqual({ accion: "omitir", motivo: "baja" });
  });

  it("omite si la oportunidad cambió de campaña, se cerró o ya no está abierta", () => {
    expect(decidirEnvio(base({ oportunidad: { campana: "28M", campanaEsperada: "5M", estadoCartera: "ACTIVA", estado: "abierta", etapa: null } }))).toEqual({ accion: "omitir", motivo: "ya_no_aplica" });
    expect(decidirEnvio(base({ oportunidad: { campana: "5M", campanaEsperada: "5M", estadoCartera: "YA_TIENE_GE", estado: "abierta", etapa: null } }))).toEqual({ accion: "omitir", motivo: "ya_no_aplica" });
    expect(decidirEnvio(base({ oportunidad: { campana: "5M", campanaEsperada: "5M", estadoCartera: "ACTIVA", estado: "ganada", etapa: null } }))).toEqual({ accion: "omitir", motivo: "ya_no_aplica" });
  });

  it("omite sin teléfono o con número que no es celular", () => {
    expect(decidirEnvio(base({ contacto: { baja: false, telefono10: null, tieneCelular: true } }))).toEqual({ accion: "omitir", motivo: "sin_telefono" });
    expect(decidirEnvio(base({ contacto: { baja: false, telefono10: "6621234567", tieneCelular: false } }))).toEqual({ accion: "omitir", motivo: "sin_celular" });
  });

  it("condiciones del paso: etapa, respuesta y contacto previo", () => {
    expect(decidirEnvio(base({ paso: { etapas: ["Contactado"], soloSinRespuesta: false, soloSinContacto: false } }))).toEqual({ accion: "omitir", motivo: "etapa_no_permitida" });
    expect(decidirEnvio(base({ paso: { etapas: ["Por contactar"], soloSinRespuesta: false, soloSinContacto: false } }))).toEqual({ accion: "enviar" });
    expect(decidirEnvio(base({ paso: { etapas: [], soloSinRespuesta: true, soloSinContacto: false }, respondio: true }))).toEqual({ accion: "omitir", motivo: "respondio" });
    expect(decidirEnvio(base({ paso: { etapas: [], soloSinRespuesta: false, soloSinContacto: true }, yaContactado: true }))).toEqual({ accion: "omitir", motivo: "ya_contactado" });
    // Las condiciones apagadas no estorban aunque el cliente haya respondido.
    expect(decidirEnvio(base({ respondio: true, yaContactado: true }))).toEqual({ accion: "enviar" });
  });

  it("fuera de horario pospone hasta que abra la ventana", () => {
    const noche = decidirEnvio(base({ ahora: { fecha: "2026-10-05", minutos: aMinutos("21:00") } }));
    expect(noche).toEqual({ accion: "posponer", motivo: "fuera_de_ventana", hasta: "ventana" });
    const sabado = decidirEnvio(base({ ahora: { fecha: "2026-10-03", minutos: aMinutos("11:00") } }));
    expect(sabado).toMatchObject({ accion: "posponer", motivo: "fuera_de_ventana" });
  });

  it("tope diario pospone al día siguiente", () => {
    expect(decidirEnvio(base({ enviadosHoy: 100 }))).toEqual({ accion: "posponer", motivo: "tope_diario", hasta: "dia_siguiente" });
    expect(decidirEnvio(base({ enviadosHoy: 99 }))).toEqual({ accion: "enviar" });
  });

  it("descanso entre campañas: no se escribe a la misma persona desde otra campaña dentro del periodo", () => {
    expect(decidirEnvio(base({ enviadoRecienteOtraCampana: true }))).toMatchObject({ accion: "posponer", motivo: "descanso_entre_campanas" });
  });

  it("plantilla o WhatsApp no disponibles solo hacen esperar", () => {
    expect(decidirEnvio(base({ plantillaDisponible: false }))).toMatchObject({ accion: "posponer", motivo: "plantilla_no_disponible" });
    expect(decidirEnvio(base({ whatsappListo: false }))).toMatchObject({ accion: "posponer", motivo: "whatsapp_no_configurado" });
  });

  it("campaña apagada no envía ni descarta: espera", () => {
    expect(decidirEnvio(base({ configActiva: false }))).toMatchObject({ accion: "posponer", motivo: "campana_apagada" });
  });

  it("vencida la vigencia, lo que seguía esperando se cierra con su motivo y lo enviable llega tarde", () => {
    const tarde = { ahoraMs: Date.parse("2026-10-09T18:00:00Z") };
    expect(decidirEnvio(base({ ...tarde, enviadosHoy: 100 }))).toEqual({ accion: "omitir", motivo: "tope_diario" });
    expect(decidirEnvio(base({ ...tarde, motivoPrevio: "fuera_de_ventana", plantillaDisponible: false }))).toEqual({ accion: "omitir", motivo: "fuera_de_ventana" });
    expect(decidirEnvio(base({ ...tarde }))).toEqual({ accion: "omitir", motivo: "fuera_de_vigencia" });
  });
});
