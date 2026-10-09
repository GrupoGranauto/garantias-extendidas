import { clasificarCierre, oportunidadActiva, type DatosFuente, type EstadoCartera, type FilaMaestra } from "./sincronizacionCrm.js";

/**
 * Ciclo diario de un lead por VIN (emula el Apps Script de GEXT_OPERACION sobre el modelo de la web).
 *
 * La maestra de BigQuery es una foto del día: cada mañana se rearma. La memoria (quién se contactó, qué pasó) vive en la
 * web. Un lead es un VIN; cada vez que el VIN está en una campaña se registra un paso con la clave del Sheet
 * (VIN | campaña | inicio). Como la maestra calcula el mismo inicio todos los días mientras el VIN siga en esa ventana,
 * el paso de hoy y el de ayer son el mismo.
 *
 *  - Mismo paso abierto → solo se refrescan los datos de origen.
 *  - Otra campaña → se cierra el paso anterior (CAMBIO_CAMPANA) y se abre uno nuevo; el lead vuelve a «Por contactar»
 *    salvo que esté vendido o dado de baja (lo de la campaña anterior queda en la foto de su paso).
 *  - El mismo paso vuelve a la ventana (p. ej. un día salió como no contactable) → se reabre sin reiniciar nada, como
 *    el Apps Script reactiva la misma fila. Lo que evita repetir mensajes es el registro de envíos por paso.
 *  - 6M histórico = 5M y 28M viejo = 28M mensual: el paso se renombra y conserva todo (la migración del Apps Script).
 *  - Sin campaña hoy → se cierra con el motivo de la maestra. Nunca se borra nada.
 *  - VIN nuevo con campaña → lead nuevo con el ejecutivo de menor carga (el 50/50 del Sheet), una sola vez.
 *  - Se planifica todo en memoria; ante cualquier conflicto no se escribe nada.
 */

export type MotivoCierre = "CAMBIO_CAMPANA" | Exclude<EstadoCartera, "ACTIVA">;

export type PasoExistente = { id: string; clave: string; campana: string };

export type LeadExistente = {
  id: string;
  vin: string;
  ejecutivo: string | null;
  /** abierta | ganada | perdida */
  estado: string;
  estado_contacto: string;
  estado_cartera: EstadoCartera;
  pasoAbierto: PasoExistente | null;
  pasosCerrados: PasoExistente[];
};

export type PlanLeads = {
  filasFuente: number;
  activasFuente: number;
  leadsNuevos: (DatosFuente & { ejecutivo: string | null })[];
  /** Mismo paso abierto: se refrescan los datos de origen. */
  siguen: { leadId: string; pasoId: string; datos: DatosFuente }[];
  /** Compatibilidad 6M→5M / 28M viejo→28M: el paso abierto toma la clave nueva y conserva todo. */
  renombrados: { leadId: string; pasoId: string; datos: DatosFuente }[];
  /** Un paso ya cerrado vuelve a la ventana: se reabre tal cual. */
  reabiertos: { leadId: string; pasoId: string; datos: DatosFuente }[];
  /** Otra campaña: paso nuevo; `reiniciar` = el lead vuelve a «Por contactar». */
  pasosNuevos: { leadId: string; datos: DatosFuente; reiniciar: boolean }[];
  cerrados: { leadId: string; pasoId: string; estado: Exclude<EstadoCartera, "ACTIVA">; motivo: MotivoCierre }[];
  /** Leads sin paso abierto cuyo estado de cartera cambió (p. ej. FUERA_DE_VENTANA → YA_TIENE_GE). */
  carteraCambiada: { leadId: string; estado: Exclude<EstadoCartera, "ACTIVA"> }[];
  conflictos: string[];
  /** Contactos y vehículos a upsertar. */
  contactos: Map<string, FilaMaestra>;
  vehiculos: FilaMaestra[];
  distribucionCierres: Record<string, number>;
};

const texto = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** VIN|campaña con 6M = 5M; solo 5M y 28M tienen identidad histórica equivalente. */
function claveCompatible(vin: string, campana: string | null): string | null {
  const c = campana === "6M" ? "5M" : campana;
  return c === "5M" || c === "28M" ? `${vin}|${c}` : null;
}

/** Ejecutivo de menor carga (empate: el primero del roster). La carga cuenta todos los leads, como el Sheet. */
function menosCargado(roster: string[], carga: Map<string, number>): string | null {
  let mejor: string | null = null;
  let menor = Infinity;
  for (const e of roster) {
    const c = carga.get(e) ?? 0;
    if (c < menor) {
      menor = c;
      mejor = e;
    }
  }
  if (mejor) carga.set(mejor, (carga.get(mejor) ?? 0) + 1);
  return mejor;
}

/**
 * Calcula el ciclo del día. No escribe nada. `activar` decide la campaña de hoy de cada fila: por omisión, la que trae la
 * maestra (`campania_actual`); en modo de prueba, la que calcula la web.
 */
