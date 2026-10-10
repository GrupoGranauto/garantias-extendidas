import { getPool } from "./db.js";
import { ahoraLocal } from "./campanasLogica.js";
import { COLUMNAS_FECHA } from "./cicloVehiculo.js";
import { asignarCampana, describirDefinicion, inicioEnCampana, perteneceACampana, validarDefiniciones, type DefinicionCampana } from "./campanasDefLogica.js";

/**
 * Campañas definidas por el usuario y su cálculo diario. La regla vive en campanasDefLogica.ts (pura y probada);
 * aquí se leen y guardan las definiciones, se calcula a qué campaña pertenece cada oportunidad abierta y se
 * compara contra la campaña que manda BigQuery.
 *
 * Modo sombra: el resultado se guarda en crm_campana_calculada y NO cambia envíos ni la campaña de la oportunidad.
 */

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export type Definicion = DefinicionCampana & { id: string };

/** Las cuatro campañas que hoy calcula BigQuery, como punto de partida editable. */
const SEMILLAS: Omit<DefinicionCampana, "id">[] = [
  { nombre: "48H", tipo: "dias", columna_fecha: "fecha_factura", dias_desde: 1, dias_hasta: 4, meses_atras: null, dia_envio: null, hora_envio: null, etapa_orden: null, activa: true },
  { nombre: "5M", tipo: "meses", columna_fecha: "fecha_factura", dias_desde: null, dias_hasta: null, meses_atras: 5, dia_envio: 1, hora_envio: "09:00", etapa_orden: null, activa: true },
  { nombre: "12M_NURTURING", tipo: "dias", columna_fecha: "fecha_factura", dias_desde: 334, dias_hasta: 365, meses_atras: null, dia_envio: null, hora_envio: null, etapa_orden: null, activa: true },
  { nombre: "28M", tipo: "meses", columna_fecha: "fecha_factura", dias_desde: null, dias_hasta: null, meses_atras: 28, dia_envio: 1, hora_envio: "09:00", etapa_orden: null, activa: true },
];

const hhmm = (v: string | null | undefined) => (v ? v.slice(0, 5) : null);

const COLUMNAS_SQL = `id, orden, nombre, tipo, columna_fecha, dias_desde, dias_hasta, meses_atras, dia_envio, hora_envio::text AS hora_envio, etapa_orden, activa`;

function aDefinicion(r: any): Definicion {
  return {
    id: r.id,
    nombre: r.nombre,
    tipo: r.tipo,
    columna_fecha: r.columna_fecha,
    dias_desde: r.dias_desde,
    dias_hasta: r.dias_hasta,
    meses_atras: r.meses_atras,
    dia_envio: r.dia_envio,
    hora_envio: hhmm(r.hora_envio),
    etapa_orden: r.etapa_orden,
    activa: r.activa,
  };
}

async function leerDefs(cl: Consulta, sucursalId: string): Promise<Definicion[]> {
  const { rows } = await cl.query(`SELECT ${COLUMNAS_SQL} FROM crm_campanas_def WHERE sucursal_id = $1 ORDER BY orden`, [sucursalId]);
  return rows.map(aDefinicion);
}

/** Las campañas activas de la sucursal, en el orden del usuario (para generar oportunidades desde el origen crudo). */
export async function leerDefinicionesActivas(sucursalId: string): Promise<Definicion[]> {
  return (await leerDefs(getPool(), sucursalId)).filter((d) => d.activa);
}

/** La regla de cada campaña en una frase (para mostrarla en la pestaña de envíos), por nombre de campaña. */
export async function leerDescripciones(cl: Consulta, sucursalId: string): Promise<Map<string, string>> {
  const defs = await leerDefs(cl, sucursalId);
  return new Map(defs.map((d) => [d.nombre, describirDefinicion(d)]));
}

