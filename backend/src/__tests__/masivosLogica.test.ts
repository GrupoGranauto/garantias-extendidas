import { describe, expect, it } from "vitest";
import {
  clasificarDestinatarios,
  contarOmitidos,
  cubiertoPorTelefono,
  encabezadoArchivo,
  etiquetaCampana,
  indicesCuerpo,
  juntarOmitidos,
  llenarCuerpo,
  MOTIVOS_OMISION,
  motivoDelFreno,
  motivoPorPaso,
  motivoPorReglas,
  ordenCampana,
  plantillaNoUsable,
  pudoLlegar,
  reglasParaEnvio,
  SIN_REGLAS,
  TEXTO_MOTIVO,
  usoDePlantilla,
  VENTANA_COBERTURA_DIAS,
  vistaMensaje,
  type Candidato,
  type EnvioPrevio,
} from "../lib/masivosLogica.js";

const base = (extra: Partial<Candidato> = {}): Candidato => ({
  oportunidadId: "a",
  telefono: "662 123 4567",
  tieneCelular: true,
  baja: false,
  estadoContacto: "sin_intentar",
  parametros: ["Versa", "Navojoa"],
  ...extra,
});

describe("clasificarDestinatarios", () => {
  it("manda a quien no tiene nada que lo impida", () => {
    expect(clasificarDestinatarios([base()], new Set())).toEqual([{ oportunidadId: "a", tel10: "6621234567", motivo: null }]);
  });

  it("la baja gana sobre todo, en el contacto o en el lead", () => {
    const r = clasificarDestinatarios(
      [base({ oportunidadId: "a", baja: true, telefono: null }), base({ oportunidadId: "b", estadoContacto: "baja", telefono: "6620000001" })],
      new Set(),
    );
    expect(r.map((d) => d.motivo)).toEqual(["baja", "baja"]);
  });

  it("omite no contactables, sin teléfono y números que no son celular", () => {
    const r = clasificarDestinatarios(
      [
        base({ oportunidadId: "a", estadoContacto: "no_contactable" }),
        base({ oportunidadId: "b", telefono: "123" }),
        base({ oportunidadId: "c", telefono: "6620000002", tieneCelular: false }),
        base({ oportunidadId: "d", telefono: "6620000003", tieneCelular: null }),
      ],
      new Set(),
    );
    expect(r.map((d) => d.motivo)).toEqual(["no_contactable", "sin_telefono", "sin_celular", null]);
  });

  it("un mensaje por teléfono al día: omite a quien ya recibió o tiene en cola uno hoy", () => {
    const r = clasificarDestinatarios([base()], new Set(["6621234567"]));
    expect(r[0].motivo).toBe("mensaje_hoy");
  });

  it("si dos filas comparten teléfono, sale solo a la primera que sí puede recibirlo", () => {
    const r = clasificarDestinatarios(
      [
        base({ oportunidadId: "a", parametros: ["", "Navojoa"] }),
        base({ oportunidadId: "b" }),
        base({ oportunidadId: "c" }),
      ],
      new Set(),
    );
    expect(r.map((d) => d.motivo)).toEqual(["variable_vacia", null, "telefono_repetido"]);
    expect(contarOmitidos(r)).toEqual({ variable_vacia: 1, telefono_repetido: 1 });
  });
});

describe("plantillaNoUsable", () => {
  const cuerpo = { body: { texto: "Hola, te saludamos de {{2}}. Gracias por tu {{1}}." } };

  it("acepta una plantilla aprobada de texto con sus datos ligados", () => {
    expect(plantillaNoUsable({ estado: "aprobada", componentes: { ...cuerpo, header: null } }, [1, 2])).toBeNull();
    expect(plantillaNoUsable({ estado: "aprobada", componentes: { ...cuerpo, header: { tipo: "texto", texto: "Aviso" } } }, [1, 2])).toBeNull();
  });

  it("rechaza las no aprobadas, con archivo o datos en el encabezado y con datos sin ligar", () => {
    expect(plantillaNoUsable({ estado: "pendiente", componentes: cuerpo }, [1, 2])).toMatch(/aprobada/);
    expect(plantillaNoUsable({ estado: "aprobada", componentes: { ...cuerpo, header: { tipo: "imagen" } } }, [1, 2])).toMatch(/archivo/);
    expect(plantillaNoUsable({ estado: "aprobada", componentes: { ...cuerpo, header: { tipo: "texto", texto: "Hola {{1}}" } } }, [1, 2])).toMatch(
      /encabezado/,
    );
    expect(plantillaNoUsable({ estado: "aprobada", componentes: cuerpo }, [1])).toMatch(/\{\{2\}\}/);
  });
});