export function planificarLeads(
  maestra: FilaMaestra[],
  leads: LeadExistente[],
  roster: string[],
  activar: (m: FilaMaestra) => DatosFuente | null = oportunidadActiva,
): PlanLeads {
  const conflictos: string[] = [];

  const porVin = new Map<string, FilaMaestra>();
  for (const m of maestra) {
    const vin = texto(m.vin)?.toUpperCase();
    if (!vin) continue;
    if (porVin.has(vin)) conflictos.push("La base de clientes trae un VIN repetido.");
    porVin.set(vin, m);
  }

  const activas = new Map<string, DatosFuente>(); // por VIN
  for (const [vin, m] of porVin) {
    const d = activar(m);
    // La llave del mapa va en mayúsculas; el VIN se queda como viene (así lo guarda el upsert de vehículos).
    if (d) activas.set(vin, { ...d, vin: texto(m.vin) ?? vin });
  }

  const leadPorVin = new Map<string, LeadExistente>();
  for (const l of leads) {
    const vin = l.vin.toUpperCase();
    if (leadPorVin.has(vin)) conflictos.push("Hay dos leads para el mismo VIN.");
    leadPorVin.set(vin, l);
  }

  const plan: PlanLeads = {
    filasFuente: maestra.length,
    activasFuente: activas.size,
    leadsNuevos: [],
    siguen: [],
    renombrados: [],
    reabiertos: [],
    pasosNuevos: [],
    cerrados: [],
    carteraCambiada: [],
    conflictos,
    contactos: new Map(),
    vehiculos: [],
    distribucionCierres: {},
  };
  const cierre = (leadId: string, paso: PasoExistente, estado: Exclude<EstadoCartera, "ACTIVA">, motivo: MotivoCierre) => {
    plan.cerrados.push({ leadId, pasoId: paso.id, estado, motivo });
    plan.distribucionCierres[motivo] = (plan.distribucionCierres[motivo] ?? 0) + 1;
  };

  for (const lead of leadPorVin.values()) {
    const vin = lead.vin.toUpperCase();
    const hoy = activas.get(vin);
    const abierto = lead.pasoAbierto;

    if (!hoy) {
      // Sin campaña hoy: se cierra lo abierto con el motivo de la maestra; lo ya cerrado solo actualiza su estado.
      const estado = clasificarCierre(porVin.get(vin));
      if (abierto) cierre(lead.id, abierto, estado, estado);
      else if (lead.estado_cartera !== estado) plan.carteraCambiada.push({ leadId: lead.id, estado });
      continue;
    }

    if (abierto && abierto.clave === hoy.clave) {
      plan.siguen.push({ leadId: lead.id, pasoId: abierto.id, datos: hoy });
      continue;
    }

    const compat = claveCompatible(vin, hoy.campana);
    if (abierto && compat && claveCompatible(vin, abierto.campana) === compat) {
      plan.renombrados.push({ leadId: lead.id, pasoId: abierto.id, datos: hoy });
      continue;
    }

    // La campaña de hoy es otra: lo abierto se cierra por cambio de campaña (en el Sheet esa fila queda FUERA_DE_VENTANA).
    if (abierto) cierre(lead.id, abierto, "FUERA_DE_VENTANA", "CAMBIO_CAMPANA");

    const previo = lead.pasosCerrados.find((p) => p.clave === hoy.clave);
    if (previo) {
      plan.reabiertos.push({ leadId: lead.id, pasoId: previo.id, datos: hoy });
    } else {
      // Un lead que nunca tuvo paso (creado antes del historial por campaña) solo abre el suyo: no hay campaña anterior
      // de la cual reiniciarlo, y lo que el BDC capturó es de esta.
      const sinPasos = !abierto && lead.pasosCerrados.length === 0;
      const terminal = lead.estado === "ganada" || lead.estado_contacto === "baja";
      plan.pasosNuevos.push({ leadId: lead.id, datos: hoy, reiniciar: !terminal && !sinPasos });
    }
  }

  // VINs nuevos con campaña: lead nuevo con el ejecutivo de menor carga.
  const carga = new Map<string, number>();
  for (const l of leadPorVin.values()) if (l.ejecutivo) carga.set(l.ejecutivo, (carga.get(l.ejecutivo) ?? 0) + 1);
  for (const [vin, d] of activas) {
    if (leadPorVin.has(vin)) continue;
    plan.leadsNuevos.push({ ...d, ejecutivo: menosCargado(roster, carga) });
  }

  // Validación: cada VIN activo termina con exactamente un paso abierto, y ninguna clave se usa dos veces.
  const abiertosFinales = new Map<string, number>();
  const sumar = (vin: string) => abiertosFinales.set(vin, (abiertosFinales.get(vin) ?? 0) + 1);
  const vinDeLead = new Map(leads.map((l) => [l.id, l.vin.toUpperCase()]));
  for (const x of [...plan.siguen, ...plan.renombrados, ...plan.reabiertos, ...plan.pasosNuevos]) sumar(vinDeLead.get(x.leadId) ?? "");
  for (const n of plan.leadsNuevos) sumar(n.vin);
  for (const vin of activas.keys()) {
    const n = abiertosFinales.get(vin) ?? 0;
    if (n === 0) conflictos.push("Un VIN activo quedó sin paso de campaña.");
    if (n > 1) conflictos.push("Un VIN quedó con más de un paso de campaña abierto.");
  }
  const claves = new Set<string>();
  for (const x of [...plan.renombrados, ...plan.pasosNuevos]) {
    if (claves.has(x.datos.clave)) conflictos.push("Clave de paso de campaña duplicada tras el plan.");
    claves.add(x.datos.clave);
  }

  // Contactos: uno por clave, con los datos de la factura más reciente. Vehículos: los activos y los ya conocidos.
  for (const d of activas.values()) {
    const fila = porVin.get(d.vin)!;
    const previo = plan.contactos.get(d.contacto_clave);
    if (!previo || String(fila.fecha_factura ?? "") > String(previo.fecha_factura ?? "")) plan.contactos.set(d.contacto_clave, fila);
  }
  const vins = new Set<string>([...leadPorVin.keys(), ...activas.keys()]);
  plan.vehiculos = [...vins].map((v) => porVin.get(v)).filter((m): m is FilaMaestra => Boolean(m));

  plan.conflictos = [...new Set(conflictos)];
  return plan;
}
