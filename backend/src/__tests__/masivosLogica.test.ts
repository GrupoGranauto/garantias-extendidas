import { describe, expect, it } from "vitest";
import {
  clasificarDestinatarios,
  contarOmitidos,
  indicesCuerpo,
  llenarCuerpo,
  plantillaNoUsable,
  vistaMensaje,
  type Candidato,
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
    expect(plantillaNoUsable({ estado: "aprobada", componentes: { ...cuerpo, header: { tipo: "imagen" } } }, [1, 2])).toMatch(/imagen/);
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
    expect(v).toEqual({ encabezado: "Aviso", cuerpo: "Hola Ana", pie: "Responde BAJA", botones: ["Quiero informes"] });
  });
});
