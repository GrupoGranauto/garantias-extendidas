import { describe, expect, it } from "vitest";
import { adaptarFilaCruda, campanaDeVehiculo, esFilaCruda, nombreCompleto } from "../lib/origenCrudoLogica.js";
import { oportunidadWeb } from "../lib/sincronizacionCrm.js";
import { planificarLeads, type LeadExistente } from "../lib/cicloLeadLogica.js";
import type { DefinicionCampana } from "../lib/campanasDefLogica.js";

/** Las reglas de Granauto: 48H por fecha de reporte; el resto por fecha de factura. */
const DEFS: DefinicionCampana[] = [
  { nombre: "48H", tipo: "dias", columna_fecha: "fecha_reporte", dias_desde: 1, dias_hasta: 4, meses_atras: null, dia_envio: null, hora_envio: null, etapa_orden: null, activa: true },
  { nombre: "5M", tipo: "meses", columna_fecha: "fecha_factura", dias_desde: null, dias_hasta: null, meses_atras: 5, dia_envio: 1, hora_envio: "09:00", etapa_orden: null, activa: true },
  { nombre: "12M_NURTURING", tipo: "dias", columna_fecha: "fecha_factura", dias_desde: 334, dias_hasta: 365, meses_atras: null, dia_envio: null, hora_envio: null, etapa_orden: null, activa: true },
  { nombre: "28M", tipo: "meses", columna_fecha: "fecha_factura", dias_desde: null, dias_hasta: null, meses_atras: 28, dia_envio: 1, hora_envio: "09:00", etapa_orden: null, activa: true },
];
const HOY = "2026-10-06";
const SIN_ETAPAS = new Map();

const cruda = (extra: Record<string, unknown>) =>
  adaptarFilaCruda({ vin: "VIN", nombre: "Miguel", apellido_paterno: "Borbon", apellido_materno: null, telefono: "662-358-7553", correo: "x@example.com", tiene_ge: false, ...extra });

describe("adaptar la fila cruda", () => {
  it("reconoce el formato crudo", () => {
    expect(esFilaCruda({ vin: "A", nombre: "x", telefono: "1" })).toBe(true);
    expect(esFilaCruda({ vin: "A", campania_actual: "5M", cliente: "x" })).toBe(false);
  });

  it("arma el nombre completo y la contactabilidad", () => {
    const f = cruda({});
    expect(f.cliente).toBe("Miguel Borbon");
    expect(f.telefono_principal).toBe("6623587553");
    expect(f.es_contactable).toBe(true);
    expect(nombreCompleto({ nombre: " Ana ", apellido_paterno: "Lopez", apellido_materno: "Ruiz" })).toBe("Ana Lopez Ruiz");
  });

  it("sin teléfono válido ni correo no es contactable", () => {
    const f = cruda({ telefono: "123", correo: "no-es-correo" });
    expect(f.es_contactable).toBe(false);
    expect(f.motivo_no_contactable).toBe("SIN_TELEFONO_NI_CORREO");
  });
});

