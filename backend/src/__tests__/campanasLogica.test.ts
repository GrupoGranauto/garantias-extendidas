import { describe, expect, it } from "vitest";
import {
  aMinutos,
  calcularProgramacion,
  decidirEnvio,
  dentroDeVentana,
  diaSemana,
  esPeticionDeBaja,
  proximoDiaPermitido,
  siguienteApertura,
  sumarDias,
  telefono10,
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
  oportunidad: { campana: "5M", campanaEsperada: "5M", estadoCartera: "ACTIVA", estado: "abierta", etapa: "Por contactar" },
  contacto: { baja: false, telefono10: "6621234567", tieneCelular: true },
  paso: { etapas: [], soloSinRespuesta: false, soloSinContacto: false },
  respondio: false,
  yaContactado: false,
  enviadoRecienteOtraCampana: false,
  whatsappListo: true,
  plantillaDisponible: true,
  ...extra,
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
