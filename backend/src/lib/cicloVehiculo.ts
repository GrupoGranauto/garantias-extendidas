import { getPool } from "./db.js";
import { ahoraLocal } from "./campanasLogica.js";
import {
  calcularEtapaVehiculo,
  validarEtapas,
  type EtapaCiclo,
  type EtapaEntrada,
  type MotivoEtapa,
} from "./cicloVehiculoLogica.js";

/**
 * Etapa del vehículo: configuración, cálculo y recálculo. La regla vive en cicloVehiculoLogica.ts (pura y probada);
 * aquí solo se leen los datos, se aplica y se guarda el resultado en el vehículo para poder filtrar y ordenar.
 */

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/** Columnas de fecha que se pueden elegir como base del cálculo. */
export const COLUMNAS_FECHA = [
  { valor: "fecha_factura", etiqueta: "Fecha de factura (venta)" },
  { valor: "fecha_reporte", etiqueta: "Fecha de reporte" },
] as const;
export type ColumnaFecha = (typeof COLUMNAS_FECHA)[number]["valor"];

const esColumnaFecha = (v: string): v is ColumnaFecha => COLUMNAS_FECHA.some((c) => c.valor === v);

async function leerConfig(cl: Consulta, sucursalId: string): Promise<{ columna: ColumnaFecha; etapas: EtapaCiclo[] }> {
  const { rows: cfg } = await cl.query(`SELECT columna_fecha FROM crm_ciclo_config WHERE sucursal_id = $1`, [sucursalId]);
  const { rows: etapas } = await cl.query(
    `SELECT id, orden, nombre, meses_desde, meses_hasta, km_max FROM crm_ciclo_etapas WHERE sucursal_id = $1 ORDER BY orden`,
    [sucursalId],
  );
  const col = (cfg[0]?.columna_fecha as string | undefined) ?? "fecha_factura";
  return { columna: esColumnaFecha(col) ? col : "fecha_factura", etapas: etapas as EtapaCiclo[] };
}

/**
 * Recalcula la etapa de los vehículos de la sucursal (o de uno solo) y guarda lo que cambió. Devuelve cuántos
 * vehículos se revisaron y cuántos cambiaron de etapa.
 */
export async function recalcularEtapas(cl: Consulta, sucursalId: string, vehiculoId: string | null = null): Promise<{ revisados: number; cambiaron: number }> {
  const { columna, etapas } = await leerConfig(cl, sucursalId);
  const { rows } = await cl.query(
    `SELECT v.id, ${columna}::text AS fecha, v.kilometraje, v.etapa_vehiculo_id, v.etapa_vehiculo_motivo
       FROM crm_vehiculos v
      WHERE v.sucursal_id = $1${vehiculoId ? " AND v.id = $2" : ""}`,
    vehiculoId ? [sucursalId, vehiculoId] : [sucursalId],
  );
  const hoy = ahoraLocal().fecha;

  const cambios: { id: string; etapa_id: string | null; motivo: MotivoEtapa }[] = [];
  for (const v of rows) {
    const r = calcularEtapaVehiculo({ etapas, fecha: (v.fecha as string | null) ?? null, km: (v.kilometraje as number | null) ?? null, hoy });
    if (r.etapaId !== v.etapa_vehiculo_id || r.motivo !== v.etapa_vehiculo_motivo) cambios.push({ id: v.id, etapa_id: r.etapaId, motivo: r.motivo });
  }

  // De a bloques: una actualización por vehículo sería lenta con miles de filas.
  for (let i = 0; i < cambios.length; i += 1000) {
    await cl.query(
      `UPDATE crm_vehiculos v SET etapa_vehiculo_id = r.etapa_id, etapa_vehiculo_motivo = r.motivo, etapa_vehiculo_calculada_en = now()
         FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, etapa_id uuid, motivo text)
        WHERE v.id = r.id AND v.sucursal_id = $1`,
      [sucursalId, JSON.stringify(cambios.slice(i, i + 1000))],
    );
  }
  if (!vehiculoId) {
    await cl.query(
      `INSERT INTO crm_ciclo_config (sucursal_id, ultimo_calculo) VALUES ($1, $2::date)
       ON CONFLICT (sucursal_id) DO UPDATE SET ultimo_calculo = EXCLUDED.ultimo_calculo`,
      [sucursalId, hoy],
    );
  }
  return { revisados: rows.length, cambiaron: cambios.length };
}

/** Una vez al día (hora de Hermosillo) recalcula a todos: con el paso de los meses, los vehículos cambian de etapa solos. */
export async function recalcularSiToca(): Promise<number> {
  const pool = getPool();
  const hoy = ahoraLocal().fecha;
  const { rows } = await pool.query(
    `SELECT DISTINCT e.sucursal_id FROM crm_ciclo_etapas e
       LEFT JOIN crm_ciclo_config c ON c.sucursal_id = e.sucursal_id
      WHERE c.ultimo_calculo IS NULL OR c.ultimo_calculo < $1::date`,
    [hoy],
  );
  let total = 0;
  for (const r of rows) total += (await recalcularEtapas(pool, r.sucursal_id as string)).cambiaron;
  return total;
}

