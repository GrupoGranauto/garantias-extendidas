import { getPool } from "./db.js";
import { autorValido } from "./crm.js";
import { leerPrograma } from "./programaGe.js";
import type { ProgramaGe } from "./programaGeLogica.js";
import {
  CAMPOS_DIRECCION,
  CAMPOS_PRODUCTO,
  CAMPOS_VEHICULO,
  ETIQUETA_EMISION,
  evaluarCompletitud,
  normalizarDatosEmision,
  type BaseEmision,
  type Completitud,
  type DatosEmisionEntrada,
} from "./datosEmisionLogica.js";

/**
 * Datos para emitir la garantía extendida: viven en el vehículo (factura, motor, circulación), en el contacto (dirección
 * por partes) y en el contrato (plazo, forma de pago y MSI). El vendedor es el ejecutivo asignado al lead. Las listas y reglas vienen del programa de la sucursal.
 */

const ZONA = "America/Hermosillo";

/** Lo que la ficha necesita del programa para armar las listas. */
export type OpcionesEmision = Pick<ProgramaGe, "nombre" | "plazos_meses" | "msi_meses" | "estados_circulacion" | "vendedores" | "liga_pago_horas">;
export type FichaEmision = { datos: BaseEmision; completitud: Completitud; opciones: OpcionesEmision };

const SQL_BASE = `
  SELECT v.vin, v.modelo, v.version, v.ano_modelo, to_char(v.fecha_factura, 'YYYY-MM-DD') AS fecha_factura, v.kilometraje,
         v.numero_factura, v.valor_factura::float8 AS valor_factura, v.numero_motor, v.estado_circulacion,
         c.direccion, c.correo, c.dir_cp, c.dir_estado, c.dir_municipio, c.dir_colonia, c.dir_calle, c.dir_num_ext, c.dir_num_int,
         ct.plazo_meses, ct.metodo_pago, ct.msi_meses, o.ejecutivo AS vendedor,
         to_char((now() AT TIME ZONE '${ZONA}')::date, 'YYYY-MM-DD') AS hoy
    FROM crm_oportunidades o
    JOIN crm_vehiculos v ON v.id = o.vehiculo_id
    JOIN crm_contactos c ON c.id = o.contacto_id
    LEFT JOIN crm_contratos ct ON ct.oportunidad_id = o.id
   WHERE o.id = $1 AND o.sucursal_id = $2`;

function armar(fila: Record<string, unknown>, programa: ProgramaGe): FichaEmision {
  const { hoy, ...datos } = fila as Record<string, unknown> & { hoy: string };
  const base = datos as unknown as BaseEmision;
  const { nombre, plazos_meses, msi_meses, estados_circulacion, vendedores, liga_pago_horas } = programa;
  return {
    datos: base,
    completitud: evaluarCompletitud(base, hoy, programa),
    opciones: { nombre, plazos_meses, msi_meses, estados_circulacion, vendedores, liga_pago_horas },
  };
}

export async function leerDatosEmision(sucursalId: string, oportunidadId: string): Promise<FichaEmision | null> {
  const { rows } = await getPool().query(SQL_BASE, [oportunidadId, sucursalId]);
  return rows[0] ? armar(rows[0], await leerPrograma(sucursalId)) : null;
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
  const programa = await leerPrograma(p.sucursalId);
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(`${SQL_BASE} FOR UPDATE OF v, c`, [p.oportunidadId, p.sucursalId]);
    const actual = rows[0] as Record<string, unknown> | undefined;
    if (!actual) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }
    const limpio = normalizarDatosEmision(p.entrada, programa, { metodo_pago: (actual.metodo_pago as "contado" | "financiado" | null) ?? null });
    if ("error" in limpio) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 400, error: limpio.error };
    }
    const datos = limpio.datos as Record<string, unknown>;

    const cambiados = Object.keys(datos).filter((k) => (datos[k] ?? null) !== (actual[k] ?? null));
    const de = (grupo: readonly string[]) => cambiados.filter((k) => grupo.includes(k));
    // Los nombres de columna salen de listas fijas (CAMPOS_*), nunca de la entrada.
    const sets = (campos: string[], desde: number) => campos.map((k, i) => `${k} = $${i + desde}`).join(", ");

    const delVehiculo = de(CAMPOS_VEHICULO);
    if (delVehiculo.length > 0) {
      await cliente.query(
        `UPDATE crm_vehiculos SET ${sets(delVehiculo, 3)}, emision_actualizada_en = now()
          WHERE id = (SELECT vehiculo_id FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2) AND sucursal_id = $2`,
        [p.oportunidadId, p.sucursalId, ...delVehiculo.map((k) => datos[k])],
      );
    }
    const delContacto = de(CAMPOS_DIRECCION);
    if (delContacto.length > 0) {
      await cliente.query(
        `UPDATE crm_contactos SET ${sets(delContacto, 3)}
          WHERE id = (SELECT contacto_id FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2) AND sucursal_id = $2`,
        [p.oportunidadId, p.sucursalId, ...delContacto.map((k) => datos[k])],
      );
    }
    const delContrato = de(CAMPOS_PRODUCTO);
    if (delContrato.length > 0) {
      // Si todavía no hay contrato, se crea «Sin contrato»: el estado lo sigue llevando el ejecutivo en la sección Contrato.
      await cliente.query(
        `INSERT INTO crm_contratos (sucursal_id, oportunidad_id, ${delContrato.join(", ")})
         VALUES ($1, $2, ${delContrato.map((_, i) => `$${i + 3}`).join(", ")})
         ON CONFLICT (oportunidad_id) DO UPDATE SET ${delContrato.map((k) => `${k} = EXCLUDED.${k}`).join(", ")}`,
        [p.sucursalId, p.oportunidadId, ...delContrato.map((k) => datos[k])],
      );
    }
    if (cambiados.length > 0) {
      await cliente.query(
        `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id) VALUES ($1, $2, 'emision', 'Datos para emitir actualizados', $3, $4)`,
        [p.sucursalId, p.oportunidadId, { campos: cambiados.map((k) => ETIQUETA_EMISION[k] ?? k) }, await autorValido(cliente, p.usuarioId)],
      );
    }
    const { rows: nuevas } = await cliente.query(SQL_BASE, [p.oportunidadId, p.sucursalId]);
    await cliente.query("COMMIT");
    return { ok: true, emision: armar(nuevas[0], programa), cambiados };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}
