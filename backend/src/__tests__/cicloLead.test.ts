import { describe, expect, it } from "vitest";
import { planificarLeads, type LeadExistente } from "../lib/cicloLeadLogica.js";
import type { FilaMaestra } from "../lib/sincronizacionCrm.js";

const VIN = "3N1AB7AP0RY000001";

/** Fila de la maestra en 5M de octubre; cada prueba cambia solo lo que le importa. */
const fila = (extra: FilaMaestra = {}): FilaMaestra => ({
  vin: VIN,
  fecha_factura: "2026-05-15",
  fecha_reporte: "2026-05-16",
  cliente: "Cliente Uno",
  telefono_principal: "6621234567",
  es_contactable: true,
  tiene_ge: false,
  en_cartera_operativa: true,
  campania_actual: "5M",
  fecha_inicio_5m: "2026-10-01",
  fecha_fin_5m: "2026-11-01",
  etapa: "ETAPA_1",
  ...extra,
});

const fueraDeCampana = (extra: FilaMaestra = {}) => fila({ campania_actual: null, en_cartera_operativa: false, ...extra });

const lead = (extra: Partial<LeadExistente> = {}): LeadExistente => ({
  id: "lead-1",
  vin: VIN,
  ejecutivo: "María José Nuñez",
  estado: "abierta",
  estado_contacto: "contactado",
  estado_cartera: "ACTIVA",
  pasoAbierto: { id: "paso-5m", clave: `${VIN}|5M|2026-10-01`, campana: "5M" },
  pasosCerrados: [],
  ...extra,
});

const ROSTER = ["María José Nuñez", "Fernando Zazueta"];

