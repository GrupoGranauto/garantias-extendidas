import { getPool } from "./db.js";
import { PROGRAMA_POR_OMISION, validarPrograma, type ProgramaGe } from "./programaGeLogica.js";

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const COLUMNAS = `nombre, area_venta, meses_garantia_original, bandas_km, plazos_meses, msi_meses, liga_pago_horas, estados_circulacion, vendedores`;

/** El programa de la sucursal; si nunca se guardó, el de omisión (GEXT de GranAuto). No escribe nada. */
export async function leerPrograma(sucursalId: string, cl: Consulta = getPool()): Promise<ProgramaGe> {
  const { rows } = await cl.query(`SELECT ${COLUMNAS} FROM crm_programa_ge WHERE sucursal_id = $1`, [sucursalId]);
  return (rows[0] as ProgramaGe | undefined) ?? PROGRAMA_POR_OMISION;
}

export type ResultadoPrograma = { ok: true; programa: ProgramaGe } | { ok: false; error: string };

export async function guardarPrograma(sucursalId: string, entrada: ProgramaGe): Promise<ResultadoPrograma> {
  const p: ProgramaGe = {
    ...entrada,
    nombre: entrada.nombre.trim(),
    area_venta: entrada.area_venta.trim(),
    estados_circulacion: entrada.estados_circulacion.map((e) => e.trim()).filter(Boolean),
    vendedores: entrada.vendedores.map((v) => v.trim()).filter(Boolean),
  };
  const error = validarPrograma(p);
  if (error) return { ok: false, error };
  await getPool().query(
    `INSERT INTO crm_programa_ge (sucursal_id, ${COLUMNAS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (sucursal_id) DO UPDATE SET nombre = EXCLUDED.nombre, area_venta = EXCLUDED.area_venta,
            meses_garantia_original = EXCLUDED.meses_garantia_original, bandas_km = EXCLUDED.bandas_km, plazos_meses = EXCLUDED.plazos_meses,
            msi_meses = EXCLUDED.msi_meses, liga_pago_horas = EXCLUDED.liga_pago_horas, estados_circulacion = EXCLUDED.estados_circulacion,
            vendedores = EXCLUDED.vendedores`,
    [sucursalId, p.nombre, p.area_venta, p.meses_garantia_original, p.bandas_km, p.plazos_meses, p.msi_meses, p.liga_pago_horas, p.estados_circulacion, p.vendedores],
  );
  return { ok: true, programa: p };
}
