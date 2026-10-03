import { getBigQuery } from "./bigquery.js";
import { getPool } from "./db.js";
import { env } from "../config/env.js";

/**
 * Sincronización BigQuery -> modelo relacional del CRM.
 *
 * Reglas (docs de Operación BDC):
 *  - BigQuery manda en cartera y campaña; la app no recalcula quién entra a una campaña.
 *  - Identidad de oportunidad: VIN | campaña | fecha de inicio. 6M histórico = 5M.
 *  - Nunca se borra una oportunidad: si deja de estar activa se cierra con su estado de cartera.
 *  - La gestión manual (etapa, contacto, comentarios, fechas, ejecutivo) no se sobrescribe jamás.
 *  - Una oportunidad nueva arranca en la primera etapa, con el ejecutivo menos cargado del roster.
 *  - Se planifica todo en memoria, se valida, y solo entonces se escribe (en una transacción).
 *  - Sin PII en logs ni en el resumen que se devuelve: solo conteos.
 */

export type FilaMaestra = Record<string, unknown>;

export type OportunidadExistente = {
  id: string;
  clave: string;
  vin: string;
  campana: string | null;
  estado_cartera: string;
  ejecutivo: string | null;
  estado: string;
};

export type EstadoCartera = "ACTIVA" | "YA_TIENE_GE" | "NO_CONTACTABLE_FUENTE" | "FUERA_DE_VENTANA" | "NO_EN_MAESTRA";

/** Datos de fuente de una oportunidad activa, listos para escribir. */
export type DatosFuente = {
  clave: string;
  vin: string;
  campana: string;
  fecha_inicio_campana: string;
  fecha_fin_campana: string | null;
  fase_campana: string | null;
  proxima_campania: string | null;
  fecha_proxima_campania: string | null;
  motivo_no_elegible: string | null;
  fuente: Record<string, unknown>;
  contacto_clave: string;
};

export type Plan = {
  filasFuente: number;
  activasFuente: number;
  nuevas: (DatosFuente & { ejecutivo: string | null })[];
  actualizadas: { id: string; datos: DatosFuente }[];
  migradas: { id: string; datos: DatosFuente }[];
  cerradas: { id: string; estado: EstadoCartera }[];
  /** Cuántas filas existentes ya estaban en el estado que les toca (no se tocan). */
  sinCambio: number;
  conflictos: string[];
  /** Contactos y vehículos a upsertar (solo los de oportunidades activas / vehículos ya conocidos). */
  contactos: Map<string, FilaMaestra>;
  vehiculos: FilaMaestra[];
  distribucionCierres: Record<string, number>;
};

const CAMPANAS = ["48H", "5M", "12M_NURTURING", "28M"] as const;

const texto = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Suma meses a 'YYYY-MM-DD' recortando el día al fin de mes (igual que DATE_ADD de BigQuery). */
function sumarMeses(fecha: string, meses: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  const total = a * 12 + (m - 1) + meses;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
}

function inicioYFin(m: FilaMaestra): { inicio: string | null; fin: string | null } {
  switch (m.campania_actual) {
    case "48H":
      return { inicio: texto(m.fecha_reporte), fin: texto(m.fecha_fin_48h) };
    case "5M":
      return { inicio: texto(m.fecha_inicio_5m), fin: texto(m.fecha_fin_5m) };
    case "12M_NURTURING": {
      const f = texto(m.fecha_factura);
      return { inicio: f ? sumarMeses(f, 11) : null, fin: texto(m.fecha_fin_12m_nurturing) };
    }
    case "28M":
      return { inicio: texto(m.fecha_inicio_28m), fin: texto(m.fecha_fin_28m) };
    default:
      return { inicio: null, fin: null };
  }
}

/** Misma regla que la migración: últimos 10 dígitos del teléfono, si no el correo, si no el VIN. */
export function claveContacto(m: FilaMaestra): string {
  const digitos = String(m.telefono_principal ?? "").replace(/\D/g, "");
  if (digitos.length >= 10) return digitos.slice(-10);
  const correo = texto(m.correo);
  if (correo) return correo.toLowerCase();
  return `vin:${texto(m.vin) ?? ""}`;
}

