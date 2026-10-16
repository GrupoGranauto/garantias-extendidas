import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadExistente, PlanLeads } from "../lib/cicloLeadLogica.js";
import { sincronizarConFilas, validarSensatez } from "../lib/sincronizacionCrm.js";

/*
  Candados de la sincronización (validarSensatez) y la corrida con filas en memoria (sincronizarConFilas). La base y
  BigQuery son de mentira: la corrida con filas no debe leer BigQuery. Solo las pruebas de «escritura» dejan abrir la
  transacción, contra un cliente que registra las sentencias en orden (sin base no se puede probar su efecto, pero sí
  que las guardas lleguen a la sentencia que corre y en qué orden).
*/

const bd = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  leads: [] as Record<string, unknown>[],
  pasos: [] as Record<string, unknown>[],
  /** Pasos que la transacción ve como «ajenos» al reabrir (no son el último cerrado de su lead). */
  ajenos: [] as string[],
  corridas: [] as unknown[][],
  escribio: false,
  permitirEscritura: false,
  sentencias: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("../lib/db.js", () => ({
  getPool: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("roster_ejecutivos")) return { rows: [{ roster_ejecutivos: ["Ejecutivo A", "Ejecutivo B"] }] };
      if (sql.includes("FROM crm_config")) return { rows: bd.config ? [bd.config] : [] };
      if (sql.includes("crm_supresion_terminal")) return { rows: bd.leads };
      if (sql.includes("FROM crm_oportunidad_campanas WHERE sucursal_id")) return { rows: bd.pasos };
      if (sql.includes("INSERT INTO crm_sync_corridas")) {
        bd.corridas.push(params);
        return { rows: [] };
      }
      throw new Error(`Consulta no esperada: ${sql.slice(0, 80)}`);
    },
    connect: async () => {
      bd.escribio = true;
      if (!bd.permitirEscritura) throw new Error("La prueba no debe escribir.");
      return {
        query: async (sql: string, params: unknown[] = []) => {
          bd.sentencias.push({ sql, params });
          if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ ok: true }] };
          if (sql.includes("JOIN crm_embudos b ON b.id = e.embudo_id")) return { rows: [{ id: "etapa-1", embudo_id: "embudo-1" }] };
          if (sql.includes("coalesce(max(posicion), 0) AS p")) return { rows: [{ p: 0 }] };
          if (sql.includes("SELECT c.id FROM crm_oportunidad_campanas c")) return { rows: bd.ajenos.map((id) => ({ id })) };
          return { rows: [] };
        },
        release: () => {},
      };
    },
  }),
}));

vi.mock("../lib/bigquery.js", () => ({
  getBigQuery: () => {
    throw new Error("La corrida con filas en memoria no debe leer BigQuery.");
  },
}));

// Lo que corre después de la transacción no es de estas pruebas.
vi.mock("../lib/cicloVehiculo.js", async (original) => ({
  ...(await original<typeof import("../lib/cicloVehiculo.js")>()),
  recalcularEtapas: async () => ({ revisados: 0, cambiaron: 0 }),
}));
vi.mock("../lib/vinculoWhatsapp.js", async (original) => ({
  ...(await original<typeof import("../lib/vinculoWhatsapp.js")>()),
  vincularConversaciones: async () => 0,
}));

const SUC = "00000000-0000-0000-0000-000000000001";

const lead = (i: number, extra: Partial<LeadExistente> = {}): LeadExistente => ({
  id: `lead-${i}`,
  vin: `3N1AB7AP0RY${String(i).padStart(6, "0")}`,
  ejecutivo: "Ejecutivo A",
  estado: "abierta",
  estado_contacto: "sin_intentar",
  estado_cartera: "ACTIVA",
  supresion: null,
  pagado: false,
  pasoAbierto: null,
  pasosCerrados: [],
  ...extra,
});
const activas = (n: number) => Array.from({ length: n }, (_, i) => lead(i + 1));
const plan = (filasFuente: number, activasFuente: number) => ({ filasFuente, activasFuente }) as PlanLeads;