describe("campaña calculada por la web", () => {
  it("48H por la fecha de reporte (día 1 a 3)", () => {
    expect(campanaDeVehiculo(cruda({ fecha_factura: "2026-10-04", fecha_reporte: "2026-10-05" }), DEFS, HOY, undefined)).toEqual({
      campana: "48H", inicio: "2026-10-06", fin: "2026-10-09", fase: "POR_DIAS", proxima: "5M",
    });
    // La factura no cuenta para 48H: con reporte de hace 10 días ya salió.
    expect(campanaDeVehiculo(cruda({ fecha_factura: "2026-10-05", fecha_reporte: "2026-09-26" }), DEFS, HOY, undefined)).toBeNull();
  });

  it("5M y 28M por cohorte mensual de la factura", () => {
    expect(campanaDeVehiculo(cruda({ fecha_factura: "2026-05-15" }), DEFS, HOY, undefined)?.campana).toBe("5M");
    const c28 = campanaDeVehiculo(cruda({ fecha_factura: "2024-06-10" }), DEFS, HOY, undefined);
    expect(c28).toMatchObject({ campana: "28M", inicio: "2026-10-01", fin: "2026-11-01" });
  });

  it("12M por días desde la factura", () => {
    expect(campanaDeVehiculo(cruda({ fecha_factura: "2025-10-31" }), DEFS, HOY, undefined)).toMatchObject({ campana: "12M_NURTURING", inicio: "2026-09-30" });
  });

  it("no entra quien ya tiene GE, quien no es contactable ni el vehículo excluido", () => {
    expect(campanaDeVehiculo(cruda({ fecha_factura: "2026-05-15", tiene_ge: true }), DEFS, HOY, undefined)).toBeNull();
    expect(campanaDeVehiculo(cruda({ fecha_factura: "2026-05-15", telefono: null, correo: null }), DEFS, HOY, undefined)).toBeNull();
    expect(campanaDeVehiculo(cruda({ fecha_factura: "2026-05-15" }), DEFS, HOY, { etapaOrden: null, excluido: true })).toBeNull();
  });
});

describe("ciclo de leads con el origen crudo", () => {
  const filas = [
    cruda({ vin: "V1", telefono: "6623587553", fecha_factura: "2026-10-04", fecha_reporte: "2026-10-05" }),
    cruda({ vin: "V2", telefono: "6621464226", fecha_factura: "2026-05-15", fecha_reporte: "2026-05-17" }),
    cruda({ vin: "V3", telefono: "6623254234", fecha_factura: "2025-10-31", fecha_reporte: "2025-11-02" }),
    cruda({ vin: "V4", telefono: "6624305938", fecha_factura: "2024-06-10", fecha_reporte: "2024-06-12" }),
    cruda({ vin: "V5", telefono: "6620000000", fecha_factura: "2023-01-10", fecha_reporte: "2023-01-12" }), // en ninguna campaña
  ];
  const activar = (m: Record<string, unknown>) => oportunidadWeb(m, DEFS, HOY, SIN_ETAPAS);
  const lead = (id: string, vin: string, clave: string): LeadExistente => ({
    id, vin, ejecutivo: "Ejecutivo A", estado: "abierta", estado_contacto: "sin_intentar", estado_cartera: "ACTIVA",
    pasoAbierto: { id: `paso-${id}`, clave, campana: clave.split("|")[1] }, pasosCerrados: [],
  });

  it("crea un lead por VIN con su paso VIN|campaña|inicio", () => {
    const p = planificarLeads(filas, [], ["Ejecutivo A", "Ejecutivo B"], activar);
    expect(p.conflictos).toEqual([]);
    expect(p.leadsNuevos.map((n) => n.clave).sort()).toEqual(["V1|48H|2026-10-06", "V2|5M|2026-10-01", "V3|12M_NURTURING|2026-09-30", "V4|28M|2026-10-01"]);
    expect(new Set(p.leadsNuevos.map((n) => n.ejecutivo))).toEqual(new Set(["Ejecutivo A", "Ejecutivo B"]));
  });

  it("cierra lo que ya no está en ninguna campaña, sin borrar", () => {
    const p = planificarLeads(filas, [lead("o1", "V5", "V5|5M|2022-06-01"), lead("o2", "V9", "V9|5M|2026-10-01")], ["Ejecutivo A"], activar);
    expect(p.cerrados).toEqual(
      expect.arrayContaining([
        { leadId: "o1", pasoId: "paso-o1", estado: "FUERA_DE_VENTANA", motivo: "FUERA_DE_VENTANA" },
        { leadId: "o2", pasoId: "paso-o2", estado: "NO_EN_MAESTRA", motivo: "NO_EN_MAESTRA" },
      ]),
    );
  });
});
