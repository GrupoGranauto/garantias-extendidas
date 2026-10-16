import { describe, expect, it } from "vitest";
import {
  DESCARTES_VEHICULO,
  MOTIVO_QUITAR_MAX,
  MOTIVO_QUITAR_MIN,
  avisoBajaEnLote,
  avisoBloqueadasEnLote,
  avisoBloqueadasEtapaEnLote,
  bajaQuedaFuera,
  bloqueoQuedaFuera,
  corrigeBloqueo,
  motivoSinTarea,
  validarMotivoQuitar,
} from "../lib/noContactarLogica.js";

describe("validarMotivoQuitar", () => {
  it("exige un motivo escrito", () => {
    for (const v of [undefined, null, 12, "", "    "]) {
      expect(validarMotivoQuitar(v)).toEqual({ ok: false, error: "Escribe por qué se quita «no contactar»." });
    }
  });

  it("exige al menos 10 caracteres sin contar los espacios de las orillas", () => {
    expect(validarMotivoQuitar("  muy corto ").ok).toBe(false);
    expect(validarMotivoQuitar("123456789").ok).toBe(false);
    expect(validarMotivoQuitar("  1234567890  ")).toEqual({ ok: true, motivo: "1234567890" });
    expect(MOTIVO_QUITAR_MIN).toBe(10);
  });

  it("cuenta caracteres como la base: acentos y emojis valen uno", () => {
    expect(validarMotivoQuitar("captúraló").ok).toBe(false); // 9 caracteres
    expect(validarMotivoQuitar("😀😀😀😀😀").ok).toBe(false); // 10 unidades de JavaScript, 5 caracteres
    expect(validarMotivoQuitar("Se capturó en el lead equivocado").ok).toBe(true);
  });

  it("pone un tope al motivo", () => {
    expect(validarMotivoQuitar("a".repeat(MOTIVO_QUITAR_MAX)).ok).toBe(true);
    expect(validarMotivoQuitar("a".repeat(MOTIVO_QUITAR_MAX + 1)).ok).toBe(false);
  });
});

describe("bajaQuedaFuera", () => {
  it("reasignar ejecutivo no deja fuera a nadie", () => {
    expect(bajaQuedaFuera("ejecutivo")).toBe(false);
  });

  it("a un lead en baja no se le crean tareas", () => {
    expect(bajaQuedaFuera("tarea")).toBe(true);
  });

  it("en lote un lead en baja solo se cierra como perdido", () => {
    expect(bajaQuedaFuera("etapa", "perdida")).toBe(false);
    expect(bajaQuedaFuera("etapa", "abierta")).toBe(true);
    expect(bajaQuedaFuera("etapa", "ganada")).toBe(true);
  });
});

describe("avisoBajaEnLote", () => {
  it("sin leads en baja no hay aviso", () => {
    expect(avisoBajaEnLote("etapa", 0)).toBeNull();
    expect(avisoBajaEnLote("tarea", 0)).toBeNull();
    expect(avisoBajaEnLote("ejecutivo", 3)).toBeNull();
  });

  it("dice cuántos no se cambiaron y por qué, en singular y plural", () => {
    expect(avisoBajaEnLote("etapa", 1)).toBe(
      "1 no se movió: está en «Baja» (la persona pidió no ser contactada). En lote solo se puede cerrar como perdido.",
    );
    expect(avisoBajaEnLote("etapa", 4)).toBe(
      "4 no se movieron: están en «Baja» (la persona pidió no ser contactada). En lote solo se pueden cerrar como perdidos.",
    );
    expect(avisoBajaEnLote("tarea", 1)).toBe("1 no recibió la tarea: está en «Baja» (la persona pidió no ser contactada).");
    expect(avisoBajaEnLote("tarea", 2)).toBe("2 no recibieron la tarea: están en «Baja» (la persona pidió no ser contactada).");
  });
});

describe("avisoBloqueadasEnLote", () => {
  it("sin leads bloqueados no hay aviso", () => {
    expect(avisoBloqueadasEnLote(0)).toBeNull();
  });

  it("dice cuántos se quedaron sin la tarea y por qué, en singular y plural", () => {
    expect(avisoBloqueadasEnLote(1)).toBe(
      "1 no recibió la tarea: no se le puede contactar (no contactable, número equivocado, vehículo descartado o teléfono dado de baja).",
    );
    expect(avisoBloqueadasEnLote(3)).toBe(
      "3 no recibieron la tarea: no se les puede contactar (no contactables, número equivocado, vehículo descartado o teléfono dado de baja).",
    );
  });
});

describe("motivoSinTarea", () => {
  const libre = { estadoContacto: "contactado", noContactar: false, supresion: null };

  it("a un lead que se puede buscar sí se le crea la tarea", () => {
    expect(motivoSinTarea(libre)).toBeNull();
    expect(motivoSinTarea({ ...libre, estadoContacto: null })).toBeNull();
  });

  it("la baja gana: del lead, de la persona o de su teléfono", () => {
    expect(motivoSinTarea({ ...libre, estadoContacto: "baja" })).toBe("baja");
    expect(motivoSinTarea({ ...libre, noContactar: true })).toBe("baja");
    expect(motivoSinTarea({ ...libre, supresion: "baja" })).toBe("baja");
    expect(motivoSinTarea({ estadoContacto: "no_contactable", noContactar: true, supresion: "numero_equivocado" })).toBe("baja");
  });

  it("una supresión del teléfono o del VIN va antes que «no contactable»", () => {
    expect(motivoSinTarea({ ...libre, supresion: "numero_equivocado" })).toBe("supresion_numero_equivocado");
    expect(motivoSinTarea({ ...libre, supresion: "ya_no_tiene_auto" })).toBe("supresion_ya_no_tiene_auto");
    expect(motivoSinTarea({ ...libre, estadoContacto: "no_contactable", supresion: "flotilla" })).toBe("supresion_flotilla");
  });

  it("un lead no contactable sin supresión tampoco recibe la tarea", () => {
    expect(motivoSinTarea({ ...libre, estadoContacto: "no_contactable" })).toBe("no_contactable");
  });
});