describe("vista del mensaje", () => {
  it("llena cada {{n}} con su valor, aunque estén en desorden", () => {
    const texto = "De {{2}}: tu {{1}}, {{2}}.";
    expect(indicesCuerpo(texto)).toEqual([1, 2]);
    expect(llenarCuerpo(texto, [1, 2], ["Versa", "Navojoa"])).toBe("De Navojoa: tu Versa, Navojoa.");
  });

  it("arma encabezado, cuerpo, pie y botones", () => {
    const v = vistaMensaje(
      {
        header: { tipo: "texto", texto: "Aviso" },
        body: { texto: "Hola {{1}}" },
        footer: "Responde BAJA",
        botones: [{ tipo: "respuesta_rapida", texto: "Quiero informes" }],
      },
      ["Ana"],
    );
    expect(v).toEqual({ encabezado: "Aviso", archivo: null, cuerpo: "Hola Ana", pie: "Responde BAJA", botones: ["Quiero informes"] });
  });
});

describe("reglas de la plantilla", () => {
  const lead = { campana: "12M_NURTURING", estadoId: "e1", resultado: "BUZON", etapaVehiculoId: "v1" };

  it("sin reglas, la plantilla sirve para cualquiera (General)", () => {
    expect(motivoPorReglas(SIN_REGLAS, lead)).toBeNull();
  });

  it("cada regla con valores limita; varias se cumplen a la vez", () => {
    const r = { campanas: ["12M_NURTURING"], estados: ["e1", "e2"], resultados: ["BUZON"], etapasVehiculo: ["v1"] };
    expect(motivoPorReglas(r, lead)).toBeNull();
    expect(motivoPorReglas({ ...r, campanas: ["28M"] }, lead)).toBe("otra_campana");
    expect(motivoPorReglas({ ...r, estados: ["e3"] }, lead)).toBe("otro_estado");
    expect(motivoPorReglas({ ...r, resultados: ["INTERESADO"] }, lead)).toBe("otro_resultado");
    expect(motivoPorReglas({ ...r, etapasVehiculo: ["v2"] }, lead)).toBe("otra_etapa_vehiculo");
    expect(motivoPorReglas({ ...SIN_REGLAS, campanas: ["12M_NURTURING"] }, { ...lead, campana: null })).toBe("otra_campana");
  });

  it("quien no es para la plantilla se omite por eso antes que por cualquier otra cosa", () => {
    const r = clasificarDestinatarios([base({ fueraDeReglas: "otra_campana", baja: true })], new Set());
    expect(r[0].motivo).toBe("otra_campana");
  });

  it("nombra y ordena las campañas", () => {
    expect(etiquetaCampana("48H")).toBe("48 horas");
    expect(etiquetaCampana("12M_NURTURING")).toBe("12 meses");
    expect(etiquetaCampana("ESPECIAL")).toBe("ESPECIAL");
    expect(["28M", "ESPECIAL", "5M", "48H", "12M_NURTURING"].sort((a, b) => ordenCampana(a) - ordenCampana(b))).toEqual([
      "48H",
      "5M",
      "12M_NURTURING",
      "28M",
      "ESPECIAL",
    ]);
  });
});