/** Configuración actual, y cómo quedó la cartera: cuántos vehículos hay en cada etapa y cuántos excluidos. */
export async function leerCiclo(sucursalId: string) {
  const pool = getPool();
  const { columna, etapas } = await leerConfig(pool, sucursalId);
  const { rows: porEtapa } = await pool.query(
    `SELECT v.etapa_vehiculo_id AS etapa_id, coalesce(v.etapa_vehiculo_motivo, 'sin_configurar') AS motivo, count(*)::int AS n
       FROM crm_vehiculos v
      WHERE v.sucursal_id = $1 AND EXISTS (SELECT 1 FROM crm_oportunidades o WHERE o.vehiculo_id = v.id AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta')
      GROUP BY 1, 2`,
    [sucursalId],
  );
  const { rows: km } = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE v.kilometraje IS NOT NULL)::int AS con_km
       FROM crm_vehiculos v
      WHERE v.sucursal_id = $1 AND EXISTS (SELECT 1 FROM crm_oportunidades o WHERE o.vehiculo_id = v.id AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta')`,
    [sucursalId],
  );
  const { rows: cfg } = await pool.query(`SELECT ultimo_calculo::text AS ultimo_calculo FROM crm_ciclo_config WHERE sucursal_id = $1`, [sucursalId]);

  const cuenta = (id: string | null, motivo?: string) =>
    porEtapa.filter((r) => r.etapa_id === id && (motivo === undefined || r.motivo === motivo)).reduce((n, r) => n + (r.n as number), 0);
  return {
    columna_fecha: columna,
    columnas_disponibles: COLUMNAS_FECHA,
    etapas,
    ultimo_calculo: (cfg[0]?.ultimo_calculo as string | undefined) ?? null,
    resumen: {
      vehiculos_activos: (km[0]?.total as number | undefined) ?? 0,
      con_kilometraje: (km[0]?.con_km as number | undefined) ?? 0,
      por_etapa: etapas.map((e) => ({
        etapa_id: e.id,
        total: cuenta(e.id),
        por_km: cuenta(e.id, "km"),
      })),
      excluidos_por_km: cuenta(null, "excluido_km"),
      excluidos_por_fecha: cuenta(null, "excluido_fecha"),
      aun_no_entran: cuenta(null, "aun_no"),
      sin_datos: cuenta(null, "sin_datos"),
    },
  };
}

export type ResultadoGuardarCiclo = { ok: true; revisados: number; cambiaron: number } | { ok: false; error: string };

/** Guarda la columna de fecha y las etapas, y recalcula a toda la cartera con las reglas nuevas. */
export async function guardarCiclo(sucursalId: string, columna: string, etapas: EtapaEntrada[]): Promise<ResultadoGuardarCiclo> {
  if (!esColumnaFecha(columna)) return { ok: false, error: "La columna de fecha no es válida." };
  const error = validarEtapas(etapas);
  if (error) return { ok: false, error };

  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    await cliente.query(
      `INSERT INTO crm_ciclo_config (sucursal_id, columna_fecha, ultimo_calculo) VALUES ($1, $2, NULL)
       ON CONFLICT (sucursal_id) DO UPDATE SET columna_fecha = EXCLUDED.columna_fecha, actualizado_en = now()`,
      [sucursalId, columna],
    );
    await cliente.query(`DELETE FROM crm_ciclo_etapas WHERE sucursal_id = $1`, [sucursalId]);
    await cliente.query(
      `INSERT INTO crm_ciclo_etapas (sucursal_id, orden, nombre, meses_desde, meses_hasta, km_max)
       SELECT $1, r.orden, r.nombre, r.meses_desde, r.meses_hasta, r.km_max
         FROM jsonb_to_recordset($2::jsonb) AS r(orden int, nombre text, meses_desde int, meses_hasta int, km_max int)`,
      [sucursalId, JSON.stringify(etapas.map((e, i) => ({ ...e, nombre: e.nombre.trim(), orden: i + 1 })))],
    );
    const r = await recalcularEtapas(cliente, sucursalId);
    await cliente.query("COMMIT");
    return { ok: true, ...r };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Qué etapa saldría con una fecha y un kilometraje dados (para probar la configuración sin tocar datos). */
export async function probarEtapa(sucursalId: string, fecha: string | null, km: number | null) {
  const { etapas } = await leerConfig(getPool(), sucursalId);
  const r = calcularEtapaVehiculo({ etapas, fecha, km, hoy: ahoraLocal().fecha });
  const etapa = etapas.find((e) => e.id === r.etapaId) ?? null;
  return { etapa: etapa?.nombre ?? null, motivo: r.motivo };
}