describe("bloqueoQuedaFuera (cambio de estado en lote)", () => {
  it("reabrir o marcar como venta a un lead bloqueado no se hace en lote", () => {
    expect(bloqueoQuedaFuera("abierta", null, null)).toBe(true);
    expect(bloqueoQuedaFuera("abierta", "m-descarte", null)).toBe(true);
    expect(bloqueoQuedaFuera("ganada", "m-descarte", null)).toBe(true);
  });

  it("cerrarlo como perdido sí, mientras no le cambie ni le quite el motivo que ya tiene", () => {
    expect(bloqueoQuedaFuera("perdida", null, null)).toBe(false);
    expect(bloqueoQuedaFuera("perdida", null, "m-no-interesado")).toBe(false);
    expect(bloqueoQuedaFuera("perdida", "m-descarte", "m-descarte")).toBe(false);
  });

  it("cambiarle o quitarle el motivo en lote, no: se corrige en su ficha", () => {
    expect(bloqueoQuedaFuera("perdida", "m-descarte", "m-no-interesado")).toBe(true);
    expect(bloqueoQuedaFuera("perdida", "m-descarte", null)).toBe(true);
  });
});

describe("avisoBloqueadasEtapaEnLote", () => {
  it("sin leads bloqueados no hay aviso", () => {
    expect(avisoBloqueadasEtapaEnLote(0)).toBeNull();
  });

  it("dice cuántos no se movieron, por qué y dónde se corrigen, en singular y plural", () => {
    expect(avisoBloqueadasEtapaEnLote(1)).toBe(
      "1 no se movió: es no contactable (número equivocado) o tiene el vehículo descartado. En lote solo se puede cerrar como perdido sin cambiarle el motivo; si fue un error de captura, corrígelo en su ficha.",
    );
    expect(avisoBloqueadasEtapaEnLote(2)).toBe(
      "2 no se movieron: son no contactables (número equivocado) o tienen el vehículo descartado. En lote solo se pueden cerrar como perdidos sin cambiarles el motivo; si fue un error de captura, corrige cada uno en su ficha.",
    );
  });
});

describe("corrigeBloqueo", () => {
  const sinCambio = { contactoAntes: "intentando", contactoDespues: "intentando", motivoAntes: null, motivoDespues: null };

  it("los descartes del vehículo son los cuatro de la base", () => {
    expect([...DESCARTES_VEHICULO].sort()).toEqual(["flotilla", "fuera_km_tiempo", "uso_no_elegible", "ya_no_tiene_auto"]);
  });

  it("una edición que no toca un bloqueo no se declara", () => {
    expect(corrigeBloqueo(sinCambio)).toBe(false);
    expect(corrigeBloqueo({ ...sinCambio, contactoDespues: "contactado" })).toBe(false);
    expect(corrigeBloqueo({ ...sinCambio, motivoAntes: "no_interesado", motivoDespues: null })).toBe(false);
  });

  it("sacarlo de «No contactable» lo corrige; pasarlo a «Baja» o dejarlo igual, no", () => {
    expect(corrigeBloqueo({ ...sinCambio, contactoAntes: "no_contactable", contactoDespues: "contactado" })).toBe(true);
    expect(corrigeBloqueo({ ...sinCambio, contactoAntes: "no_contactable", contactoDespues: "sin_intentar" })).toBe(true);
    expect(corrigeBloqueo({ ...sinCambio, contactoAntes: "no_contactable", contactoDespues: "baja" })).toBe(false);
    expect(corrigeBloqueo({ ...sinCambio, contactoAntes: "no_contactable", contactoDespues: "no_contactable" })).toBe(false);
    expect(corrigeBloqueo({ ...sinCambio, contactoAntes: "no_contactable", contactoDespues: null })).toBe(false);
  });

  it("quitarle o cambiarle un descarte del vehículo lo corrige", () => {
    for (const motivo of DESCARTES_VEHICULO) {
      expect(corrigeBloqueo({ ...sinCambio, motivoAntes: motivo, motivoDespues: null })).toBe(true);
      expect(corrigeBloqueo({ ...sinCambio, motivoAntes: motivo, motivoDespues: "no_interesado" })).toBe(true);
      expect(corrigeBloqueo({ ...sinCambio, motivoAntes: motivo, motivoDespues: motivo })).toBe(false);
    }
    expect(corrigeBloqueo({ ...sinCambio, motivoAntes: "ya_no_tiene_auto", motivoDespues: "flotilla" })).toBe(true);
  });

  it("poner un descarte o el motivo «No contactable» no corrige nada", () => {
    expect(corrigeBloqueo({ ...sinCambio, motivoAntes: null, motivoDespues: "flotilla" })).toBe(false);
    expect(corrigeBloqueo({ ...sinCambio, motivoAntes: "no_contactable", motivoDespues: null })).toBe(false);
  });
});
