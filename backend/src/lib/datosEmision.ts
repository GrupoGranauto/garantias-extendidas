import { getPool } from "./db.js";
import { autorValido } from "./crm.js";
import {
  ETIQUETA_EMISION,
  evaluarCompletitud,
  normalizarDatosEmision,
  type BaseEmision,
  type Completitud,
  type DatosEmisionEntrada,
} from "./datosEmisionLogica.js";

/** Datos para emitir la garantía extendida: viven en el vehículo (factura, motor, circulación) y en el contacto (dirección). */

const ZONA = "America/Hermosillo";

export type FichaEmision = { datos: BaseEmision; completitud: Completitud };

const SQL_BASE = `
  SELECT v.vin, v.modelo, v.version, v.ano_modelo, to_char(v.fecha_factura, 'YYYY-MM-DD') AS fecha_factura, v.kilometraje,
         v.numero_factura, v.valor_factura::float8 AS valor_factura, v.numero_motor, v.estado_circulacion,
         c.direccion, c.correo,
         to_char((now() AT TIME ZONE '${ZONA}')::date, 'YYYY-MM-DD') AS hoy
    FROM crm_oportunidades o
    JOIN crm_vehiculos v ON v.id = o.vehiculo_id
    JOIN crm_contactos c ON c.id = o.contacto_id
   WHERE o.id = $1 AND o.sucursal_id = $2`;

function armar(fila: Record<string, unknown>): FichaEmision {
  const { hoy, ...datos } = fila as Record<string, unknown> & { hoy: string };
  const base = datos as unknown as BaseEmision;
  return { datos: base, completitud: evaluarCompletitud(base, hoy) };
}

export async function leerDatosEmision(sucursalId: string, oportunidadId: string): Promise<FichaEmision | null> {
  const { rows } = await getPool().query(SQL_BASE, [oportunidadId, sucursalId]);
  return rows[0] ? armar(rows[0]) : null;
}

export type ResultadoEmision = { ok: true; emision: FichaEmision; cambiados: string[] } | { ok: false; estado: 400 | 404; error: string };

/**
 * Guarda los datos que capturó el ejecutivo. Solo cambia los campos que vienen; deja en la línea de tiempo QUÉ campos
 * cambió (no sus valores: la dirección es un dato personal).
 */
export async function guardarDatosEmision(p: {
  sucursalId: string;
  oportunidadId: string;
  entrada: DatosEmisionEntrada;
  usuarioId?: string;
}): Promise<ResultadoEmision> {
  const limpio = normalizarDatosEmision(p.entrada);
  if ("error" in limpio) return { ok: false, estado: 400, error: limpio.error };
  const datos = limpio.datos;

  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(`${SQL_BASE} FOR UPDATE OF v, c`, [p.oportunidadId, p.sucursalId]);
    const actual = rows[0] as Record<string, unknown> | undefined;
    if (!actual) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }

    const cambiados = (Object.keys(datos) as (keyof typeof datos)[]).filter((k) => (datos[k] ?? null) !== (actual[k] ?? null));
    if (cambiados.length > 0) {
      const delVehiculo = cambiados.filter((k) => k !== "direccion");
      if (delVehiculo.length > 0) {
        const sets = delVehiculo.map((k, i) => `${k} = $${i + 3}`).join(", ");
        await cliente.query(
          `UPDATE crm_vehiculos SET ${sets}, emision_actualizada_en = now()
            WHERE id = (SELECT vehiculo_id FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2) AND sucursal_id = $2`,
          [p.oportunidadId, p.sucursalId, ...delVehiculo.map((k) => datos[k])],
        );
      }
      if (cambiados.includes("direccion")) {
        await cliente.query(
          `UPDATE crm_contactos SET direccion = $3
            WHERE id = (SELECT contacto_id FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2) AND sucursal_id = $2`,
          [p.oportunidadId, p.sucursalId, datos.direccion ?? null],
        );
      }
      await cliente.query(
        `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id) VALUES ($1, $2, 'emision', 'Datos para emitir actualizados', $3, $4)`,
        [p.sucursalId, p.oportunidadId, { campos: cambiados.map((k) => ETIQUETA_EMISION[k] ?? k) }, await autorValido(cliente, p.usuarioId)],
      );
    }
    const { rows: nuevas } = await cliente.query(SQL_BASE, [p.oportunidadId, p.sucursalId]);
    await cliente.query("COMMIT");
    return { ok: true, emision: armar(nuevas[0]), cambiados };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}
