import { getBigQuery } from "./bigquery.js";
import { getPool } from "./db.js";
import { env } from "../config/env.js";
import { vincularConversaciones } from "./vinculoWhatsapp.js";
import { ESTADOS_MEXICO } from "./programaGeLogica.js";
import { adaptarFilaCruda, campanaDeVehiculo, esFilaCruda, type EtapaVehiculo } from "./origenCrudoLogica.js";
import { leerDefinicionesActivas } from "./campanasDefinidas.js";
import { ahoraLocal } from "./campanasLogica.js";
import { recalcularEtapas } from "./cicloVehiculo.js";
import type { DefinicionCampana } from "./campanasDefLogica.js";
import { planificarLeads, type LeadExistente, type PasoExistente, type PlanLeads } from "./cicloLeadLogica.js";
import { DESTINO_DE_RESULTADO } from "./resultadoBdcLogica.js";

/**
 * Sincronización BigQuery -> modelo relacional del CRM.
 *
 * Reglas (docs de Operación BDC):
 *  - BigQuery manda en cartera y campaña (igual que en el Sheet); la web no recalcula quién entra a una campaña.
 *  - Un lead por VIN. Cada campaña en la que entra es un paso (VIN | campaña | inicio, el «ID Oportunidad» del Sheet)
 *    que nunca se borra; las reglas del ciclo diario están en cicloLeadLogica.ts.
 *  - La gestión manual (resultado, estado, contacto, comentarios, fechas, ejecutivo) no se sobrescribe jamás.
 *  - Un lead nuevo arranca en la primera etapa, con el ejecutivo menos cargado del roster; después no cambia solo.
 *  - Con la maestra real solo se sincroniza contra la corrida de hoy (ge_cartera_refresh_runs).
 *  - Se planifica todo en memoria, se valida, y solo entonces se escribe (en una transacción).
 *  - Sin PII en logs ni en el resumen que se devuelve: solo conteos.
 */

export type FilaMaestra = Record<string, unknown>;

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