describe("encabezado con archivo", () => {
  const cuerpo = { body: { texto: "Hola {{1}}" } };

  it("acepta una imagen guardada en la plataforma y la manda en cada envío", () => {
    const c = { ...cuerpo, header: { tipo: "imagen", media_url: "https://x/img.png" } };
    expect(plantillaNoUsable({ estado: "aprobada", componentes: c }, [1])).toBeNull();
    expect(encabezadoArchivo(c)).toEqual({ tipo: "imagen", url: "https://x/img.png", nombreArchivo: null });
    expect(vistaMensaje(c, ["Ana"]).archivo).toEqual({ tipo: "imagen", url: "https://x/img.png", nombre: null });
  });

  it("un documento conserva su nombre de archivo", () => {
    const c = { ...cuerpo, header: { tipo: "documento", media_url: "https://x/lista.pdf", nombre_archivo: "Lista.pdf" } };
    expect(encabezadoArchivo(c)).toEqual({ tipo: "documento", url: "https://x/lista.pdf", nombreArchivo: "Lista.pdf" });
  });

  it("sin archivo guardado no se puede mandar; con encabezado de texto no hay archivo", () => {
    expect(plantillaNoUsable({ estado: "aprobada", componentes: { ...cuerpo, header: { tipo: "video" } } }, [1])).toMatch(/archivo/);
    expect(encabezadoArchivo({ ...cuerpo, header: { tipo: "texto", texto: "Aviso" } })).toBeNull();
    expect(encabezadoArchivo(cuerpo)).toBeNull();
  });
});

describe("freno de la base", () => {
  it("cada motivo de omisión tiene su texto para el admin", () => {
    for (const m of MOTIVOS_OMISION) expect(TEXTO_MOTIVO[m], m).toBeTruthy();
  });

  it("traduce el motivo del freno: la supresión por baja es la baja y las carteras inactivas se agrupan", () => {
    expect(motivoDelFreno(null)).toBeNull();
    expect(motivoDelFreno("baja")).toBe("baja");
    expect(motivoDelFreno("supresion_baja")).toBe("baja");
    expect(motivoDelFreno("supresion_numero_equivocado")).toBe("supresion_numero_equivocado");
    expect(motivoDelFreno("supresion_flotilla")).toBe("supresion_flotilla");
    expect(motivoDelFreno("cartera_fuera_de_ventana")).toBe("cartera_inactiva");
    expect(motivoDelFreno("cartera_no_en_maestra")).toBe("cartera_inactiva");
    expect(motivoDelFreno("lead_ganada")).toBe("lead_ganada");
    expect(motivoDelFreno("contrato_cancelado")).toBe("contrato_cancelado");
  });

  it("un motivo que el código no conoce también omite", () => {
    expect(motivoDelFreno("algo_nuevo")).toBe("no_permitido");
  });

  it("lo que dice el freno omite, después de las reglas y la baja y antes del celular y del mensaje de hoy", () => {
    const r = clasificarDestinatarios(
      [
        base({ oportunidadId: "a", freno: "supresion_ya_no_tiene_auto", telefono: "6620000001", tieneCelular: false }),
        base({ oportunidadId: "b", freno: "lead_ganada", telefono: "6620000002" }),
        base({ oportunidadId: "c", freno: "pagado", fueraDeReglas: "otra_campana", telefono: "6620000003" }),
        base({ oportunidadId: "d", freno: "pagado", baja: true, telefono: "6620000004" }),
      ],
      new Set(["6620000002"]),
    );
    expect(r.map((d) => d.motivo)).toEqual(["supresion_ya_no_tiene_auto", "lead_ganada", "otra_campana", "baja"]);
  });

  it("a quien frena el freno no le aparta el teléfono: la siguiente fila con ese número sí lo recibe", () => {
    const r = clasificarDestinatarios([base({ oportunidadId: "a", freno: "ya_tiene_ge" }), base({ oportunidadId: "b" })], new Set());
    expect(r.map((d) => d.motivo)).toEqual(["ya_tiene_ge", null]);
  });
});