/** La primera vez que se abre la pantalla se siembran las campañas que ya existen en la cartera. */
async function sembrarSiVacio(sucursalId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM crm_campanas_def WHERE sucursal_id = $1`, [sucursalId]);
  if ((rows[0]?.n as number) > 0) return;
  await insertarDefs(pool, sucursalId, SEMILLAS);
  await asegurarConfigEnvio(pool, sucursalId, SEMILLAS.map((s) => s.nombre));
}

async function insertarDefs(cl: Consulta, sucursalId: string, defs: Omit<DefinicionCampana, "id">[]): Promise<void> {
  await cl.query(
    `INSERT INTO crm_campanas_def (sucursal_id, orden, nombre, tipo, columna_fecha, dias_desde, dias_hasta, meses_atras, dia_envio, hora_envio, etapa_orden, activa)
     SELECT $1, r.orden, r.nombre, r.tipo, r.columna_fecha, r.dias_desde, r.dias_hasta, r.meses_atras, r.dia_envio, r.hora_envio::time, r.etapa_orden, r.activa
       FROM jsonb_to_recordset($2::jsonb) AS r(orden int, nombre text, tipo text, columna_fecha text, dias_desde int, dias_hasta int, meses_atras int, dia_envio int, hora_envio text, etapa_orden int, activa boolean)
     ON CONFLICT (sucursal_id, nombre) DO NOTHING`,
    [sucursalId, JSON.stringify(defs.map((d, i) => ({ ...d, nombre: d.nombre.trim(), orden: i + 1 })))],
  );
}

/** Cada campaña definida debe tener su configuración de envío (apagada) para que aparezca en la pestaña de WhatsApp. */
async function asegurarConfigEnvio(cl: Consulta, sucursalId: string, nombres: string[]): Promise<void> {
  if (nombres.length === 0) return;
  await cl.query(
    `INSERT INTO crm_campanas_envio (sucursal_id, campana) SELECT $1, unnest($2::text[]) ON CONFLICT (sucursal_id, campana) DO NOTHING`,
    [sucursalId, nombres.map((n) => n.trim())],
  );
}

/* ============================================================
   Cálculo
   ============================================================ */

type Candidata = { id: string; fecha_factura: string | null; fecha_reporte: string | null; etapa_orden: number | null; excluido: boolean };

/**
 * Oportunidades a las que se les calcula campaña: abiertas, de un vehículo sin garantía extendida y de un contacto que
 * no pidió la baja. Quien no tiene teléfono utilizable también entra a la campaña (igual que en BigQuery): el envío
 * lo omite después, pero sigue siendo parte de la cartera de esa campaña.
 */
async function candidatas(cl: Consulta, sucursalId: string): Promise<Candidata[]> {
  const { rows } = await cl.query(
    `SELECT o.id, v.fecha_factura::text AS fecha_factura, v.fecha_reporte::text AS fecha_reporte, ce.orden AS etapa_orden,
            coalesce(v.etapa_vehiculo_motivo IN ('excluido_km', 'excluido_fecha'), false) AS excluido
       FROM crm_oportunidades o
       JOIN crm_vehiculos v ON v.id = o.vehiculo_id
       JOIN crm_contactos c ON c.id = o.contacto_id
       LEFT JOIN crm_ciclo_etapas ce ON ce.id = v.etapa_vehiculo_id
      WHERE o.sucursal_id = $1 AND o.estado = 'abierta'
        AND coalesce(v.tiene_ge, false) = false
        AND c.whatsapp_baja = false`,
    [sucursalId],
  );
  return rows as Candidata[];
}

export type ResultadoCalculo = { evaluadas: number; asignadas: number; traslapes: number };

/** Calcula la campaña de cada oportunidad y deja el resultado en crm_campana_calculada (reemplaza el anterior). */
export async function calcularCampanas(
  cl: Consulta,
  sucursalId: string,
  origen: "programado" | "manual" | "al_guardar",
): Promise<ResultadoCalculo> {
  const defs = (await leerDefs(cl, sucursalId)).filter((d) => d.activa);
  const lista = await candidatas(cl, sucursalId);
  const hoy = ahoraLocal().fecha;

  const filas: { oportunidad_id: string; campana_def_id: string; campana: string; inicio: string; hora_envio: string | null }[] = [];
  let traslapes = 0;
  for (const o of lista) {
    const fechaDe = (d: DefinicionCampana) => (d.columna_fecha === "fecha_reporte" ? o.fecha_reporte : o.fecha_factura);
    const { elegida, todas } = asignarCampana(defs, (d) => ({ fecha: fechaDe(d), etapaOrden: o.etapa_orden, excluido: o.excluido }), hoy);
    if (todas.length > 1) traslapes++;
    if (elegida) {
      filas.push({
        oportunidad_id: o.id,
        campana_def_id: elegida.id,
        campana: elegida.nombre,
        inicio: inicioEnCampana(elegida, fechaDe(elegida)!, hoy),
        hora_envio: elegida.tipo === "meses" ? elegida.hora_envio : null,
      });
    }
  }

  await cl.query(`DELETE FROM crm_campana_calculada WHERE sucursal_id = $1`, [sucursalId]);
  for (let i = 0; i < filas.length; i += 1000) {
    await cl.query(
      `INSERT INTO crm_campana_calculada (oportunidad_id, sucursal_id, campana_def_id, campana, inicio, hora_envio)
       SELECT r.oportunidad_id, $1, r.campana_def_id, r.campana, r.inicio::date, r.hora_envio::time
         FROM jsonb_to_recordset($2::jsonb) AS r(oportunidad_id uuid, campana_def_id uuid, campana text, inicio text, hora_envio text)`,
      [sucursalId, JSON.stringify(filas.slice(i, i + 1000))],
    );
  }
  await cl.query(
    `INSERT INTO crm_campana_calculos (sucursal_id, fecha, origen, evaluadas, asignadas, traslapes) VALUES ($1, $2::date, $3, $4, $5, $6)`,
    [sucursalId, hoy, origen, lista.length, filas.length, traslapes],
  );
  await cl.query(
    `INSERT INTO crm_config (sucursal_id, campanas_calculo_ultimo) VALUES ($1, $2::date)
     ON CONFLICT (sucursal_id) DO UPDATE SET campanas_calculo_ultimo = EXCLUDED.campanas_calculo_ultimo`,
    [sucursalId, hoy],
  );
  return { evaluadas: lista.length, asignadas: filas.length, traslapes };
}

/** Calcula en una transacción propia (para la corrida programada y el botón «Calcular ahora»). */
export async function calcularYGuardar(sucursalId: string, origen: "programado" | "manual"): Promise<ResultadoCalculo> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const r = await calcularCampanas(cliente, sucursalId, origen);
    await cliente.query("COMMIT");
    return r;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

const aMinutos = (hora: string) => {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Una vez al día, a la hora que eligió el usuario (hora de Hermosillo), calcula las campañas de cada sucursal. Solo
 * donde la web es la fuente de campañas: si vienen de la base maestra, este cálculo no se usa.
 */
export async function calcularSiToca(): Promise<number> {
  const ahora = ahoraLocal();
  const { rows } = await getPool().query(
    `SELECT d.sucursal_id, coalesce(c.campanas_calculo_hora::text, '06:00') AS hora, c.campanas_calculo_ultimo::text AS ultimo
       FROM (SELECT DISTINCT sucursal_id FROM crm_campanas_def WHERE activa) d
       JOIN crm_config c ON c.sucursal_id = d.sucursal_id AND c.campanas_fuente = 'web'`,
  );
  let corridas = 0;
  for (const r of rows) {
    if (r.ultimo && (r.ultimo as string) >= ahora.fecha) continue;
    if (ahora.minutos < aMinutos(r.hora as string)) continue;
    try {
      await calcularYGuardar(r.sucursal_id as string, "programado");
      corridas++;
    } catch (err) {
      console.error("[campanas] no se pudo calcular", r.sucursal_id, err instanceof Error ? err.message : err);
    }
  }
  return corridas;
}

/* ============================================================
   Quién manda la campaña para los envíos: la cartera de origen o la web
   ============================================================ */

export type FuenteCampanas = "bigquery" | "web";

export async function leerFuente(cl: Consulta, sucursalId: string): Promise<FuenteCampanas> {
  const { rows } = await cl.query(`SELECT campanas_fuente FROM crm_config WHERE sucursal_id = $1`, [sucursalId]);
  return rows[0]?.campanas_fuente === "web" ? "web" : "bigquery";
}

/* ============================================================
   Lectura, guardado y prueba
   ============================================================ */

export async function leerCampanasDef(sucursalId: string) {
  await sembrarSiVacio(sucursalId);
  const pool = getPool();
  const defs = await leerDefs(pool, sucursalId);
  const { rows: etapas } = await pool.query(`SELECT orden, nombre FROM crm_ciclo_etapas WHERE sucursal_id = $1 ORDER BY orden`, [sucursalId]);
  const { rows: cfg } = await pool.query(
    `SELECT campanas_calculo_hora::text AS hora, campanas_calculo_ultimo::text AS ultimo FROM crm_config WHERE sucursal_id = $1`,
    [sucursalId],
  );
  const { rows: ultima } = await pool.query(
    `SELECT fecha::text AS fecha, origen, evaluadas, asignadas, traslapes, ejecutado_en FROM crm_campana_calculos WHERE sucursal_id = $1 ORDER BY ejecutado_en DESC LIMIT 1`,
    [sucursalId],
  );
  const { rows: ciclo } = await pool.query(`SELECT columna_fecha FROM crm_ciclo_config WHERE sucursal_id = $1`, [sucursalId]);
  return {
    campanas: defs,
    etapas_vehiculo: etapas as { orden: number; nombre: string }[],
    columnas_fecha: COLUMNAS_FECHA,
    hora_calculo: hhmm(cfg[0]?.hora) ?? "06:00",
    ultimo_calculo: (cfg[0]?.ultimo as string | undefined) ?? null,
    ultima_corrida: ultima[0] ?? null,
    columna_fecha_etapas: (ciclo[0]?.columna_fecha as string | undefined) ?? "fecha_factura",
  };
}

export type ResultadoGuardarDefs = { ok: true; calculo: ResultadoCalculo } | { ok: false; error: string };

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Guarda las campañas y la hora del cálculo diario, y calcula de una vez con las reglas nuevas. */
export async function guardarCampanasDef(sucursalId: string, defs: DefinicionCampana[], horaCalculo: string): Promise<ResultadoGuardarDefs> {
  if (!HORA.test(horaCalculo)) return { ok: false, error: "La hora del cálculo no es válida (HH:MM)." };
  const error = validarDefiniciones(defs);
  if (error) return { ok: false, error };

  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    await cliente.query(`DELETE FROM crm_campanas_def WHERE sucursal_id = $1`, [sucursalId]);
    await insertarDefs(cliente, sucursalId, defs);
    await asegurarConfigEnvio(cliente, sucursalId, defs.map((d) => d.nombre));
    await cliente.query(
      `INSERT INTO crm_config (sucursal_id, campanas_calculo_hora) VALUES ($1, $2::time)
       ON CONFLICT (sucursal_id) DO UPDATE SET campanas_calculo_hora = EXCLUDED.campanas_calculo_hora, actualizado_en = now()`,
      [sucursalId, horaCalculo],
    );
    const calculo = await calcularCampanas(cliente, sucursalId, "al_guardar");
    await cliente.query("COMMIT");
    return { ok: true, calculo };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** A qué campaña caería una fecha (y una etapa del vehículo) hoy, con las reglas guardadas. No toca datos. */
export async function probarCampanas(sucursalId: string, fecha: string, etapaOrden: number | null) {
  const defs = await leerDefs(getPool(), sucursalId);
  const hoy = ahoraLocal().fecha;
  const lead = { fecha, etapaOrden };
  const resultado = defs.map((d) => ({ nombre: d.nombre, activa: d.activa, entra: perteneceACampana(d, lead, hoy) }));
  const elegida = defs.find((d) => perteneceACampana(d, lead, hoy))?.nombre ?? null;
  return { hoy, resultado, elegida };
}