/** Fila de la maestra en 5M de octubre. */
const fila = (i: number) => ({
  vin: `3N1AB7AP0RY9${String(i).padStart(5, "0")}`,
  fecha_factura: "2026-05-15",
  fecha_reporte: "2026-05-16",
  cliente: `Prueba ${i}`,
  telefono_principal: `66200000${String(i).padStart(2, "0")}`,
  es_contactable: true,
  tiene_ge: false,
  en_cartera_operativa: true,
  campania_actual: "5M",
  fecha_inicio_5m: "2026-10-01",
  fecha_fin_5m: "2026-11-01",
});

describe("validarSensatez", () => {
  it("con la maestra real exige un mínimo de filas y algo activo", () => {
    expect(validarSensatez(plan(999, 600), activas(600))).toMatch(/muy pocas filas/);
    expect(validarSensatez(plan(15000, 0), [])).toMatch(/no trae oportunidades activas/);
    expect(validarSensatez(plan(15000, 640), activas(635))).toBeNull();
  });

  it("con la maestra real aborta si las activas bajan a menos de la mitad", () => {
    expect(validarSensatez(plan(15000, 300), activas(635))).toMatch(/menos de la mitad/);
  });

  it("con una tabla de prueba no pide mínimo de filas, pero sí algo activo", () => {
    expect(validarSensatez(plan(4, 4), [], true)).toBeNull();
    expect(validarSensatez(plan(4, 0), [], true)).toMatch(/no trae oportunidades activas/);
  });

  it("con una tabla de prueba también aborta si deja sin campaña a más de la mitad de la cartera (6-oct)", () => {
    expect(validarSensatez(plan(4, 4), activas(1697), true)).toMatch(/menos de la mitad/);
    expect(validarSensatez(plan(4, 4), activas(60), true)).toMatch(/menos de la mitad/);
  });

  it("con una tabla de prueba y una cartera chica (menos de 50 activas) no aplica el candado de la mitad", () => {
    expect(validarSensatez(plan(4, 4), activas(49), true)).toBeNull();
    expect(validarSensatez(plan(30, 30), activas(60), true)).toBeNull();
  });
});