describe("plantillas de servicio", () => {
  const vendido = { campanas: [], estados: ["vendido"], resultados: [], etapasVehiculo: [] };
  const cotizadoConCompra = { campana: "28M", estadoId: "cotizado", resultado: "COTIZADO", etapaVehiculoId: null };

  it("al enviar, el estado del lead lo decide el freno (acepta la fecha de compra aunque no esté en Vendido)", () => {
    expect(motivoPorReglas(reglasParaEnvio({ ...vendido, uso: "servicio" }), cotizadoConCompra)).toBeNull();
    expect(motivoPorReglas(reglasParaEnvio({ ...vendido, uso: "servicio" }), { ...cotizadoConCompra, estadoId: "vendido" })).toBeNull();
  });

  it("las de campaña conservan su regla de estado, y para contar a quién le corresponde se usa tal cual", () => {
    expect(motivoPorReglas(reglasParaEnvio({ ...vendido, uso: "campana" }), cotizadoConCompra)).toBe("otro_estado");
    expect(motivoPorReglas(reglasParaEnvio(vendido), cotizadoConCompra)).toBe("otro_estado");
    expect(motivoPorReglas({ ...vendido, uso: "servicio" }, cotizadoConCompra)).toBe("otro_estado");
  });

  it("las demás reglas de una de servicio siguen contando", () => {
    expect(motivoPorReglas(reglasParaEnvio({ ...vendido, campanas: ["48H"], uso: "servicio" }), cotizadoConCompra)).toBe("otra_campana");
  });

  it("el uso guardado manda; sin reglas, una de utilidad de Meta es de servicio y las demás de campaña", () => {
    expect(usoDePlantilla("servicio", "marketing")).toBe("servicio");
    expect(usoDePlantilla("campana", "utility")).toBe("campana");
    expect(usoDePlantilla(null, "utility")).toBe("servicio");
    expect(usoDePlantilla(null, "marketing")).toBe("campana");
    expect(usoDePlantilla(undefined, null)).toBe("campana");
  });
});

describe("primer mensaje ligado a su paso de campaña", () => {
  it("sale si su paso sigue abierto", () => {
    expect(motivoPorPaso({ automatico: true, pasoEnvio: "p1", pasoAbierto: "p1" })).toBeNull();
  });

  it("si el paso se cerró, cambió por otro o el envío no tiene paso, ya no le toca", () => {
    expect(motivoPorPaso({ automatico: true, pasoEnvio: "p1", pasoAbierto: null })).toBe("sin_paso_abierto");
    expect(motivoPorPaso({ automatico: true, pasoEnvio: "p1", pasoAbierto: "p2" })).toBe("sin_paso_abierto");
    expect(motivoPorPaso({ automatico: true, pasoEnvio: null, pasoAbierto: null })).toBe("sin_paso_abierto");
  });

  it("los masivos manuales no dependen del paso", () => {
    expect(motivoPorPaso({ automatico: false, pasoEnvio: "p1", pasoAbierto: null })).toBeNull();
    expect(motivoPorPaso({ automatico: false, pasoEnvio: null, pasoAbierto: "p2" })).toBeNull();
  });
});