describe("planificarLeads", () => {
  it("el mismo paso de ayer sigue igual: no se reinicia ni se abre nada", () => {
    const p = planificarLeads([fila()], [lead()], ROSTER);
    expect(p.siguen).toEqual([expect.objectContaining({ leadId: "lead-1", pasoId: "paso-5m" })]);
    expect(p.pasosNuevos).toHaveLength(0);
    expect(p.cerrados).toHaveLength(0);
    expect(p.conflictos).toEqual([]);
  });

  it("al cambiar de campaña cierra el paso anterior y abre otro, reiniciando el lead", () => {
    const hoy12m = fila({ campania_actual: "12M_NURTURING", fecha_factura: "2025-11-15", fecha_fin_12m_nurturing: "2026-11-15", etapa: "NURTURING" });
    const p = planificarLeads([hoy12m], [lead()], ROSTER);
    expect(p.cerrados).toEqual([{ leadId: "lead-1", pasoId: "paso-5m", estado: "FUERA_DE_VENTANA", motivo: "CAMBIO_CAMPANA" }]);
    expect(p.pasosNuevos).toEqual([expect.objectContaining({ leadId: "lead-1", reiniciar: true })]);
    expect(p.pasosNuevos[0].datos.clave).toBe(`${VIN}|12M_NURTURING|2026-10-15`);
    expect(p.leadsNuevos).toHaveLength(0);
  });

  it("un lead vendido o dado de baja no se reinicia al entrar a otra campaña", () => {
    const hoy28m = fila({ campania_actual: "28M", fecha_inicio_28m: "2026-10-01", fecha_fin_28m: "2026-11-01" });
    expect(planificarLeads([hoy28m], [lead({ estado: "ganada" })], ROSTER).pasosNuevos[0].reiniciar).toBe(false);
    expect(planificarLeads([hoy28m], [lead({ estado_contacto: "baja" })], ROSTER).pasosNuevos[0].reiniciar).toBe(false);
  });

  it("un lead que nunca tuvo paso solo abre el suyo, sin reiniciar lo que capturó el BDC", () => {
    const hoy28m = fila({ campania_actual: "28M", fecha_inicio_28m: "2026-10-01", fecha_fin_28m: "2026-11-01" });
    const p = planificarLeads([hoy28m], [lead({ pasoAbierto: null, pasosCerrados: [] })], ROSTER);
    expect(p.pasosNuevos).toEqual([expect.objectContaining({ leadId: "lead-1", reiniciar: false })]);
  });

  it("sin campaña hoy cierra el paso con el motivo de la maestra", () => {
    const conGe = planificarLeads([fueraDeCampana({ tiene_ge: true })], [lead()], ROSTER);
    expect(conGe.cerrados).toEqual([{ leadId: "lead-1", pasoId: "paso-5m", estado: "YA_TIENE_GE", motivo: "YA_TIENE_GE" }]);
    const fuera = planificarLeads([fueraDeCampana()], [lead()], ROSTER);
    expect(fuera.cerrados[0].motivo).toBe("FUERA_DE_VENTANA");
    const sinContacto = planificarLeads([fueraDeCampana({ es_contactable: false })], [lead()], ROSTER);
    expect(sinContacto.cerrados[0].motivo).toBe("NO_CONTACTABLE_FUENTE");
    const desaparecio = planificarLeads([], [lead()], ROSTER);
    expect(desaparecio.cerrados[0].motivo).toBe("NO_EN_MAESTRA");
  });

  it("el mismo paso que vuelve a la ventana se reabre tal cual (sin reiniciar el lead)", () => {
    const cerrado = lead({ estado_cartera: "NO_CONTACTABLE_FUENTE", pasoAbierto: null, pasosCerrados: [{ id: "paso-5m", clave: `${VIN}|5M|2026-10-01`, campana: "5M" }] });
    const p = planificarLeads([fila()], [cerrado], ROSTER);
    expect(p.reabiertos).toEqual([expect.objectContaining({ leadId: "lead-1", pasoId: "paso-5m" })]);
    expect(p.pasosNuevos).toHaveLength(0);
  });

  it("un lead sin paso abierto solo actualiza su estado de cartera cuando cambia", () => {
    const sinPaso = lead({ estado_cartera: "FUERA_DE_VENTANA", pasoAbierto: null });
    expect(planificarLeads([fueraDeCampana({ tiene_ge: true })], [sinPaso], ROSTER).carteraCambiada).toEqual([{ leadId: "lead-1", estado: "YA_TIENE_GE" }]);
    expect(planificarLeads([fueraDeCampana()], [sinPaso], ROSTER).carteraCambiada).toEqual([]);
  });

  it("6M histórico pasa a 5M renombrando el mismo paso (conserva todo, como la migración del Sheet)", () => {
    const con6m = lead({ pasoAbierto: { id: "paso-6m", clave: `${VIN}|6M|2026-11-15`, campana: "6M" } });
    const p = planificarLeads([fila()], [con6m], ROSTER);
    expect(p.renombrados).toEqual([expect.objectContaining({ leadId: "lead-1", pasoId: "paso-6m" })]);
    expect(p.cerrados).toHaveLength(0);
    expect(p.pasosNuevos).toHaveLength(0);
  });

  it("un VIN nuevo crea un lead con el ejecutivo de menor carga; los ya asignados no cambian", () => {
    const otros = [
      lead({ id: "a", vin: "VINA", ejecutivo: "María José Nuñez", pasoAbierto: null, estado_cartera: "FUERA_DE_VENTANA" }),
      lead({ id: "b", vin: "VINB", ejecutivo: "María José Nuñez", pasoAbierto: null, estado_cartera: "FUERA_DE_VENTANA" }),
      lead({ id: "c", vin: "VINC", ejecutivo: "Fernando Zazueta", pasoAbierto: null, estado_cartera: "FUERA_DE_VENTANA" }),
    ];
    const p = planificarLeads(
      [fila(), fila({ vin: "3N1AB7AP0RY000002" }), fueraDeCampana({ vin: "VINA" }), fueraDeCampana({ vin: "VINB" }), fueraDeCampana({ vin: "VINC" })],
      otros,
      ROSTER,
    );
    expect(p.leadsNuevos.map((n) => n.ejecutivo)).toEqual(["Fernando Zazueta", "María José Nuñez"]);
  });

  it("un VIN nuevo que hoy no está en campaña no crea lead", () => {
    expect(planificarLeads([fueraDeCampana()], [], ROSTER).leadsNuevos).toHaveLength(0);
  });

  it("aborta si la maestra trae un VIN repetido o hay dos leads del mismo VIN", () => {
    expect(planificarLeads([fila(), fila()], [], ROSTER).conflictos).toContain("La base de clientes trae un VIN repetido.");
    expect(planificarLeads([fila()], [lead(), lead({ id: "lead-2" })], ROSTER).conflictos).toContain("Hay dos leads para el mismo VIN.");
  });

  it("reparte los leads nuevos de forma equilibrada", () => {
    const filas = Array.from({ length: 6 }, (_, i) => fila({ vin: `3N1AB7AP0RY00010${i}` }));
    const p = planificarLeads(filas, [], ROSTER);
    const por = (e: string) => p.leadsNuevos.filter((n) => n.ejecutivo === e).length;
    expect([por(ROSTER[0]), por(ROSTER[1])]).toEqual([3, 3]);
  });

  it("es idempotente: aplicar el plan y volver a planificar solo refresca", () => {
    const primero = planificarLeads([fila()], [], ROSTER);
    expect(primero.leadsNuevos).toHaveLength(1);
    const ya = lead({ ejecutivo: primero.leadsNuevos[0].ejecutivo, pasoAbierto: { id: "p", clave: primero.leadsNuevos[0].clave, campana: "5M" } });
    const segundo = planificarLeads([fila()], [ya], ROSTER);
    expect(segundo.leadsNuevos).toHaveLength(0);
    expect(segundo.pasosNuevos).toHaveLength(0);
    expect(segundo.cerrados).toHaveLength(0);
    expect(segundo.siguen).toHaveLength(1);
  });

  it("deduplica contactos por teléfono, quedándose con la factura más reciente", () => {
    const filas = [
      fila({ vin: "3N1AB7AP0RY000201", fecha_factura: "2025-01-01", cliente: "Viejo" }),
      fila({ vin: "3N1AB7AP0RY000202", fecha_factura: "2026-05-01", cliente: "Nuevo" }),
    ];
    const p = planificarLeads(filas, [], ROSTER);
    expect(p.contactos.size).toBe(1);
    expect([...p.contactos.values()][0].cliente).toBe("Nuevo");
  });

  it("cada VIN activo termina con exactamente un paso abierto", () => {
    const p = planificarLeads([fila(), fila({ vin: "3N1AB7AP0RY000002" })], [lead()], ROSTER);
    expect(p.conflictos).toEqual([]);
    expect(p.siguen.length + p.leadsNuevos.length).toBe(2);
  });
});