const CAMPOS_ESTRUCTURADOS = new Set([
  "vin", "fecha_factura", "fecha_reporte", "cve_distribuidor", "distribuidor", "agencia", "apv", "modelo", "version",
  "ano_modelo", "tipo_venta", "cliente", "telefono_principal", "telefono_origen", "tiene_celular", "correo",
  "es_contactable", "motivo_no_contactable", "tiene_ge", "cantidad_ge_activas", "fecha_fin_garantia",
  "campania_actual", "etapa", "proxima_campania", "fecha_proxima_campania", "motivo_no_elegible",
]);

/** Oportunidad activa de una fila de la maestra, o null si no es accionable hoy. */
export function oportunidadActiva(m: FilaMaestra): DatosFuente | null {
  const vin = texto(m.vin);
  const campana = texto(m.campania_actual);
  if (!vin || !campana || m.en_cartera_operativa !== true) return null;
  const { inicio, fin } = inicioYFin(m);
  if (!inicio) return null;
  const fuente: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!CAMPOS_ESTRUCTURADOS.has(k) && v !== null && v !== undefined) fuente[k] = v;
  return {
    clave: `${vin}|${campana}|${inicio}`,
    vin,
    campana,
    fecha_inicio_campana: inicio,
    fecha_fin_campana: fin,
    fase_campana: texto(m.etapa),
    proxima_campania: texto(m.proxima_campania),
    fecha_proxima_campania: texto(m.fecha_proxima_campania),
    motivo_no_elegible: texto(m.motivo_no_elegible),
    fuente,
    contacto_clave: claveContacto(m),
  };
}

/** Por qué una oportunidad dejó de estar activa, según el estado actual de su VIN en la maestra. */
export function clasificarCierre(m: FilaMaestra | undefined): Exclude<EstadoCartera, "ACTIVA"> {
  if (!m) return "NO_EN_MAESTRA";
  if (m.tiene_ge === true) return "YA_TIENE_GE";
  if (m.es_contactable === false) return "NO_CONTACTABLE_FUENTE";
  return "FUERA_DE_VENTANA";
}

/** Clave de compatibilidad VIN|campaña: un 6M histórico equivale a 5M. Solo aplica a 5M y 28M. */
function claveCompatible(vin: string, campana: string | null): string | null {
  const c = campana === "6M" ? "5M" : campana;
  return c === "5M" || c === "28M" ? `${vin}|${c}` : null;
}

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