const texto = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Suma meses a 'YYYY-MM-DD' recortando el día al fin de mes (igual que DATE_ADD de BigQuery). */
export function sumarMeses(fecha: string, meses: number): string {
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

/**
 * Datos para emitir que la maestra puede traer (columnas opcionales: mientras no existan llegan vacías). Se guardan en el
 * vehículo y en el contacto, pero SOLO si el campo está vacío: lo que el ejecutivo ya capturó o corrigió nunca se pisa.
 */
const CAMPOS_EMISION_FUENTE = [
  "numero_factura", "valor_factura", "numero_motor", "km", "fecha_km",
  "dir_calle", "dir_num_ext", "dir_num_int", "dir_colonia", "dir_cp", "dir_municipio", "dir_estado",
] as const;

const sinAcentos = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const ESTADO_POR_LLAVE = new Map(ESTADOS_MEXICO.map((e) => [sinAcentos(e), e]));

/** El estado como lo escribe la lista del portal («SONORA» → «Sonora»); si no se reconoce, tal cual. */
export function normalizarEstado(v: unknown): string | null {
  const t = texto(v);
  if (!t) return null;
  return ESTADO_POR_LLAVE.get(sinAcentos(t)) ?? t;
}

/** Código postal a 5 dígitos (BigQuery puede mandarlo como número: 5800 → «05800»). */
export function normalizarCp(v: unknown): string | null {
  const t = texto(v);
  if (!t) return null;
  const d = t.replace(/\D/g, "");
  return d.length >= 4 && d.length <= 5 ? d.padStart(5, "0") : null;
}

/** Kilometraje del origen (por ejemplo, de la última orden de servicio). */
function kmFuente(v: unknown): number | null {
  const t = texto(v);
  if (!t) return null;
  const n = Number(t.replace(/[,\s]/g, ""));
  return Number.isInteger(n) && n >= 0 && n <= 2_000_000 ? n : null;
}

function montoFactura(v: unknown): number | null {
  const t = texto(v);
  if (!t) return null;
  const n = Number(t.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n < 100_000_000 ? Math.round(n * 100) / 100 : null;
}

const CAMPOS_ESTRUCTURADOS = new Set([
  "vin", "fecha_factura", "fecha_reporte", "cve_distribuidor", "distribuidor", "agencia", "apv", "modelo", "version",
  "ano_modelo", "tipo_venta", "cliente", "telefono_principal", "telefono_origen", "tiene_celular", "correo",
  "es_contactable", "motivo_no_contactable", "tiene_ge", "cantidad_ge_activas", "fecha_fin_garantia",
  "campania_actual", "etapa", "proxima_campania", "fecha_proxima_campania", "motivo_no_elegible",
  ...CAMPOS_EMISION_FUENTE,
  // Origen crudo: el nombre por partes y el teléfono ya se guardan en el contacto.
  "nombre", "apellido_paterno", "apellido_materno", "telefono",
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

/**
 * Oportunidad activa de una fila del origen crudo: la campaña la decide la web con sus reglas (no BigQuery). La identidad
 * es la misma de siempre: VIN | campaña | inicio.
 */
export function oportunidadWeb(
  m: FilaMaestra,
  defs: DefinicionCampana[],
  hoy: string,
  etapas: Map<string, EtapaVehiculo>,
): DatosFuente | null {
  const vin = texto(m.vin);
  if (!vin) return null;
  const c = campanaDeVehiculo(m, defs, hoy, etapas.get(vin));
  if (!c) return null;
  const fuente: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!CAMPOS_ESTRUCTURADOS.has(k) && v !== null && v !== undefined) fuente[k] = v;
  return {
    clave: `${vin}|${c.campana}|${c.inicio}`,
    vin,
    campana: c.campana,
    fecha_inicio_campana: c.inicio,
    fecha_fin_campana: c.fin,
    fase_campana: c.fase,
    proxima_campania: c.proxima,
    fecha_proxima_campania: null,
    motivo_no_elegible: null,
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

export const TABLA_MAESTRA = "base-maestra-gn.garantias_extendidas.nis_ge_cartera_maestra";
const TABLA_VALIDA = /^[a-z0-9-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

/**
 * Lee toda la maestra (o la tabla de pruebas de la sucursal). Fechas llegan como 'YYYY-MM-DD' y la marca de tiempo como
 * ISO (TO_JSON_STRING).
 */
export async function leerMaestra(tabla: string = TABLA_MAESTRA): Promise<FilaMaestra[]> {
  if (!TABLA_VALIDA.test(tabla)) throw new Error("La base de clientes configurada no es válida.");
  const [filas] = await getBigQuery().query({
    query: `SELECT TO_JSON_STRING(t) AS j FROM \`${tabla}\` t`,
    location: env.BIGQUERY_LOCATION,
  });
  return (filas as { j: string }[]).map((f) => JSON.parse(f.j) as FilaMaestra);
}

/** La etapa del vehículo que ya calculó la app (por meses y km), para las campañas que piden una etapa. */
async function etapasPorVin(sucursalId: string): Promise<Map<string, EtapaVehiculo>> {
  const { rows } = await getPool().query(
    `SELECT v.vin, ce.orden, coalesce(v.etapa_vehiculo_motivo IN ('excluido_km', 'excluido_fecha'), false) AS excluido
       FROM crm_vehiculos v LEFT JOIN crm_ciclo_etapas ce ON ce.id = v.etapa_vehiculo_id
      WHERE v.sucursal_id = $1`,
    [sucursalId],
  );
  return new Map(rows.map((r) => [r.vin as string, { etapaOrden: (r.orden as number | null) ?? null, excluido: r.excluido === true }]));
}

/**
 * Foto de lo que capturó el BDC en el lead (columnas del Sheet + gestión de Notion), para el paso que se cierra.
 * Se usa con el lead como «o».
 */
const SQL_FOTO_PASO = `resultado_bdc = o.resultado_bdc, comentarios = o.comentarios, fecha_ultimo_contacto = o.fecha_ultimo_contacto,
                fecha_compra = o.fecha_compra, ejecutivo = o.ejecutivo, etapa_id = o.etapa_id,
                estado_contacto = o.estado_contacto, gestion = jsonb_build_object('respuesta_titular', o.respuesta_titular, 'proximo_contacto_en', o.proximo_contacto_en, 'motivo_no_interes', o.motivo_no_interes, 'declara_ge', o.declara_ge, 'donde_obtuvo_ge', o.donde_obtuvo_ge, 'fecha_compra_ge', o.fecha_compra_ge, 'conserva_auto', o.conserva_auto, 'monto_cotizado', o.monto_cotizado, 'link_enviado_en', o.link_enviado_en, 'fecha_pago', o.fecha_pago, 'origen_venta', o.origen_venta, 'escalar_posventa', o.escalar_posventa, 'clasificacion_respuesta', o.clasificacion_respuesta, 'ultimo_contacto_efectivo_en', o.ultimo_contacto_efectivo_en, 'motivo_perdida_id', o.motivo_perdida_id)`;

/**
 * Guarda lo que hoy tiene el lead en la foto de su último paso cerrado. Para leads sin paso abierto: lo que el BDC
 * capturó fuera de ventana (el cliente llamó después) queda en la campaña a la que pertenece antes de que el ciclo
 * reinicie el lead o le restaure otro paso. Si ese último paso se cerró hoy, la foto queda igual.
 */
async function guardarFotoUltimoPaso(cliente: Consulta, sucursalId: string, leads: string[]): Promise<void> {
  if (leads.length === 0) return;
  await cliente.query(
    `UPDATE crm_oportunidad_campanas c SET ${SQL_FOTO_PASO}
       FROM crm_oportunidades o
      WHERE o.sucursal_id = $1 AND o.id = ANY($2::uuid[])
        AND NOT EXISTS (SELECT 1 FROM crm_oportunidad_campanas a WHERE a.oportunidad_id = o.id AND a.cerrada_en IS NULL)
        AND c.id = (SELECT x.id FROM crm_oportunidad_campanas x
                     WHERE x.oportunidad_id = o.id AND x.cerrada_en IS NOT NULL
                     ORDER BY x.cerrada_en DESC, x.abierta_en DESC LIMIT 1)`,
    [sucursalId, leads],
  );
}

/** Leads de la sucursal con su paso abierto y los pasos ya cerrados (para el ciclo del día). */
async function cargarLeads(sucursalId: string): Promise<{ leads: LeadExistente[]; roster: string[] }> {
  const pool = getPool();
  const { rows: leads } = await pool.query(
    // Si la persona pidió no ser contactada (baja en el contacto), su lead cuenta como dado de baja: no se reinicia.
    `SELECT o.id, v.vin, o.ejecutivo, o.estado, o.estado_cartera,
            CASE WHEN c.whatsapp_baja THEN 'baja' ELSE o.estado_contacto END AS estado_contacto
       FROM crm_oportunidades o
       JOIN crm_vehiculos v ON v.id = o.vehiculo_id
       JOIN crm_contactos c ON c.id = o.contacto_id
      WHERE o.sucursal_id = $1`,
    [sucursalId],
  );
  const { rows: pasos } = await pool.query(
    `SELECT id, oportunidad_id, clave, campana, cerrada_en IS NULL AS abierto FROM crm_oportunidad_campanas WHERE sucursal_id = $1`,
    [sucursalId],
  );
  const porLead = new Map<string, { abierto: PasoExistente | null; cerrados: PasoExistente[] }>();
  for (const p of pasos) {
    const x = porLead.get(p.oportunidad_id as string) ?? { abierto: null, cerrados: [] };
    const paso = { id: p.id as string, clave: p.clave as string, campana: p.campana as string };
    if (p.abierto) x.abierto = paso;
    else x.cerrados.push(paso);
    porLead.set(p.oportunidad_id as string, x);
  }
  const { rows: cfg } = await pool.query(`SELECT roster_ejecutivos FROM crm_config WHERE sucursal_id = $1`, [sucursalId]);
  return {
    leads: leads.map((l) => ({
      id: l.id as string,
      vin: l.vin as string,
      ejecutivo: (l.ejecutivo as string | null) ?? null,
      estado: l.estado as string,
      estado_contacto: l.estado_contacto as string,
      estado_cartera: l.estado_cartera as EstadoCartera,
      pasoAbierto: porLead.get(l.id as string)?.abierto ?? null,
      pasosCerrados: porLead.get(l.id as string)?.cerrados ?? [],
    })),
    roster: (cfg[0]?.roster_ejecutivos as string[] | undefined) ?? [],
  };
}

export type ResumenSync = {
  modo: "simulacion" | "real";
  filasFuente: number;
  activasFuente: number;
  /** Entradas a campaña: leads nuevos + pasos nuevos de leads que ya existían (lo que el Sheet cuenta como filas nuevas). */
  nuevas: number;
  leadsNuevos: number;
  pasosNuevos: number;
  /** Mismo paso de ayer: solo se refrescaron datos de origen. */
  actualizadas: number;
  reabiertas: number;
  /** 6M → 5M: el paso cambió de clave y conservó todo. */
  migradas: number;
  cerradas: number;
  sinCambio: number;
  conflictos: string[];
  cierresPorEstado: Record<string, number>;
};

const resumenDe = (modo: ResumenSync["modo"], p: PlanLeads, totalLeads: number): ResumenSync => {
  const tocados = new Set([
    ...p.siguen.map((x) => x.leadId),
    ...p.renombrados.map((x) => x.leadId),
    ...p.reabiertos.map((x) => x.leadId),
    ...p.pasosNuevos.map((x) => x.leadId),
    ...p.cerrados.map((x) => x.leadId),
    ...p.carteraCambiada.map((x) => x.leadId),
  ]);
  return {
    modo,
    filasFuente: p.filasFuente,
    activasFuente: p.activasFuente,
    nuevas: p.leadsNuevos.length + p.pasosNuevos.length,
    leadsNuevos: p.leadsNuevos.length,
    pasosNuevos: p.pasosNuevos.length,
    actualizadas: p.siguen.length,
    reabiertas: p.reabiertos.length,
    migradas: p.renombrados.length,
    cerradas: p.cerrados.length,
    sinCambio: totalLeads - tocados.size,
    conflictos: p.conflictos,
    cierresPorEstado: p.distribucionCierres,
  };
};

/**
 * Si la fuente trae muy poco, o la cartera activa se desploma de un día a otro, es un
 * fallo de la fuente y no se escribe. Cerrar muchos pasos de golpe sí es normal: las
 * cohortes de 5M y 28M rotan cada mes.
 */
function validarSensatez(plan: PlanLeads, leads: LeadExistente[], esPrueba = false): string | null {
  // Una tabla de pruebas es chica a propósito: solo se exige que traiga algo activo.
  if (esPrueba) return plan.activasFuente === 0 ? "La base de prueba no trae oportunidades activas; se aborta sin escribir." : null;
  if (plan.filasFuente < 1000) return "La base de clientes devolvió muy pocas filas; se aborta sin escribir.";
  if (plan.activasFuente === 0) return "La base de clientes no trae oportunidades activas; se aborta sin escribir.";
  const activasHoy = leads.filter((l) => l.estado_cartera === "ACTIVA").length;
  if (activasHoy >= 50 && plan.activasFuente < activasHoy * 0.5) {
    return "Las oportunidades activas de la base de clientes bajaron a menos de la mitad; se aborta sin escribir.";
  }
  return null;
}

/**
 * La maestra se rearma cada mañana (09:30). Si la corrida de hoy no terminó bien, la tabla trae los datos de ayer y
 * sincronizar abriría o cerraría campañas con la fecha equivocada: mejor no escribir.
 */
async function verificarFrescura(tabla: string): Promise<string | null> {
  const [proyecto, dataset] = tabla.split(".");
  const [filas] = await getBigQuery().query({
    query: `SELECT status, CAST(fecha_negocio AS STRING) AS fecha FROM \`${proyecto}.${dataset}.ge_cartera_refresh_runs\` ORDER BY inicio DESC LIMIT 1`,
    location: env.BIGQUERY_LOCATION,
  });
  const ultima = (filas as { status: string; fecha: string }[])[0];
  if (!ultima) return "No hay registro de actualizaciones de la base de clientes; no se sincroniza.";
  if (ultima.status !== "SUCCEEDED") return "La última actualización de la base de clientes falló; no se sincroniza con datos viejos.";
  if (ultima.fecha !== ahoraLocal().fecha) return "La base de clientes todavía no se actualiza hoy; no se sincroniza con datos de ayer.";
  return null;
}

async function registrarCorrida(sucursalId: string, resumen: ResumenSync, estado: "ok" | "error", mensaje: string | null) {
  await getPool().query(
    `INSERT INTO crm_sync_corridas
       (sucursal_id, modo, estado, filas_fuente, activas_fuente, nuevas, actualizadas, migradas, cerradas, conflictos, mensaje)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      sucursalId, resumen.modo, estado, resumen.filasFuente, resumen.activasFuente, resumen.nuevas,
      resumen.actualizadas + resumen.reabiertas, resumen.migradas, resumen.cerradas, resumen.conflictos.length, mensaje,
    ],
  );
}

/**
 * Vista previa de solo lectura (como previsualizarMigracionGEXT del Apps Script): lee la maestra y los leads, calcula
 * el ciclo del día con las campañas de la maestra y devuelve solo conteos. No escribe nada, ni la bitácora. Sirve para
 * revisar antes de cambiar de fuente (p. ej. de la tabla de prueba a la maestra real).
 */
export async function previsualizarCiclo(sucursalId: string, tabla: string = TABLA_MAESTRA) {
  const esPrueba = tabla !== TABLA_MAESTRA;
  const frescura = esPrueba ? null : await verificarFrescura(tabla);
  const maestra = await leerMaestra(tabla);
  const { leads, roster } = await cargarLeads(sucursalId);
  const plan = planificarLeads(maestra, leads, roster);
  const contar = <T,>(xs: T[], clave: (x: T) => string) =>
    xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [clave(x)]: (acc[clave(x)] ?? 0) + 1 }), {});
  return {
    ...resumenDe("simulacion", plan, leads.length),
    frescura,
    sensatez: validarSensatez(plan, leads, esPrueba),
    reiniciados: plan.pasosNuevos.filter((p) => p.reiniciar).length,
    leadsNuevosPorCampana: contar(plan.leadsNuevos, (n) => n.campana),
    leadsNuevosPorEjecutivo: contar(plan.leadsNuevos, (n) => n.ejecutivo ?? "SIN_ASIGNAR"),
    pasosNuevosPorCampana: contar(plan.pasosNuevos, (p) => p.datos.campana),
    reabiertosPorCampana: contar(plan.reabiertos, (r) => r.datos.campana),
    carteraCambiada: plan.carteraCambiada.length,
  };
}

/**
 * Simula (modo "simulacion", no escribe nada salvo el registro de la corrida) o aplica
 * (modo "real") la sincronización de una sucursal.
 */
export async function sincronizarCrm(sucursalId: string, aplicar: boolean): Promise<ResumenSync> {
  const modo = aplicar ? "real" : "simulacion";
  const { rows: habilitada } = await getPool().query(
    `SELECT sync_bigquery, bq_tabla_fuente, campanas_fuente FROM crm_config WHERE sucursal_id = $1`,
    [sucursalId],
  );
  if (!habilitada[0]?.sync_bigquery) throw new Error("Esta sucursal no tiene activada la sincronización de la base de clientes.");
  const tabla = (habilitada[0]?.bq_tabla_fuente as string | null) ?? TABLA_MAESTRA;
  const esPrueba = tabla !== TABLA_MAESTRA;

  // Con la maestra real, solo se sincroniza contra la corrida de hoy.
  if (!esPrueba) {
    const vieja = await verificarFrescura(tabla);
    if (vieja) throw new Error(vieja);
  }

  const crudas = await leerMaestra(tabla);
  const { leads, roster } = await cargarLeads(sucursalId);

  // ¿Quién decide la campaña? Por omisión, la maestra (campania_actual), igual que el Sheet. Un origen crudo (sin
  // campaña calculada) o la opción «la web manda» usan las reglas de «Definir campañas».
  const cruda = crudas.length > 0 && esFilaCruda(crudas[0]);
  const web = cruda || (habilitada[0]?.campanas_fuente as string | null) === "web";
  const maestra = cruda ? crudas.map(adaptarFilaCruda) : crudas;
  let plan: PlanLeads;
  if (web) {
    const defs = await leerDefinicionesActivas(sucursalId);
    if (defs.length === 0) throw new Error("No hay campañas activas en Definir campañas.");
    const etapas = await etapasPorVin(sucursalId);
    const hoy = ahoraLocal().fecha;
    plan = planificarLeads(maestra, leads, roster, (m) => oportunidadWeb(m, defs, hoy, etapas));
  } else {
    plan = planificarLeads(maestra, leads, roster);
  }
  const resumen = resumenDe(modo, plan, leads.length);

  const problema =
    plan.conflictos.length > 0
      ? "El plan tiene conflictos; no se escribe."
      : validarSensatez(plan, leads, esPrueba) ??
        (plan.leadsNuevos.length > 0 && roster.length === 0 ? "Hay leads nuevos pero el roster de ejecutivos está vacío." : null);

  if (problema) {
    await registrarCorrida(sucursalId, resumen, "error", problema);
    throw Object.assign(new Error(problema), { resumen });
  }

  if (!aplicar) {
    await registrarCorrida(sucursalId, resumen, "ok", "Simulación: no se escribió nada.");
    return resumen;
  }

  await aplicarLeads(sucursalId, plan);
  // Los vehículos nuevos (o con km nuevo) quedan con su etapa calculada de una vez, sin esperar al recálculo diario.
  await recalcularEtapas(getPool(), sucursalId).catch((err) => console.error("[sync] no se pudieron recalcular las etapas", err instanceof Error ? err.message : err));
  await vincularConversaciones(sucursalId).catch(() => 0);
  await registrarCorrida(sucursalId, resumen, "ok", null);
  return resumen;
}

const filaContacto = (m: FilaMaestra) => ({
  clave: claveContacto(m),
  nombre: texto(m.cliente),
  nombre_pila: texto(m.nombre),
  apellido_paterno: texto(m.apellido_paterno),
  apellido_materno: texto(m.apellido_materno),
  telefono: texto(m.telefono_principal),
  telefono_origen: texto(m.telefono_origen),
  tiene_celular: typeof m.tiene_celular === "boolean" ? m.tiene_celular : null,
  correo: texto(m.correo),
  es_contactable: typeof m.es_contactable === "boolean" ? m.es_contactable : null,
  motivo_no_contactable: texto(m.motivo_no_contactable),
  dir_calle: texto(m.dir_calle),
  dir_num_ext: texto(m.dir_num_ext),
  dir_num_int: texto(m.dir_num_int),
  dir_colonia: texto(m.dir_colonia),
  dir_cp: normalizarCp(m.dir_cp),
  dir_municipio: texto(m.dir_municipio),
  dir_estado: normalizarEstado(m.dir_estado),
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
  numero_factura: texto(m.numero_factura)?.toUpperCase() ?? null,
  valor_factura: montoFactura(m.valor_factura),
  numero_motor: texto(m.numero_motor)?.replace(/\s/g, "").toUpperCase() ?? null,
  kilometraje: kmFuente(m.km),
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

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Vehículos y contactos de la maestra: lo que capturó el ejecutivo (emisión, km, dirección) se respeta. */
async function upsertVehiculosYContactos(cliente: Consulta, sucursalId: string, vehiculos: FilaMaestra[], contactos: Map<string, FilaMaestra>) {
  await cliente.query(
    `INSERT INTO crm_vehiculos (sucursal_id, vin, agencia, distribuidor, cve_distribuidor, modelo, version, ano_modelo, apv,
                                tipo_venta, fecha_factura, fecha_reporte, tiene_ge, cantidad_ge_activas, fecha_fin_garantia,
                                numero_factura, valor_factura, numero_motor, kilometraje)
     SELECT $1, r.vin, r.agencia, r.distribuidor, r.cve_distribuidor, r.modelo, r.version, r.ano_modelo, r.apv,
            r.tipo_venta, r.fecha_factura, r.fecha_reporte, r.tiene_ge, r.cantidad_ge_activas, r.fecha_fin_garantia,
            r.numero_factura, r.valor_factura, r.numero_motor, r.kilometraje
       FROM jsonb_to_recordset($2::jsonb) AS r(vin text, agencia text, distribuidor text, cve_distribuidor int, modelo text,
            version text, ano_modelo int, apv text, tipo_venta text, fecha_factura date, fecha_reporte date,
            tiene_ge boolean, cantidad_ge_activas int, fecha_fin_garantia date,
            numero_factura text, valor_factura numeric, numero_motor text, kilometraje int)
     ON CONFLICT (sucursal_id, vin) DO UPDATE SET
       agencia = EXCLUDED.agencia, distribuidor = EXCLUDED.distribuidor, cve_distribuidor = EXCLUDED.cve_distribuidor,
       modelo = EXCLUDED.modelo, version = EXCLUDED.version, ano_modelo = EXCLUDED.ano_modelo, apv = EXCLUDED.apv,
       tipo_venta = EXCLUDED.tipo_venta, fecha_factura = EXCLUDED.fecha_factura, fecha_reporte = EXCLUDED.fecha_reporte,
       tiene_ge = EXCLUDED.tiene_ge, cantidad_ge_activas = EXCLUDED.cantidad_ge_activas,
       fecha_fin_garantia = EXCLUDED.fecha_fin_garantia,
       -- Datos para emitir: la maestra solo llena lo vacío; lo que capturó o corrigió el ejecutivo se respeta.
       numero_factura = coalesce(crm_vehiculos.numero_factura, EXCLUDED.numero_factura),
       valor_factura = coalesce(crm_vehiculos.valor_factura, EXCLUDED.valor_factura),
       numero_motor = coalesce(crm_vehiculos.numero_motor, EXCLUDED.numero_motor),
       -- El km también: si el ejecutivo ya lo capturó, se respeta.
       kilometraje = coalesce(crm_vehiculos.kilometraje, EXCLUDED.kilometraje),
       actualizado_en = now()`,
    [sucursalId, JSON.stringify(vehiculos.map(filaVehiculo))],
  );

  await cliente.query(
    `INSERT INTO crm_contactos (sucursal_id, clave, nombre, nombre_pila, apellido_paterno, apellido_materno, telefono, telefono_origen,
                                tiene_celular, correo, es_contactable, motivo_no_contactable, dir_calle, dir_num_ext, dir_num_int, dir_colonia, dir_cp, dir_municipio, dir_estado)
     SELECT $1, r.clave, r.nombre, r.nombre_pila, r.apellido_paterno, r.apellido_materno, r.telefono, r.telefono_origen,
            r.tiene_celular, r.correo, r.es_contactable, r.motivo_no_contactable, r.dir_calle, r.dir_num_ext, r.dir_num_int, r.dir_colonia, r.dir_cp, r.dir_municipio, r.dir_estado
       FROM jsonb_to_recordset($2::jsonb) AS r(clave text, nombre text, nombre_pila text, apellido_paterno text, apellido_materno text,
            telefono text, telefono_origen text, tiene_celular boolean,
            correo text, es_contactable boolean, motivo_no_contactable text,
            dir_calle text, dir_num_ext text, dir_num_int text, dir_colonia text, dir_cp text, dir_municipio text, dir_estado text)
     ON CONFLICT (sucursal_id, clave) DO UPDATE SET
       nombre = EXCLUDED.nombre, nombre_pila = coalesce(EXCLUDED.nombre_pila, crm_contactos.nombre_pila),
       apellido_paterno = coalesce(EXCLUDED.apellido_paterno, crm_contactos.apellido_paterno),
       apellido_materno = coalesce(EXCLUDED.apellido_materno, crm_contactos.apellido_materno),
       telefono = EXCLUDED.telefono, telefono_origen = EXCLUDED.telefono_origen,
       tiene_celular = EXCLUDED.tiene_celular, correo = EXCLUDED.correo, es_contactable = EXCLUDED.es_contactable,
       motivo_no_contactable = EXCLUDED.motivo_no_contactable,
       -- La dirección se toma de la maestra solo si el contacto aún no tiene una: si el ejecutivo ya la capturó, se respeta.
       dir_calle = CASE WHEN crm_contactos.dir_calle IS NULL AND crm_contactos.dir_cp IS NULL THEN EXCLUDED.dir_calle ELSE crm_contactos.dir_calle END,
       dir_num_ext = CASE WHEN crm_contactos.dir_calle IS NULL AND crm_contactos.dir_cp IS NULL THEN EXCLUDED.dir_num_ext ELSE crm_contactos.dir_num_ext END,
       dir_num_int = CASE WHEN crm_contactos.dir_calle IS NULL AND crm_contactos.dir_cp IS NULL THEN EXCLUDED.dir_num_int ELSE crm_contactos.dir_num_int END,
       dir_colonia = CASE WHEN crm_contactos.dir_calle IS NULL AND crm_contactos.dir_cp IS NULL THEN EXCLUDED.dir_colonia ELSE crm_contactos.dir_colonia END,
       dir_municipio = CASE WHEN crm_contactos.dir_calle IS NULL AND crm_contactos.dir_cp IS NULL THEN EXCLUDED.dir_municipio ELSE crm_contactos.dir_municipio END,
       dir_estado = CASE WHEN crm_contactos.dir_calle IS NULL AND crm_contactos.dir_cp IS NULL THEN EXCLUDED.dir_estado ELSE crm_contactos.dir_estado END,
       dir_cp = CASE WHEN crm_contactos.dir_calle IS NULL AND crm_contactos.dir_cp IS NULL THEN EXCLUDED.dir_cp ELSE crm_contactos.dir_cp END,
       actualizado_en = now()`,
    [sucursalId, JSON.stringify([...contactos.values()].map(filaContacto))],
  );
}

/** Datos de campaña y de origen que el lead toma de su paso abierto; lo que captura el BDC no se toca. */
async function refrescarLeads(cliente: Consulta, sucursalId: string, filas: { id: string; datos: DatosFuente }[]) {
  if (filas.length === 0) return;
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
    [sucursalId, JSON.stringify(filas.map((f) => ({ id: f.id, ...filaOportunidad(f.datos) })))],
  );
}

/** Ventana y fase del paso (la maestra puede afinarlas de un día a otro); en los renombrados, también su identidad. */
async function refrescarPasos(cliente: Consulta, sucursalId: string, filas: { pasoId: string; datos: DatosFuente }[]) {
  if (filas.length === 0) return;
  await cliente.query(
    `UPDATE crm_oportunidad_campanas c SET
       clave = r.clave, campana = r.campana, fecha_inicio_campana = r.inicio, fecha_fin_campana = r.fin,
       fase_campana = r.fase, ultima_sincronizacion = now()
     FROM jsonb_to_recordset($2::jsonb) AS r(paso uuid, clave text, campana text, inicio date, fin date, fase text)
     WHERE c.id = r.paso AND c.sucursal_id = $1`,
    [
      sucursalId,
      JSON.stringify(
        filas.map((f) => ({
          paso: f.pasoId,
          clave: f.datos.clave,
          campana: f.datos.campana,
          inicio: f.datos.fecha_inicio_campana,
          fin: f.datos.fecha_fin_campana,
          fase: f.datos.fase_campana,
        })),
      ),
    ],
  );
}

/**
 * Un paso cerrado vuelve a la ventana. Si lo que hoy tiene el lead es de ESE paso (fue el último en cerrarse), el lead
 * sigue igual. Si es de otra campaña que vino después (ya guardada en su foto por guardarFotoUltimoPaso), el lead
 * recupera lo del paso que vuelve, como las filas del Sheet:
 *  - completo (resultado, estado del lead y su motivo, contacto, comentarios, fechas y gestión) cuando se puede;
 *  - solo lo propio de la campaña (comentarios, fechas y gestión, sin tocar resultado ni estado) si el lead está vendido
 *    (además conserva los datos de la venta) o la persona pidió no ser contactada (la baja gana).
 * La etapa de la foto, si ya no está activa, se toma por el resultado. Los intentos se recalculan con los del paso. Lo de
 * la persona o el vehículo (ya tiene GE, conserva el auto, último contacto efectivo, ejecutivo) se queda.
 */
async function restaurarReabiertos(cliente: Consulta, sucursalId: string, pasos: string[]): Promise<void> {
  // Solo los pasos que NO son el último cerrado de su lead: ahí lo que tiene el lead es de otra campaña.
  const { rows: ajenos } = await cliente.query(
    `SELECT c.id FROM crm_oportunidad_campanas c
      WHERE c.sucursal_id = $1 AND c.id = ANY($2::uuid[])
        AND c.id <> (SELECT x.id FROM crm_oportunidad_campanas x
                      WHERE x.oportunidad_id = c.oportunidad_id AND x.cerrada_en IS NOT NULL
                      ORDER BY x.cerrada_en DESC, x.abierta_en DESC LIMIT 1)`,
    [sucursalId, pasos],
  );
  const ids = ajenos.map((r) => r.id as string);
  if (ids.length === 0) return;

  const motivoDe = Object.fromEntries(Object.entries(DESTINO_DE_RESULTADO).map(([r, d]) => [r, d.motivo ?? null]));
  const etapaDe = Object.fromEntries(Object.entries(DESTINO_DE_RESULTADO).map(([r, d]) => [r, d.etapa]));

  // 1. Completo: lead no vendido, persona sin baja, con una etapa activa a la cual volver.
  const { rows: completos } = await cliente.query(
    `WITH f AS (
       SELECT c.oportunidad_id AS id, c.id AS paso, c.resultado_bdc, c.comentarios, c.fecha_ultimo_contacto, c.fecha_compra,
              c.estado_contacto, coalesce(c.gestion, '{}'::jsonb) AS g, o.etapa_id AS etapa_antes,
              e.id AS etapa_id, e.tipo, e.embudo_id,
              row_number() OVER (PARTITION BY e.id ORDER BY c.oportunidad_id) AS n
         FROM crm_oportunidad_campanas c
         JOIN crm_oportunidades o ON o.id = c.oportunidad_id
         JOIN crm_contactos k ON k.id = o.contacto_id
         JOIN LATERAL (
           SELECT e.id, e.tipo, e.embudo_id FROM crm_etapas e
            WHERE e.sucursal_id = $1 AND e.activa AND e.tipo <> 'ganada'
              AND (e.id = c.etapa_id
                   OR (e.clave = $4::jsonb->>c.resultado_bdc
                       AND NOT EXISTS (SELECT 1 FROM crm_etapas s WHERE s.id = c.etapa_id AND s.activa)))
            ORDER BY (e.id = c.etapa_id) DESC,
                     (SELECT b.es_predeterminado FROM crm_embudos b WHERE b.id = e.embudo_id) DESC NULLS LAST
            LIMIT 1
         ) e ON true
        WHERE c.id = ANY($2::uuid[]) AND c.resultado_bdc IS NOT NULL
          AND o.estado <> 'ganada' AND o.estado_contacto <> 'baja' AND NOT k.whatsapp_baja
     ), r AS (
       UPDATE crm_oportunidades o SET
         resultado_bdc = f.resultado_bdc, comentarios = f.comentarios, fecha_ultimo_contacto = f.fecha_ultimo_contacto,
         fecha_compra = f.fecha_compra,
         estado_contacto = coalesce(f.estado_contacto, o.estado_contacto),
         embudo_id = f.embudo_id, etapa_id = f.etapa_id, estado = f.tipo,
         posicion = CASE WHEN f.etapa_id IS DISTINCT FROM o.etapa_id
           THEN (SELECT coalesce(max(x.posicion), 0) FROM crm_oportunidades x WHERE x.etapa_id = f.etapa_id) + f.n * 1024
           ELSE o.posicion END,
         entro_a_etapa_en = CASE WHEN f.etapa_id IS DISTINCT FROM o.etapa_id THEN now() ELSE o.entro_a_etapa_en END,
         cerrada_en = CASE WHEN f.tipo = 'abierta' THEN NULL ELSE coalesce(o.cerrada_en, now()) END,
         motivo_perdida_id = CASE WHEN f.tipo = 'perdida' THEN coalesce(
             (SELECT mp.id FROM crm_motivos_perdida mp WHERE mp.sucursal_id = $1 AND mp.id = (f.g->>'motivo_perdida_id')::uuid),
             (SELECT mp.id FROM crm_motivos_perdida mp WHERE mp.sucursal_id = $1 AND mp.clave = $3::jsonb->>f.resultado_bdc)) END,
         respuesta_titular = f.g->>'respuesta_titular',
         proximo_contacto_en = (f.g->>'proximo_contacto_en')::timestamptz,
         motivo_no_interes = f.g->>'motivo_no_interes',
         monto_cotizado = (f.g->>'monto_cotizado')::numeric,
         link_enviado_en = (f.g->>'link_enviado_en')::date,
         fecha_pago = (f.g->>'fecha_pago')::date,
         origen_venta = f.g->>'origen_venta',
         escalar_posventa = coalesce((f.g->>'escalar_posventa')::boolean, false),
         clasificacion_respuesta = f.g->>'clasificacion_respuesta'
       FROM f WHERE o.id = f.id
       RETURNING o.id, f.paso, f.etapa_antes, f.etapa_id
     ), h AS (
       -- El paso aún está cerrado en este momento: el historial se liga a él explícitamente.
       INSERT INTO crm_historial_etapas (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, origen, campana_id)
       SELECT $1, r.id, r.etapa_antes, r.etapa_id, 'sync', r.paso FROM r WHERE r.etapa_antes IS DISTINCT FROM r.etapa_id
       RETURNING 1
     )
     SELECT r.paso FROM r`,
    [sucursalId, ids, JSON.stringify(motivoDe), JSON.stringify(etapaDe)],
  );
  const restaurados = new Set(completos.map((r) => r.paso as string));

  // 2. Solo lo propio de la campaña (vendido, baja de la persona o sin etapa a la cual volver): su fila no se pierde.
  const parciales = ids.filter((id) => !restaurados.has(id));
  if (parciales.length > 0) {
    await cliente.query(
      `UPDATE crm_oportunidades o SET
         comentarios = c.comentarios, fecha_ultimo_contacto = c.fecha_ultimo_contacto,
         respuesta_titular = c.gestion->>'respuesta_titular',
         proximo_contacto_en = (c.gestion->>'proximo_contacto_en')::timestamptz,
         motivo_no_interes = c.gestion->>'motivo_no_interes',
         escalar_posventa = coalesce((c.gestion->>'escalar_posventa')::boolean, false),
         clasificacion_respuesta = c.gestion->>'clasificacion_respuesta',
         -- Una venta conserva los datos con que se vendió.
         fecha_compra = CASE WHEN o.estado = 'ganada' THEN o.fecha_compra ELSE c.fecha_compra END,
         monto_cotizado = CASE WHEN o.estado = 'ganada' THEN o.monto_cotizado ELSE (c.gestion->>'monto_cotizado')::numeric END,
         link_enviado_en = CASE WHEN o.estado = 'ganada' THEN o.link_enviado_en ELSE (c.gestion->>'link_enviado_en')::date END,
         fecha_pago = CASE WHEN o.estado = 'ganada' THEN o.fecha_pago ELSE (c.gestion->>'fecha_pago')::date END,
         origen_venta = CASE WHEN o.estado = 'ganada' THEN o.origen_venta ELSE c.gestion->>'origen_venta' END
         FROM crm_oportunidad_campanas c
        WHERE c.id = ANY($2::uuid[]) AND o.id = c.oportunidad_id AND o.sucursal_id = $1 AND c.gestion IS NOT NULL`,
      [sucursalId, parciales],
    );
  }

  // 3. Intentos y último intento: los de la campaña que vuelve (los registra registrarContacto con su resultado).
  await cliente.query(
    `UPDATE crm_oportunidades o SET intentos = x.n, ultimo_intento_en = x.u
       FROM (SELECT c.oportunidad_id, count(a.id)::int AS n, max(a.creado_en) AS u
               FROM crm_oportunidad_campanas c
               LEFT JOIN crm_actividades a ON a.campana_id = c.id AND a.tipo IN ('llamada', 'whatsapp') AND a.detalle ? 'resultado'
              WHERE c.id = ANY($2::uuid[]) GROUP BY c.oportunidad_id) x
      WHERE o.id = x.oportunidad_id AND o.sucursal_id = $1`,
    [sucursalId, ids],
  );
}

/** Escribe el ciclo del día en una transacción: o entra todo, o nada. */
async function aplicarLeads(sucursalId: string, plan: PlanLeads): Promise<void> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");

    const { rows: bloqueo } = await cliente.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`crm_sync:${sucursalId}`]);
    if (!bloqueo[0]?.ok) throw new Error("Ya hay una sincronización en curso para esta sucursal.");

    // Vehículos y contactos primero: los leads los referencian por VIN / clave.
    await upsertVehiculosYContactos(cliente, sucursalId, plan.vehiculos, plan.contactos);


    // 1. Cierres: el paso guarda la foto de lo que capturó el BDC (así su fila queda como en el Sheet) y el lead toma
    //    el estado de cartera. Va primero: un lead que cambia de campaña cierra su paso antes de abrir el siguiente.
    if (plan.cerrados.length > 0) {
      await cliente.query(
        `UPDATE crm_oportunidad_campanas c SET cerrada_en = now(), motivo_cierre = r.motivo, ultima_sincronizacion = now(),
                ${SQL_FOTO_PASO}
           FROM jsonb_to_recordset($2::jsonb) AS r(paso uuid, motivo text), crm_oportunidades o
          WHERE c.id = r.paso AND c.sucursal_id = $1 AND c.cerrada_en IS NULL AND o.id = c.oportunidad_id`,
        [sucursalId, JSON.stringify(plan.cerrados.map((c) => ({ paso: c.pasoId, motivo: c.motivo })))],
      );
    }
    const carteras = [
      ...plan.cerrados.map((c) => ({ id: c.leadId, estado: c.estado })),
      ...plan.carteraCambiada.map((c) => ({ id: c.leadId, estado: c.estado })),
    ];
    if (carteras.length > 0) {
      await cliente.query(
        `UPDATE crm_oportunidades o SET estado_cartera = r.estado, ultima_sincronizacion = now()
           FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, estado text)
          WHERE o.id = r.id AND o.sucursal_id = $1`,
        [sucursalId, JSON.stringify(carteras)],
      );
    }

    // 2. Reabiertos: el mismo paso vuelve a la ventana tal cual; mientras está abierto, lo manual se lee del lead. Si
    //    después de cerrarlo el lead vivió otra campaña, lo que tiene hoy es de esa otra (que ya quedó en su foto): el paso
    //    que vuelve recupera lo suyo antes de abrirse. Una venta no se toca.
    if (plan.reabiertos.length > 0) {
      await guardarFotoUltimoPaso(cliente, sucursalId, plan.reabiertos.map((r) => r.leadId));
      await restaurarReabiertos(cliente, sucursalId, plan.reabiertos.map((r) => r.pasoId));
      // La foto del paso se conserva (mientras está abierto nadie la lee; al volver a cerrarse se reemplaza).
      await cliente.query(
        `UPDATE crm_oportunidad_campanas c SET cerrada_en = NULL, motivo_cierre = NULL
          WHERE c.sucursal_id = $1 AND c.id = ANY($2::uuid[])`,
        [sucursalId, plan.reabiertos.map((r) => r.pasoId)],
      );
    }

    // 3. Pasos que siguen, renombrados (6M → 5M) y reabiertos: ventana del paso y datos de origen del lead.
    const vigentes = [...plan.siguen, ...plan.renombrados, ...plan.reabiertos];
    await refrescarPasos(cliente, sucursalId, vigentes);
    await refrescarLeads(cliente, sucursalId, vigentes.map((v) => ({ id: v.leadId, datos: v.datos })));

    // Etapa inicial del embudo: a donde entran los leads nuevos y los que empiezan otra campaña.
    const { rows: etapa } = await cliente.query(
      `SELECT e.id, e.embudo_id FROM crm_etapas e JOIN crm_embudos b ON b.id = e.embudo_id
        WHERE e.sucursal_id = $1 AND b.es_predeterminado AND e.activa AND e.tipo = 'abierta' ORDER BY e.orden LIMIT 1`,
      [sucursalId],
    );
    const necesitaEtapa = plan.leadsNuevos.length > 0 || plan.pasosNuevos.some((p) => p.reiniciar);
    if (necesitaEtapa && !etapa[0]) throw new Error("La sucursal no tiene un embudo con etapa inicial.");

    // 4. Pasos nuevos de leads existentes (otra campaña): se abre el paso y el lead toma la campaña. Antes, lo que el BDC
    //    capturó después de que su último paso cerró (el cliente llamó fuera de ventana) queda en la foto de ese paso.
    if (plan.pasosNuevos.length > 0) {
      await guardarFotoUltimoPaso(cliente, sucursalId, plan.pasosNuevos.map((p) => p.leadId));
      await cliente.query(
        `INSERT INTO crm_oportunidad_campanas
           (sucursal_id, oportunidad_id, clave, campana, fecha_inicio_campana, fecha_fin_campana, fase_campana, ultima_sincronizacion)
         SELECT $1, r.lead, r.clave, r.campana, r.inicio, r.fin, r.fase, now()
           FROM jsonb_to_recordset($2::jsonb) AS r(lead uuid, clave text, campana text, inicio date, fin date, fase text)`,
        [
          sucursalId,
          JSON.stringify(
            plan.pasosNuevos.map((p) => ({
              lead: p.leadId,
              clave: p.datos.clave,
              campana: p.datos.campana,
              inicio: p.datos.fecha_inicio_campana,
              fin: p.datos.fecha_fin_campana,
              fase: p.datos.fase_campana,
            })),
          ),
        ],
      );
      await refrescarLeads(cliente, sucursalId, plan.pasosNuevos.map((p) => ({ id: p.leadId, datos: p.datos })));

      // Empieza otra campaña: el lead vuelve a «Por contactar» con lo manual en blanco, como una fila nueva del Sheet.
      // Lo de la campaña anterior quedó en la foto de su paso. Vendidos y dados de baja no se reinician.
      const reiniciar = plan.pasosNuevos.filter((p) => p.reiniciar).map((p) => p.leadId);
      if (reiniciar.length > 0) {
        const { rows: pos } = await cliente.query(`SELECT coalesce(max(posicion), 0) AS p FROM crm_oportunidades WHERE etapa_id = $1`, [etapa[0].id]);
        await cliente.query(
          `WITH antes AS (
             SELECT id, etapa_id FROM crm_oportunidades WHERE sucursal_id = $1 AND id = ANY($2::uuid[])
           ), reinicio AS (
             UPDATE crm_oportunidades o SET
               embudo_id = $4, etapa_id = $3, posicion = $5::float8 + (array_position($2::uuid[], o.id)) * 1024,
               estado = 'abierta', cerrada_en = NULL, motivo_perdida_id = NULL, entro_a_etapa_en = now(),
               resultado_bdc = 'PENDIENTE',
               estado_contacto = CASE WHEN o.estado_contacto = 'baja'
                                        OR (SELECT k.whatsapp_baja FROM crm_contactos k WHERE k.id = o.contacto_id)
                                      THEN 'baja' ELSE 'sin_intentar' END,
               intentos = 0, ultimo_intento_en = NULL, comentarios = NULL, fecha_ultimo_contacto = NULL, fecha_compra = NULL,
               -- Gestión de la campaña (Notion) en blanco; lo que es del vehículo o de la persona (ya tiene GE, conserva
               -- el auto, último contacto efectivo) se queda.
               respuesta_titular = NULL, proximo_contacto_en = NULL, motivo_no_interes = NULL, monto_cotizado = NULL,
               link_enviado_en = NULL, fecha_pago = NULL, origen_venta = NULL, escalar_posventa = false,
               respuesta_por_clasificar = false, clasificacion_respuesta = NULL
              WHERE o.sucursal_id = $1 AND o.id = ANY($2::uuid[])
             RETURNING o.id
           )
           INSERT INTO crm_historial_etapas (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, origen)
           SELECT $1, a.id, a.etapa_id, $3, 'sync' FROM antes a JOIN reinicio r ON r.id = a.id
            WHERE a.etapa_id IS DISTINCT FROM $3`,
          [sucursalId, reiniciar, etapa[0].id, etapa[0].embudo_id, pos[0].p],
        );
      }
    }

    // 5. Leads nuevos: el lead, su primer paso y su entrada al embudo.
    if (plan.leadsNuevos.length > 0) {
      const { rows: pos } = await cliente.query(`SELECT coalesce(max(posicion), 0) AS p FROM crm_oportunidades WHERE etapa_id = $1`, [etapa[0].id]);
      const { rows: insertados } = await cliente.query(
        `WITH nuevos AS (
           INSERT INTO crm_oportunidades
             (sucursal_id, clave, contacto_id, vehiculo_id, campana, fecha_inicio_campana, fecha_fin_campana, fase_campana,
              proxima_campania, fecha_proxima_campania, motivo_no_elegible, estado_cartera, fuente, embudo_id, etapa_id,
              posicion, estado, estado_contacto, ejecutivo, ultima_sincronizacion)
           SELECT $1, r.clave,
                  (SELECT c.id FROM crm_contactos c WHERE c.sucursal_id = $1 AND c.clave = r.contacto_clave),
                  (SELECT v.id FROM crm_vehiculos v WHERE v.sucursal_id = $1 AND v.vin = r.vin),
                  r.campana, r.fecha_inicio_campana, r.fecha_fin_campana, r.fase_campana, r.proxima_campania,
                  r.fecha_proxima_campania, r.motivo_no_elegible, 'ACTIVA', r.fuente, $3, $4,
                  $5::float8 + r.n * 1024, 'abierta',
                  CASE WHEN (SELECT c.whatsapp_baja FROM crm_contactos c WHERE c.sucursal_id = $1 AND c.clave = r.contacto_clave)
                       THEN 'baja' ELSE 'sin_intentar' END,
                  r.ejecutivo, now()
             FROM jsonb_to_recordset($2::jsonb) AS r(n int, clave text, vin text, contacto_clave text, campana text,
                  fecha_inicio_campana date, fecha_fin_campana date, fase_campana text, proxima_campania text,
                  fecha_proxima_campania date, motivo_no_elegible text, fuente jsonb, ejecutivo text)
           RETURNING id, clave, campana, fecha_inicio_campana, fecha_fin_campana, fase_campana
         )
         INSERT INTO crm_oportunidad_campanas
           (sucursal_id, oportunidad_id, clave, campana, fecha_inicio_campana, fecha_fin_campana, fase_campana, ultima_sincronizacion)
         SELECT $1, n.id, n.clave, n.campana, n.fecha_inicio_campana, n.fecha_fin_campana, n.fase_campana, now() FROM nuevos n
         RETURNING oportunidad_id`,
        [
          sucursalId,
          JSON.stringify(plan.leadsNuevos.map((n, i) => ({ n: i + 1, ...filaOportunidad(n), ejecutivo: n.ejecutivo }))),
          etapa[0].embudo_id,
          etapa[0].id,
          pos[0].p,
        ],
      );
      // Después del paso: así el historial queda ligado a su campaña.
      await cliente.query(
        `INSERT INTO crm_historial_etapas (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, origen)
         SELECT $1, x.id, NULL, $2, 'sync' FROM unnest($3::uuid[]) AS x(id)`,
        [sucursalId, etapa[0].id, insertados.map((r) => r.oportunidad_id)],
      );
    }

    // Al final (ya con el contacto de hoy en cada lead): una persona que pidió no ser contactada deja todos sus leads,
    // salvo ventas, en «Baja», aunque la baja haya llegado cuando ese lead estaba fuera de ventana.
    await cliente.query(
      `UPDATE crm_oportunidades o SET estado_contacto = 'baja', respuesta_por_clasificar = false
         FROM crm_contactos c
        WHERE c.id = o.contacto_id AND c.whatsapp_baja AND o.sucursal_id = $1 AND o.estado <> 'ganada'
          AND (o.estado_contacto <> 'baja' OR o.respuesta_por_clasificar)`,
      [sucursalId],
    );

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
      WHERE c.sync_bigquery AND NOT EXISTS (
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

/** Horas sin una sincronización real exitosa a partir de las cuales se avisa. */
const HORAS_SIN_SYNC_ALERTA = 36;

/**
 * Estado de la sincronización para la pantalla de Equipo: últimas corridas (solo conteos), si hoy ya
 * corrió, cuándo se refrescó la fuente y una alerta si lleva demasiado sin sincronizar.
 */
export async function estadoSincronizacion(sucursalId: string) {
  const pool = getPool();
  const { rows: cfg } = await pool.query(`SELECT sync_bigquery, bq_tabla_fuente FROM crm_config WHERE sucursal_id = $1`, [sucursalId]);
  const habilitada = cfg[0]?.sync_bigquery === true;
  const tabla = (cfg[0]?.bq_tabla_fuente as string | null) ?? TABLA_MAESTRA;
  if (!habilitada) return { habilitada: false, corridas: [], ultima_real: null, corrio_hoy: false, alerta: null, fuente_actualizada_en: null, tabla_fuente: tabla, es_prueba: tabla !== TABLA_MAESTRA };

  const { rows: corridas } = await pool.query(
    `SELECT modo, estado, filas_fuente, activas_fuente, nuevas, actualizadas, migradas, cerradas, conflictos, mensaje, creado_en
       FROM crm_sync_corridas WHERE sucursal_id = $1 ORDER BY creado_en DESC LIMIT 10`,
    [sucursalId],
  );
  const { rows: ultima } = await pool.query(
    `SELECT creado_en, (creado_en AT TIME ZONE '${ZONA_NEGOCIO}')::date = (now() AT TIME ZONE '${ZONA_NEGOCIO}')::date AS hoy,
            extract(epoch FROM now() - creado_en) / 3600 AS horas
       FROM crm_sync_corridas WHERE sucursal_id = $1 AND modo = 'real' AND estado = 'ok' ORDER BY creado_en DESC LIMIT 1`,
    [sucursalId],
  );
  const real = ultima[0];

  // Cuándo refrescó BigQuery su tabla: si la fuente está vieja, sincronizar no trae nada nuevo.
  let fuenteActualizada: string | null = null;
  try {
    const [r] = await getBigQuery().query({
      query: `SELECT CAST(MAX(fecha_actualizacion) AS STRING) AS f FROM \`${TABLA_VALIDA.test(tabla) ? tabla : TABLA_MAESTRA}\``,
      location: env.BIGQUERY_LOCATION,
    });
    fuenteActualizada = (r as { f: string | null }[])[0]?.f ?? null;
  } catch {
    fuenteActualizada = null;
  }

  const sinSync = !real || (real.horas as number) > HORAS_SIN_SYNC_ALERTA;
  return {
    habilitada: true,
    corridas,
    ultima_real: real ? real.creado_en : null,
    corrio_hoy: real?.hoy === true,
    alerta: sinSync ? `Lleva más de ${HORAS_SIN_SYNC_ALERTA} horas sin una sincronización completa de la base de clientes.` : null,
    fuente_actualizada_en: fuenteActualizada,
    tabla_fuente: tabla,
    es_prueba: tabla !== TABLA_MAESTRA,
  };
}