describe("sincronizarConFilas", () => {
  beforeEach(() => {
    bd.config = { sync_bigquery: false, bq_tabla_fuente: null, campanas_fuente: "bigquery" };
    bd.leads = [];
    bd.pasos = [];
    bd.ajenos = [];
    bd.corridas = [];
    bd.escribio = false;
    bd.permitirEscritura = false;
    bd.sentencias = [];
  });

  const filaLead = (l: LeadExistente) => ({
    id: l.id, vin: l.vin, ejecutivo: l.ejecutivo, estado: l.estado, estado_cartera: l.estado_cartera,
    estado_contacto: l.estado_contacto, supresion: l.supresion, pagado: l.pagado,
  });

  it("se niega con la sucursal que se sincroniza a diario con la maestra real", async () => {
    bd.config = { sync_bigquery: true, bq_tabla_fuente: null, campanas_fuente: "bigquery" };
    await expect(sincronizarConFilas(SUC, [fila(1)], true)).rejects.toThrow(/sucursal de pruebas/);
    expect(bd.corridas).toHaveLength(0);
    expect(bd.escribio).toBe(false);
  });

  it("se niega si la sucursal no tiene configuración", async () => {
    bd.config = null;
    await expect(sincronizarConFilas(SUC, [fila(1)], false)).rejects.toThrow(/configuración/);
  });

  it("valida en modo prueba: 4 filas contra 60 activas se abortan sin escribir y queda la corrida con error", async () => {
    bd.leads = activas(60).map(filaLead);
    const filas = [1, 2, 3, 4].map(fila);
    await expect(sincronizarConFilas(SUC, filas, true)).rejects.toThrow(/menos de la mitad/);
    expect(bd.escribio).toBe(false);
    expect(bd.corridas).toHaveLength(1);
    expect(bd.corridas[0][2]).toBe("error");
    expect(String(bd.corridas[0][10])).toMatch(/^Prueba con filas cargadas aparte\. /);
  });

  it("en simulación planifica con las filas dadas, registra la corrida y no escribe", async () => {
    const r = await sincronizarConFilas(SUC, [fila(1), fila(2)], false);
    expect(r).toMatchObject({ modo: "simulacion", filasFuente: 2, activasFuente: 2, leadsNuevos: 2, conflictos: [] });
    expect(bd.escribio).toBe(false);
    expect(bd.corridas).toHaveLength(1);
    expect(bd.corridas[0][2]).toBe("ok");
    expect(bd.corridas[0][10]).toBe("Prueba con filas cargadas aparte. Simulación: no se escribió nada.");
  });

  describe("escritura del ciclo", () => {
    /** La misma fila 1, hoy en 28M de octubre. */
    const fila28m = (i: number) => ({ ...fila(i), campania_actual: "28M", fecha_inicio_28m: "2026-10-01", fecha_fin_28m: "2026-11-01" });
    const VIN1 = fila(1).vin;
    const indice = (trozo: string) => bd.sentencias.findIndex((s) => s.sql.includes(trozo));
    const sentencia = (trozo: string) => bd.sentencias.find((s) => s.sql.includes(trozo));

    beforeEach(() => {
      bd.permitirEscritura = true;
    });

    it("cambio de campaña: el no contactable sin supresión se reinicia, con las guardas al escribir, y la baja se hereda al final", async () => {
      bd.leads = [
        filaLead(lead(1, { vin: VIN1, estado: "perdida", estado_contacto: "no_contactable", supresion: null })),
      ];
      bd.pasos = [{ id: "paso-5m", oportunidad_id: "lead-1", clave: `${VIN1}|5M|2026-10-01`, campana: "5M", abierto: true }];

      const r = await sincronizarConFilas(SUC, [fila28m(1), fila(2)], true);
      expect(r).toMatchObject({ modo: "real", pasosNuevos: 1, leadsNuevos: 1, cerradas: 1, conflictos: [] });

      // Reinicio: incluye al no contactable (teléfono cambiado), vuelve a revisar pago y supresión con lo de ahora y ya no
      // conserva el «No contactable».
      const reinicio = sentencia("WITH antes AS (")!;
      expect(reinicio.params[1]).toEqual(["lead-1"]);
      expect(reinicio.sql).toContain("AND NOT ((o.fecha_pago IS NOT NULL");
      expect(reinicio.sql).toContain("AND crm_supresion_terminal(o.id) IS NULL");
      expect(reinicio.sql).not.toContain("THEN 'no_contactable'");

      // Lead nuevo: hereda la baja, pero un número equivocado vigente no lo hace nacer «No contactable» (nace «Sin
      // intentar» y lo frena la supresión); así no impide corregir el lead donde se capturó por error.
      const nuevos = sentencia("INSERT INTO crm_oportunidades\n")!;
      expect(nuevos.sql).toMatch(
        /CASE WHEN coalesce\(c\.whatsapp_baja, false\) OR b\.bloqueo IN \('supresion_baja', 'baja'\) THEN 'baja'\s+ELSE 'sin_intentar' END/,
      );
      expect(nuevos.sql).not.toContain("'no_contactable'");
      expect(nuevos.sql).not.toContain("supresion_numero_equivocado");

      // Herencia de la baja: después de refrescar el lead, abrir el paso nuevo, reiniciar y crear leads; antes del COMMIT.
      const herencia = indice("SET estado_contacto = 'baja', respuesta_por_clasificar = false");
      expect(herencia).toBeGreaterThan(indice("SET\n       clave = r.clave"));
      expect(herencia).toBeGreaterThan(indice("INSERT INTO crm_oportunidad_campanas\n           (sucursal_id, oportunidad_id"));
      expect(herencia).toBeGreaterThan(indice("WITH antes AS ("));
      expect(herencia).toBeGreaterThan(indice("INSERT INTO crm_oportunidades\n"));
      expect(herencia).toBeLessThan(indice("COMMIT"));
      expect(bd.corridas.at(-1)?.[2]).toBe("ok");
    });

    it("con el número equivocado vigente el lead no se reinicia: no hay sentencia de reinicio", async () => {
      bd.leads = [
        filaLead(lead(1, { vin: VIN1, estado: "perdida", estado_contacto: "no_contactable", supresion: "numero_equivocado" })),
      ];
      bd.pasos = [{ id: "paso-5m", oportunidad_id: "lead-1", clave: `${VIN1}|5M|2026-10-01`, campana: "5M", abierto: true }];
      await sincronizarConFilas(SUC, [fila28m(1)], true);
      expect(indice("WITH antes AS (")).toBe(-1);
      expect(indice("COMMIT")).toBeGreaterThan(0);
    });

    it("reapertura: la restauración completa no revive de la foto una baja, un no contactable ni un descarte", async () => {
      bd.leads = [filaLead(lead(1, { vin: VIN1, estado_contacto: "contactado" }))];
      bd.pasos = [
        { id: "paso-a", oportunidad_id: "lead-1", clave: `${VIN1}|5M|2026-10-01`, campana: "5M", abierto: false },
        { id: "paso-b", oportunidad_id: "lead-1", clave: `${VIN1}|28M|2026-10-01`, campana: "28M", abierto: true },
      ];
      bd.ajenos = ["paso-a"];
      const r = await sincronizarConFilas(SUC, [fila(1)], true);
      expect(r).toMatchObject({ reabiertas: 1, cerradas: 1, conflictos: [] });

      const completo = sentencia("WITH f AS (")!;
      expect(completo.params[1]).toEqual(["paso-a"]);
      expect(completo.sql).toContain("AND o.estado_contacto NOT IN ('baja', 'no_contactable') AND NOT k.whatsapp_baja");
      expect(completo.sql).toContain("AND coalesce(c.estado_contacto, '') NOT IN ('baja', 'no_contactable') AND c.resultado_bdc <> 'NO CONTACTABLE'");
      expect(completo.sql).toMatch(/mp\.clave IN \('pidio_baja', 'no_contactable',\s+'ya_no_tiene_auto', 'flotilla', 'uso_no_elegible', 'fuera_km_tiempo'\)/);
      // Lo que no se restauró completo (aquí, todo) recupera solo lo de su campaña.
      expect(sentencia("WITH x AS (")!.params[1]).toEqual(["paso-a"]);
    });

    it("ninguna sentencia de la sync declara la corrección de una supresión ni la salida de una baja (0039)", async () => {
      // Un ciclo con reinicio de un no contactable, reapertura y lead nuevo: todas las sentencias que cambian estado de
      // contacto o motivo.
      bd.leads = [
        filaLead(lead(1, { vin: VIN1, estado: "perdida", estado_contacto: "no_contactable" })),
        filaLead(lead(3, { vin: fila(3).vin, estado_contacto: "contactado" })),
      ];
      bd.pasos = [
        { id: "paso-5m", oportunidad_id: "lead-1", clave: `${VIN1}|5M|2026-10-01`, campana: "5M", abierto: true },
        { id: "paso-3a", oportunidad_id: "lead-3", clave: `${fila(3).vin}|5M|2026-10-01`, campana: "5M", abierto: false },
        { id: "paso-3b", oportunidad_id: "lead-3", clave: `${fila(3).vin}|28M|2026-10-01`, campana: "28M", abierto: true },
      ];
      bd.ajenos = ["paso-3a"];
      const r = await sincronizarConFilas(SUC, [fila28m(1), fila(2), fila(3)], true);
      expect(r).toMatchObject({ pasosNuevos: 1, leadsNuevos: 1, reabiertas: 1, conflictos: [] });
      expect(indice("WITH antes AS (")).toBeGreaterThan(0);
      expect(indice("WITH f AS (")).toBeGreaterThan(0);
      // La marca se declara con set_config (o SET LOCAL); un comentario que la nombre no cuenta.
      for (const s of bd.sentencias) {
        expect(s.sql).not.toMatch(/set_config|\bset\s+local\b/i);
      }
    });
  });
});