/** Calcula todo en memoria. No escribe nada. */
export function planificar(
  maestra: FilaMaestra[],
  existentes: OportunidadExistente[],
  roster: string[],
): Plan {
  const conflictos: string[] = [];
  const porVin = new Map<string, FilaMaestra>();
  for (const m of maestra) {
    const vin = texto(m.vin);
    if (vin) porVin.set(vin, m);
  }

  const activas = new Map<string, { datos: DatosFuente; fila: FilaMaestra }>();
  for (const m of maestra) {
    const datos = oportunidadActiva(m);
    if (!datos) continue;
    if (!(CAMPANAS as readonly string[]).includes(datos.campana)) continue;
    if (activas.has(datos.clave)) conflictos.push("Oportunidad activa duplicada en la fuente.");
    activas.set(datos.clave, { datos, fila: m });
  }

  const porClaveExistente = new Map<string, OportunidadExistente>();
  for (const e of existentes) {
    if (porClaveExistente.has(e.clave)) conflictos.push("Clave de oportunidad duplicada en la operación actual.");
    porClaveExistente.set(e.clave, e);
  }

  const usadas = new Set<string>();
  const actualizadas: Plan["actualizadas"] = [];
  const migradas: Plan["migradas"] = [];

  // A. Coincidencia exacta.
  const sinCoincidencia: OportunidadExistente[] = [];
  for (const e of existentes) {
    const a = activas.get(e.clave);
    if (a) {
      actualizadas.push({ id: e.id, datos: a.datos });
      usadas.add(e.clave);
    } else {
      sinCoincidencia.push(e);
    }
  }

  // B. Compatibilidad de identidad histórica (6M = 5M, 28M = 28M) con una activa equivalente aún libre.
  const activaPorCompat = new Map<string, DatosFuente>();
  for (const [clave, a] of activas) {
    if (usadas.has(clave)) continue;
    const k = claveCompatible(a.datos.vin, a.datos.campana);
    if (k) activaPorCompat.set(k, a.datos);
  }
  const reclamadas = new Map<string, string>(); // clave activa -> id de la fila que la reclama
  const cerrar: OportunidadExistente[] = [];
  for (const e of sinCoincidencia) {
    const k = claveCompatible(e.vin, e.campana);
    const destino = k ? activaPorCompat.get(k) : undefined;
    if (destino) {
      if (reclamadas.has(destino.clave)) {
        conflictos.push("Doble migración: una oportunidad activa fue reclamada por dos filas históricas.");
        continue;
      }
      reclamadas.set(destino.clave, e.id);
      migradas.push({ id: e.id, datos: destino });
      usadas.add(destino.clave);
    } else {
      cerrar.push(e);
    }
  }

  // C. Cierre de lo que ya no está activo (nunca se borra).
  const cerradas: Plan["cerradas"] = [];
  const distribucionCierres: Record<string, number> = {};
  let sinCambio = 0;
  for (const e of cerrar) {
    const estado = clasificarCierre(porVin.get(e.vin));
    distribucionCierres[estado] = (distribucionCierres[estado] ?? 0) + 1;
    if (e.estado_cartera === estado) sinCambio++;
    else cerradas.push({ id: e.id, estado });
  }

  // Nuevas: activas que ninguna fila existente cubre. Se asignan al ejecutivo menos cargado.
  // La carga es la que quedará DESPUÉS de esta corrida (sin contar lo que se cierra hoy).
  const carga = new Map<string, number>();
  const idsQueSeguiranActivos = new Set([...actualizadas, ...migradas].map((x) => x.id));
  for (const e of existentes) {
    if (e.ejecutivo && e.estado === "abierta" && idsQueSeguiranActivos.has(e.id)) carga.set(e.ejecutivo, (carga.get(e.ejecutivo) ?? 0) + 1);
  }
  const nuevas: Plan["nuevas"] = [];
  for (const [clave, a] of activas) {
    if (usadas.has(clave)) continue;
    nuevas.push({ ...a.datos, ejecutivo: menosCargado(roster, carga) });
  }

  // Validación: claves finales sin duplicar.
  const finales = new Set<string>();
  const finalesLista = [
    ...existentes.filter((e) => !migradas.some((m) => m.id === e.id)).map((e) => e.clave),
    ...migradas.map((m) => m.datos.clave),
    ...nuevas.map((n) => n.clave),
  ];
  for (const c of finalesLista) {
    if (finales.has(c)) conflictos.push("Clave de oportunidad duplicada tras el plan.");
    finales.add(c);
  }
  for (const clave of activas.keys()) {
    if (!finales.has(clave)) conflictos.push("Una oportunidad activa quedó sin fila.");
  }

  // Contactos: uno por clave, con los datos de la factura más reciente.
  const contactos = new Map<string, FilaMaestra>();
  const todasActivas = [...activas.values()];
  for (const { datos, fila } of todasActivas) {
    const previo = contactos.get(datos.contacto_clave);
    if (!previo || String(fila.fecha_factura ?? "") > String(previo.fecha_factura ?? "")) contactos.set(datos.contacto_clave, fila);
  }

  // Vehículos: los de oportunidades activas y los que la operación ya conoce (para refrescar tiene_ge, etc.).
  const vinsNecesarios = new Set<string>([...existentes.map((e) => e.vin), ...todasActivas.map((a) => a.datos.vin)]);
  const vehiculos = [...vinsNecesarios].map((v) => porVin.get(v)).filter((m): m is FilaMaestra => Boolean(m));

  return {
    filasFuente: maestra.length,
    activasFuente: activas.size,
    nuevas,
    actualizadas,
    migradas,
    cerradas,
    sinCambio,
    conflictos: [...new Set(conflictos)],
    contactos,
    vehiculos,
    distribucionCierres,
  };
}

/** Lee toda la maestra. Fechas llegan como 'YYYY-MM-DD' y la marca de tiempo como ISO (TO_JSON_STRING). */
export async function leerMaestra(): Promise<FilaMaestra[]> {
  const tabla = "base-maestra-gn.garantias_extendidas.nis_ge_cartera_maestra";
  const [filas] = await getBigQuery().query({
    query: `SELECT TO_JSON_STRING(t) AS j FROM \`${tabla}\` t`,
    location: env.BIGQUERY_LOCATION,
  });
  return (filas as { j: string }[]).map((f) => JSON.parse(f.j) as FilaMaestra);
}

