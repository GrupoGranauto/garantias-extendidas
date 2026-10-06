import { getPool } from "./db.js";
import { PROGRAMA_POR_OMISION, type ProgramaGe } from "./programaGeLogica.js";

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const COLUMNAS = `nombre, area_venta, meses_garantia_original, bandas_km, plazos_meses, msi_meses, liga_pago_horas, estados_circulacion, vendedores`;

/**
 * Reglas del programa de garantía extendida (plazos, MSI, km máximo, lista de estados...). No se configuran desde la app:
 * se usan los valores del material GEXT de Nissan / Assurant. Si alguna sucursal necesitara otros, se ponen en
 * crm_programa_ge directamente en la base.
 */
export async function leerPrograma(sucursalId: string, cl: Consulta = getPool()): Promise<ProgramaGe> {
  const { rows } = await cl.query(`SELECT ${COLUMNAS} FROM crm_programa_ge WHERE sucursal_id = $1`, [sucursalId]);
  return (rows[0] as ProgramaGe | undefined) ?? PROGRAMA_POR_OMISION;
}