describe("un primer mensaje por teléfono y campaña (D10)", () => {
  const paso = { tel10: "6621234567", inicio: "2026-10-10" };
  const previo = (extra: Partial<EnvioPrevio> = {}): EnvioPrevio => ({
    id: "e1",
    tel10: "6621234567",
    estado: "entregado",
    errorCodigo: null,
    fecha: "2026-10-12",
    ...extra,
  });

  it("pudo llegar si Meta lo aceptó, o si falló sin código (no se sabe si salió)", () => {
    expect(pudoLlegar({ estado: "enviado", errorCodigo: null })).toBe(true);
    expect(pudoLlegar({ estado: "leido", errorCodigo: null })).toBe(true);
    expect(pudoLlegar({ estado: "fallido", errorCodigo: null })).toBe(true);
    expect(pudoLlegar({ estado: "fallido", errorCodigo: 131049 })).toBe(false);
    expect(pudoLlegar({ estado: "pendiente", errorCodigo: null })).toBe(false);
    expect(pudoLlegar({ estado: "omitido", errorCodigo: null })).toBe(false);
  });

  it("queda cubierto si a su teléfono ya le llegó un mensaje de la campaña desde que empezó la suya", () => {
    expect(cubiertoPorTelefono(paso, [previo()])).toEqual({ cubiertoPor: "e1", saltarHoy: false });
    expect(cubiertoPorTelefono(paso, [previo({ fecha: "2026-10-10" })])).toEqual({ cubiertoPor: "e1", saltarHoy: false });
  });

  it("dos vehículos del mismo teléfono que entran a 48H en días seguidos: el segundo queda cubierto por el primero", () => {
    // El del primer vehículo salió el día 10; el segundo vehículo entra a la campaña el 11.
    const segundo = { tel10: "6621234567", inicio: "2026-10-11" };
    expect(cubiertoPorTelefono(segundo, [previo({ id: "primero", fecha: "2026-10-10" })])).toEqual({ cubiertoPor: "primero", saltarHoy: false });
  });

  it("un masivo manual de la misma campaña también lo cubre (llega como un envío más de la campaña)", () => {
    expect(cubiertoPorTelefono(paso, [previo({ id: "manual", estado: "leido", fecha: "2026-09-20" })])).toEqual({
      cubiertoPor: "manual",
      saltarHoy: false,
    });
  });

  it(`cubre lo que salió hasta ${VENTANA_COBERTURA_DIAS} días antes de que empezara su campaña, no antes`, () => {
    expect(VENTANA_COBERTURA_DIAS).toBe(35);
    expect(cubiertoPorTelefono(paso, [previo({ fecha: "2026-09-05" })]).cubiertoPor).toBe("e1");
    expect(cubiertoPorTelefono(paso, [previo({ fecha: "2026-09-04" })]).cubiertoPor).toBeNull();
  });

  it("un segundo vehículo que entra a la campaña meses después sí recibe su primer mensaje", () => {
    const seisMesesDespues = { tel10: "6621234567", inicio: "2027-04-10" };
    expect(cubiertoPorTelefono(seisMesesDespues, [previo({ fecha: "2026-10-10" })])).toEqual({ cubiertoPor: null, saltarHoy: false });
  });

  it("un mensaje a otro teléfono, o un candidato sin teléfono, no se cubren", () => {
    const nada = { cubiertoPor: null, saltarHoy: false };
    expect(cubiertoPorTelefono(paso, [previo({ tel10: "6620000000" })])).toEqual(nada);
    expect(cubiertoPorTelefono({ ...paso, tel10: null }, [previo({ tel10: null })])).toEqual(nada);
  });

  it("si el que lo cubriría sigue en cola, se salta hoy sin marcarlo; uno en cola de hace meses no cuenta", () => {
    expect(cubiertoPorTelefono(paso, [previo({ estado: "pendiente", fecha: "2026-10-01" })])).toEqual({ cubiertoPor: null, saltarHoy: true });
    expect(cubiertoPorTelefono(paso, [previo({ estado: "pendiente", fecha: "2026-06-01" })])).toEqual({ cubiertoPor: null, saltarHoy: false });
  });

  it("si el del otro no llegó (falló con código de Meta), sí le toca", () => {
    expect(cubiertoPorTelefono(paso, [previo({ estado: "fallido", errorCodigo: 131026 })])).toEqual({ cubiertoPor: null, saltarHoy: false });
  });

  it("si falló sin saberse si salió, lo cubre igual: es preferible perder un mensaje a mandarlo dos veces", () => {
    expect(cubiertoPorTelefono(paso, [previo({ estado: "fallido", errorCodigo: null })]).cubiertoPor).toBe("e1");
  });

  it("entre varios, lo cubre el que Meta aceptó y, luego, el más antiguo", () => {
    const r = cubiertoPorTelefono(paso, [
      previo({ id: "incierto", estado: "fallido", fecha: "2026-10-10" }),
      previo({ id: "nuevo", fecha: "2026-10-13" }),
      previo({ id: "viejo", estado: "leido", fecha: "2026-10-11" }),
      previo({ id: "cola", estado: "pendiente" }),
    ]);
    expect(r).toEqual({ cubiertoPor: "viejo", saltarHoy: false });
  });
});

describe("resumen de omitidos", () => {
  it("junta lo que se guardó al armar con las filas omitidas, por motivo", () => {
    const r = juntarOmitidos(
      [
        { motivo: "baja", texto: TEXTO_MOTIVO.baja, n: 2 },
        { motivo: "otro_resultado", texto: TEXTO_MOTIVO.otro_resultado, n: 1 },
      ],
      [
        { motivo: "cubierto_mismo_telefono", n: 3 },
        { motivo: "baja", n: 1 },
      ],
    );
    expect(r).toEqual([
      { motivo: "baja", texto: TEXTO_MOTIVO.baja, n: 3 },
      { motivo: "otro_resultado", texto: TEXTO_MOTIVO.otro_resultado, n: 1 },
      { motivo: "cubierto_mismo_telefono", texto: TEXTO_MOTIVO.cubierto_mismo_telefono, n: 3 },
    ]);
  });
});