async function cargarEstadoActual(sucursalId: string) {
  const pool = getPool();
  const { rows: existentes } = await pool.query(
    `SELECT o.id, o.clave, v.vin, o.campana, o.estado_cartera, o.ejecutivo, o.estado
       FROM crm_oportunidades o JOIN crm_vehiculos v ON v.id = o.vehiculo_id
      WHERE o.sucursal_id = $1`,
    [sucursalId],
  );
  const { rows: cfg } = await pool.query(`SELECT roster_ejecutivos FROM crm_config WHERE sucursal_id = $1`, [sucursalId]);
  const roster = (cfg[0]?.roster_ejecutivos as string[] | undefined) ?? [];
  return {
    existentes: existentes as OportunidadExistente[],
    roster,
  };
}

export type ResumenSync = {
  modo: "simulacion" | "real";
  filasFuente: number;
  activasFuente: number;
  nuevas: number;
  actualizadas: number;
  migradas: number;
  cerradas: number;
  sinCambio: number;
  conflictos: string[];
  cierresPorEstado: Record<string, number>;
};

const resumenDe = (modo: ResumenSync["modo"], p: Plan): ResumenSync => ({
  modo,
  filasFuente: p.filasFuente,
  activasFuente: p.activasFuente,
  nuevas: p.nuevas.length,
  actualizadas: p.actualizadas.length,
  migradas: p.migradas.length,
  cerradas: p.cerradas.length,
  sinCambio: p.sinCambio,
  conflictos: p.conflictos,
  cierresPorEstado: p.distribucionCierres,
});

/**
 * Si la fuente trae muy poco, o la cartera activa se desploma de un día a otro, es un
 * fallo de la fuente y no se escribe. Cerrar muchas filas de golpe sí es normal: las
 * cohortes de 5M y 28M rotan cada mes.
 */
function validarSensatez(plan: Plan, existentes: OportunidadExistente[]): string | null {
  if (plan.filasFuente < 1000) return "La fuente devolvió muy pocas filas; se aborta sin escribir.";
  if (plan.activasFuente === 0) return "La fuente no trae oportunidades activas; se aborta sin escribir.";
  const activasHoy = existentes.filter((e) => e.estado_cartera === "ACTIVA").length;
  if (activasHoy >= 50 && plan.activasFuente < activasHoy * 0.5) {
    return "Las oportunidades activas de la fuente bajaron a menos de la mitad; se aborta sin escribir.";
  }
  return null;
}

async function registrarCorrida(sucursalId: string, resumen: ResumenSync, estado: "ok" | "error", mensaje: string | null) {
  await getPool().query(
    `INSERT INTO crm_sync_corridas
       (sucursal_id, modo, estado, filas_fuente, activas_fuente, nuevas, actualizadas, migradas, cerradas, conflictos, mensaje)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      sucursalId, resumen.modo, estado, resumen.filasFuente, resumen.activasFuente, resumen.nuevas,
      resumen.actualizadas, resumen.migradas, resumen.cerradas, resumen.conflictos.length, mensaje,
    ],
  );
}

/**
 * Simula (modo "simulacion", no escribe nada salvo el registro de la corrida) o aplica
 * (modo "real") la sincronización de una sucursal.
 */
export async function sincronizarCrm(sucursalId: string, aplicar: boolean): Promise<ResumenSync> {
  const modo = aplicar ? "real" : "simulacion";
  const maestra = await leerMaestra();
  const { existentes, roster } = await cargarEstadoActual(sucursalId);
  const plan = planificar(maestra, existentes, roster);
  const resumen = resumenDe(modo, plan);

  const problema =
    plan.conflictos.length > 0
      ? "El plan tiene conflictos; no se escribe."
      : validarSensatez(plan, existentes) ?? (plan.nuevas.length > 0 && roster.length === 0 ? "Hay oportunidades nuevas pero el roster de ejecutivos está vacío." : null);

  if (problema) {
    await registrarCorrida(sucursalId, resumen, "error", problema);
    throw Object.assign(new Error(problema), { resumen });
  }

  if (!aplicar) {
    await registrarCorrida(sucursalId, resumen, "ok", "Simulación: no se escribió nada.");
    return resumen;
  }

  await aplicarPlan(sucursalId, plan);
  await registrarCorrida(sucursalId, resumen, "ok", null);
  return resumen;
}

const filaContacto = (m: FilaMaestra) => ({
  clave: claveContacto(m),
  nombre: texto(m.cliente),
  telefono: texto(m.telefono_principal),
  telefono_origen: texto(m.telefono_origen),
  tiene_celular: typeof m.tiene_celular === "boolean" ? m.tiene_celular : null,
  correo: texto(m.correo),
  es_contactable: typeof m.es_contactable === "boolean" ? m.es_contactable : null,
  motivo_no_contactable: texto(m.motivo_no_contactable),
});

const filaVehiculo = (m: FilaMaestra) => ({
  vin: texto(m.vin),
  agencia: texto(m.agencia),
  distribuidor: texto(m.distribuidor),
  cve_distribuidor: m.cve_distribuidor ?? null,
  modelo: texto(m.modelo),
  version: texto(m.version),
  ano_modelo: m.ano_modelo ?? null,
  apv: texto(m.apv),
  tipo_venta: texto(m.tipo_venta),
  fecha_factura: texto(m.fecha_factura),
  fecha_reporte: texto(m.fecha_reporte),
  tiene_ge: typeof m.tiene_ge === "boolean" ? m.tiene_ge : null,
  cantidad_ge_activas: m.cantidad_ge_activas ?? null,
  fecha_fin_garantia: texto(m.fecha_fin_garantia),
});

const filaOportunidad = (d: DatosFuente) => ({
  clave: d.clave,
  vin: d.vin,
  contacto_clave: d.contacto_clave,
  campana: d.campana,
  fecha_inicio_campana: d.fecha_inicio_campana,
  fecha_fin_campana: d.fecha_fin_campana,
  fase_campana: d.fase_campana,
  proxima_campania: d.proxima_campania,
  fecha_proxima_campania: d.fecha_proxima_campania,
  motivo_no_elegible: d.motivo_no_elegible,
  fuente: d.fuente,
});

/** Escribe el plan completo en una transacción: o entra todo, o nada. */
async function aplicarPlan(sucursalId: string, plan: Plan): Promise<void> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");

    const { rows: bloqueo } = await cliente.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`crm_sync:${sucursalId}`]);
    if (!bloqueo[0]?.ok) throw new Error("Ya hay una sincronización en curso para esta sucursal.");

    // Vehículos y contactos primero: las oportunidades los referencian por VIN / clave.
    await cliente.query(
      `INSERT INTO crm_vehiculos (sucursal_id, vin, agencia, distribuidor, cve_distribuidor, modelo, version, ano_modelo, apv,
                                  tipo_venta, fecha_factura, fecha_reporte, tiene_ge, cantidad_ge_activas, fecha_fin_garantia)
       SELECT $1, r.vin, r.agencia, r.distribuidor, r.cve_distribuidor, r.modelo, r.version, r.ano_modelo, r.apv,
              r.tipo_venta, r.fecha_factura, r.fecha_reporte, r.tiene_ge, r.cantidad_ge_activas, r.fecha_fin_garantia
         FROM jsonb_to_recordset($2::jsonb) AS r(vin text, agencia text, distribuidor text, cve_distribuidor int, modelo text,
              version text, ano_modelo int, apv text, tipo_venta text, fecha_factura date, fecha_reporte date,
              tiene_ge boolean, cantidad_ge_activas int, fecha_fin_garantia date)
       ON CONFLICT (sucursal_id, vin) DO UPDATE SET
         agencia = EXCLUDED.agencia, distribuidor = EXCLUDED.distribuidor, cve_distribuidor = EXCLUDED.cve_distribuidor,
         modelo = EXCLUDED.modelo, version = EXCLUDED.version, ano_modelo = EXCLUDED.ano_modelo, apv = EXCLUDED.apv,
         tipo_venta = EXCLUDED.tipo_venta, fecha_factura = EXCLUDED.fecha_factura, fecha_reporte = EXCLUDED.fecha_reporte,
         tiene_ge = EXCLUDED.tiene_ge, cantidad_ge_activas = EXCLUDED.cantidad_ge_activas,
         fecha_fin_garantia = EXCLUDED.fecha_fin_garantia, actualizado_en = now()`,
      [sucursalId, JSON.stringify(plan.vehiculos.map(filaVehiculo))],
    );

    await cliente.query(
      `INSERT INTO crm_contactos (sucursal_id, clave, nombre, telefono, telefono_origen, tiene_celular, correo, es_contactable, motivo_no_contactable)
       SELECT $1, r.clave, r.nombre, r.telefono, r.telefono_origen, r.tiene_celular, r.correo, r.es_contactable, r.motivo_no_contactable
         FROM jsonb_to_recordset($2::jsonb) AS r(clave text, nombre text, telefono text, telefono_origen text, tiene_celular boolean,
              correo text, es_contactable boolean, motivo_no_contactable text)
       ON CONFLICT (sucursal_id, clave) DO UPDATE SET
         nombre = EXCLUDED.nombre, telefono = EXCLUDED.telefono, telefono_origen = EXCLUDED.telefono_origen,
         tiene_celular = EXCLUDED.tiene_celular, correo = EXCLUDED.correo, es_contactable = EXCLUDED.es_contactable,
         motivo_no_contactable = EXCLUDED.motivo_no_contactable, actualizado_en = now()`,
      [sucursalId, JSON.stringify([...plan.contactos.values()].map(filaContacto))],
    );

    // Actualizadas y migradas: solo datos de fuente; etapa, contacto, comentarios, fechas y ejecutivo no se tocan.
    const actualizar = [
      ...plan.actualizadas.map((a) => ({ id: a.id, ...filaOportunidad(a.datos) })),
      ...plan.migradas.map((a) => ({ id: a.id, ...filaOportunidad(a.datos) })),
    ];
    await cliente.query(
      `UPDATE crm_oportunidades o SET
         clave = r.clave, campana = r.campana, fecha_inicio_campana = r.fecha_inicio_campana,
         fecha_fin_campana = r.fecha_fin_campana, fase_campana = r.fase_campana, proxima_campania = r.proxima_campania,
         fecha_proxima_campania = r.fecha_proxima_campania, motivo_no_elegible = r.motivo_no_elegible,
         estado_cartera = 'ACTIVA', fuente = r.fuente,
         contacto_id = (SELECT c.id FROM crm_contactos c WHERE c.sucursal_id = o.sucursal_id AND c.clave = r.contacto_clave),
         ultima_sincronizacion = now()
       FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, clave text, contacto_clave text, campana text, fecha_inicio_campana date,
              fecha_fin_campana date, fase_campana text, proxima_campania text, fecha_proxima_campania date,
              motivo_no_elegible text, fuente jsonb)
       WHERE o.id = r.id AND o.sucursal_id = $1`,
      [sucursalId, JSON.stringify(actualizar)],
    );

    if (plan.cerradas.length > 0) {
      await cliente.query(
        `UPDATE crm_oportunidades o SET estado_cartera = r.estado, ultima_sincronizacion = now()
           FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, estado text)
          WHERE o.id = r.id AND o.sucursal_id = $1`,
        [sucursalId, JSON.stringify(plan.cerradas)],
      );
    }

    if (plan.nuevas.length > 0) {
      const { rows: etapa } = await cliente.query(
        `SELECT e.id, e.embudo_id FROM crm_etapas e JOIN crm_embudos b ON b.id = e.embudo_id
          WHERE e.sucursal_id = $1 AND b.es_predeterminado AND e.activa AND e.tipo = 'abierta' ORDER BY e.orden LIMIT 1`,
        [sucursalId],
      );
      if (!etapa[0]) throw new Error("La sucursal no tiene un embudo con etapa inicial.");
      const { rows: pos } = await cliente.query(`SELECT coalesce(max(posicion), 0) AS p FROM crm_oportunidades WHERE etapa_id = $1`, [etapa[0].id]);

      const { rows: insertadas } = await cliente.query(
        `INSERT INTO crm_oportunidades
           (sucursal_id, clave, contacto_id, vehiculo_id, campana, fecha_inicio_campana, fecha_fin_campana, fase_campana,
            proxima_campania, fecha_proxima_campania, motivo_no_elegible, estado_cartera, fuente, embudo_id, etapa_id,
            posicion, estado, estado_contacto, ejecutivo, ultima_sincronizacion)
         SELECT $1, r.clave,
                (SELECT c.id FROM crm_contactos c WHERE c.sucursal_id = $1 AND c.clave = r.contacto_clave),
                (SELECT v.id FROM crm_vehiculos v WHERE v.sucursal_id = $1 AND v.vin = r.vin),
                r.campana, r.fecha_inicio_campana, r.fecha_fin_campana, r.fase_campana, r.proxima_campania,
                r.fecha_proxima_campania, r.motivo_no_elegible, 'ACTIVA', r.fuente, $3, $4,
                $5::float8 + r.n * 1024, 'abierta', 'sin_intentar', r.ejecutivo, now()
           FROM jsonb_to_recordset($2::jsonb) AS r(n int, clave text, vin text, contacto_clave text, campana text,
                fecha_inicio_campana date, fecha_fin_campana date, fase_campana text, proxima_campania text,
                fecha_proxima_campania date, motivo_no_elegible text, fuente jsonb, ejecutivo text)
         RETURNING id`,
        [
          sucursalId,
          JSON.stringify(plan.nuevas.map((n, i) => ({ n: i + 1, ...filaOportunidad(n), ejecutivo: n.ejecutivo }))),
          etapa[0].embudo_id,
          etapa[0].id,
          pos[0].p,
        ],
      );
      await cliente.query(
        `INSERT INTO crm_historial_etapas (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, origen)
         SELECT $1, x.id, NULL, $2, 'sync' FROM unnest($3::uuid[]) AS x(id)`,
        [sucursalId, etapa[0].id, insertadas.map((r) => r.id)],
      );
    }

    await cliente.query("COMMIT");
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/* ---------- Corrida diaria programada ---------- */

const ZONA_NEGOCIO = "America/Hermosillo";
/** Hora local (Hermosillo) en que corre: la maestra se refresca a las 09:30. */
const HORA_SYNC = 10;

let temporizadorSync: NodeJS.Timeout | null = null;
let sincronizando = false;

function ahoraEnNegocio(): { fecha: string; hora: number } {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_NEGOCIO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return { fecha: `${g("year")}-${g("month")}-${g("day")}`, hora: Number(g("hour")) };
}

async function sincronizarPendientesDeHoy(): Promise<void> {
  const { fecha, hora } = ahoraEnNegocio();
  if (hora !== HORA_SYNC) return;
  const { rows } = await getPool().query(
    `SELECT c.sucursal_id FROM crm_config c
      WHERE NOT EXISTS (
        SELECT 1 FROM crm_sync_corridas r
         WHERE r.sucursal_id = c.sucursal_id AND r.modo = 'real' AND r.estado = 'ok'
           AND (r.creado_en AT TIME ZONE '${ZONA_NEGOCIO}')::date = $1::date
      )`,
    [fecha],
  );
  for (const r of rows) {
    try {
      const resumen = await sincronizarCrm(r.sucursal_id as string, true);
      console.log(`[sync-crm] ok: ${resumen.nuevas} nuevas, ${resumen.actualizadas} actualizadas, ${resumen.migradas} migradas, ${resumen.cerradas} cerradas`);
    } catch (err) {
      // Solo el motivo técnico: nunca datos de clientes.
      console.error(`[sync-crm] abortada: ${err instanceof Error ? err.message : "error"}`);
    }
  }
}

/**
 * Arranca la sincronización diaria en este proceso. Revisa cada 10 minutos y, dentro de la hora
 * configurada, corre una vez por sucursal y día. Solo se enciende con CRM_SYNC_AUTO=true.
 */
export function iniciarSyncProgramadoCrm(): void {
  if (temporizadorSync) return;
  temporizadorSync = setInterval(() => {
    if (sincronizando) return;
    sincronizando = true;
    sincronizarPendientesDeHoy()
      .catch(() => console.error("[sync-crm] fallo la revisión programada"))
      .finally(() => {
        sincronizando = false;
      });
  }, 10 * 60 * 1000);
  temporizadorSync.unref();
}
