import { getPool } from "./db.js";
import { emitirBroadcast } from "./realtime.js";
import { ahoraLocal } from "./campanasLogica.js";
import { rellenarTexto } from "./seguimientosLogica.js";
import {
  ESTADOS_CON_REGLA,
  coberturaYaInicio,
  entradaAlEstado,
  validarReglasContrato,
  type ReglaContratoEntrada,
} from "./contratoLogica.js";
import { guardarContrato } from "./crmProceso.js";

/**
 * Pago y cierre automáticos.
 *
 *  - Reglas del contrato: cuando un contrato lleva N horas en un estado, se crea una tarea para el ejecutivo de la oportunidad
 *    (la liga de pago por vencer, reemitir la orden de pago, pedir los datos para facturar…). Nacen apagadas.
 *  - Cobertura automática: cuando termina la garantía original (36 meses desde la factura), los contratos en «Certificado
 *    entregado» pasan solos a «Cobertura iniciada».
 *
 * Nada de esto manda mensajes: solo crea tareas y cambia el estado de un contrato, así que no depende de CRM_ENVIOS.
 */

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export const ETIQUETA_ESTADO: Record<string, string> = {
  cotizado: "Cotizado",
  aceptado: "Aceptado por el cliente",
  orden_pago: "Orden de pago generada",
  pago_confirmado: "Pago confirmado",
  certificado_entregado: "Certificado entregado",
  cobertura_iniciada: "Cobertura iniciada",
};

/** Las tres reglas que se proponen la primera vez (apagadas): la liga de pago de Openpay dura 24 horas. */
const SEMILLAS: ReglaContratoEntrada[] = [
  {
    nombre: "Liga de pago por vencer",
    activa: false,
    estado: "orden_pago",
    espera_horas: 20,
    titulo: "La liga de pago de {cliente} vence en 4 horas",
    descripcion: "La orden de pago que llegó por correo dura 24 horas. Contacta al cliente para que pague antes de que venza.",
    vence_horas: 2,
  },
  {
    nombre: "Reemitir orden de pago",
    activa: false,
    estado: "orden_pago",
    espera_horas: 25,
    titulo: "Reemitir la orden de pago de {cliente}",
    descripcion: "La liga de pago ya venció sin pago. Genera una nueva orden en el portal de emisión y avisa al cliente.",
    vence_horas: 8,
  },
  {
    nombre: "Pedir datos para facturar",
    activa: false,
    estado: "certificado_entregado",
    espera_horas: 24,
    titulo: "Pedir los datos de facturación de {cliente}",
    descripcion: "Solicita la constancia de situación fiscal. Para facturar se necesita también el recibo de pago y la carátula del certificado.",
    vence_horas: 48,
  },
];

const COLUMNAS = `id, orden, nombre, activa, estado, espera_horas, titulo, descripcion, vence_horas`;

export type ReglaContrato = ReglaContratoEntrada & { id: string; orden: number };

const aRegla = (r: any): ReglaContrato => ({
  id: r.id,
  orden: r.orden,
  nombre: r.nombre,
  activa: r.activa,
  estado: r.estado,
  espera_horas: r.espera_horas,
  titulo: r.titulo,
  descripcion: r.descripcion,
  vence_horas: r.vence_horas,
});

async function sembrarSiVacio(sucursalId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM crm_reglas_contrato WHERE sucursal_id = $1`, [sucursalId]);
  if ((rows[0]?.n as number) > 0) return;
  await pool.query(
    `INSERT INTO crm_reglas_contrato (sucursal_id, orden, nombre, activa, estado, espera_horas, titulo, descripcion, vence_horas)
     SELECT $1, r.orden, r.nombre, r.activa, r.estado, r.espera_horas, r.titulo, r.descripcion, r.vence_horas
       FROM jsonb_to_recordset($2::jsonb) AS r(orden int, nombre text, activa boolean, estado text, espera_horas int, titulo text, descripcion text, vence_horas int)
     ON CONFLICT (sucursal_id, orden) DO NOTHING`,
    [sucursalId, JSON.stringify(SEMILLAS.map((s, i) => ({ ...s, orden: i + 1 })))],
  );
}

export async function leerReglasContrato(sucursalId: string) {
  await sembrarSiVacio(sucursalId);
  const pool = getPool();
  const [reglas, resumen, recientes, cfg, enCertificado] = await Promise.all([
    pool.query(`SELECT ${COLUMNAS} FROM crm_reglas_contrato WHERE sucursal_id = $1 ORDER BY orden`, [sucursalId]),
    pool.query(`SELECT regla_id, estado, count(*)::int AS n FROM crm_regla_contrato_ejecuciones WHERE sucursal_id = $1 GROUP BY 1, 2`, [sucursalId]),
    pool.query(
      `SELECT x.id, r.nombre AS regla, x.estado, x.motivo, x.programado_para, x.actualizado_en, c.nombre AS cliente
         FROM crm_regla_contrato_ejecuciones x
         JOIN crm_reglas_contrato r ON r.id = x.regla_id
         JOIN crm_oportunidades o ON o.id = x.oportunidad_id
         JOIN crm_contactos c ON c.id = o.contacto_id
        WHERE x.sucursal_id = $1 ORDER BY x.actualizado_en DESC LIMIT 30`,
      [sucursalId],
    ),
    pool.query(`SELECT cobertura_automatica FROM crm_config WHERE sucursal_id = $1`, [sucursalId]),
    pool.query(
      `SELECT count(*)::int AS total, min(v.fecha_factura)::text AS factura_mas_antigua
         FROM crm_contratos c JOIN crm_oportunidades o ON o.id = c.oportunidad_id JOIN crm_vehiculos v ON v.id = o.vehiculo_id
        WHERE c.sucursal_id = $1 AND c.estado = 'certificado_entregado'`,
      [sucursalId],
    ),
  ]);
  const n = (id: string, estado: string) => (resumen.rows.find((r) => r.regla_id === id && r.estado === estado)?.n as number | undefined) ?? 0;
  return {
    reglas: reglas.rows.map((r) => ({ ...aRegla(r), resumen: { pendientes: n(r.id, "pendiente"), hechos: n(r.id, "hecho"), omitidos: n(r.id, "omitido") } })),
    estados: ESTADOS_CON_REGLA.map((valor) => ({ valor, etiqueta: ETIQUETA_ESTADO[valor] })),
    cobertura_automatica: cfg.rows[0]?.cobertura_automatica !== false,
    contratos_en_certificado: (enCertificado.rows[0]?.total as number | undefined) ?? 0,
    recientes: recientes.rows,
  };
}

export type ResultadoGuardarReglas = { ok: true } | { ok: false; error: string };

/**
 * Guarda las reglas y el interruptor de la cobertura automática. Las reglas que ya existían se actualizan (conservan su historial);
 * lo pendiente de una regla cuyo estado o espera cambió se reprograma. Las que ya no vienen se borran.
 */
export async function guardarReglasContrato(
  sucursalId: string,
  lista: (ReglaContratoEntrada & { id?: string })[],
  coberturaAutomatica: boolean,
): Promise<ResultadoGuardarReglas> {
  const error = validarReglasContrato(lista);
  if (error) return { ok: false, error };

  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows: existentes } = await cliente.query(`SELECT ${COLUMNAS} FROM crm_reglas_contrato WHERE sucursal_id = $1`, [sucursalId]);
    const porId = new Map(existentes.map((r) => [r.id as string, aRegla(r)]));
    const conservadas = new Set<string>();

    // Se libera el orden para no chocar con la unicidad al reordenar.
    await cliente.query(`UPDATE crm_reglas_contrato SET orden = orden + 1000 WHERE sucursal_id = $1`, [sucursalId]);
    for (const [i, r] of lista.entries()) {
      const valores = [i + 1, r.nombre.trim(), r.activa, r.estado, r.espera_horas, r.titulo.trim(), (r.descripcion ?? "").trim() || null, r.vence_horas];
      const previa = r.id ? porId.get(r.id) : undefined;
      if (previa) {
        conservadas.add(previa.id);
        await cliente.query(
          `UPDATE crm_reglas_contrato SET orden = $2, nombre = $3, activa = $4, estado = $5, espera_horas = $6, titulo = $7, descripcion = $8, vence_horas = $9 WHERE id = $1`,
          [previa.id, ...valores],
        );
        if (previa.estado !== r.estado || previa.espera_horas !== r.espera_horas) {
          await cliente.query(`DELETE FROM crm_regla_contrato_ejecuciones WHERE regla_id = $1 AND estado = 'pendiente'`, [previa.id]);
        }
      } else {
        await cliente.query(
          `INSERT INTO crm_reglas_contrato (sucursal_id, orden, nombre, activa, estado, espera_horas, titulo, descripcion, vence_horas) VALUES ($9, $1, $2, $3, $4, $5, $6, $7, $8)`,
          [...valores, sucursalId],
        );
      }
    }
    const aBorrar = existentes.map((r) => r.id as string).filter((id) => !conservadas.has(id));
    if (aBorrar.length > 0) await cliente.query(`DELETE FROM crm_reglas_contrato WHERE id = ANY($1::uuid[])`, [aBorrar]);

    await cliente.query(
      `INSERT INTO crm_config (sucursal_id, cobertura_automatica) VALUES ($1, $2)
       ON CONFLICT (sucursal_id) DO UPDATE SET cobertura_automatica = EXCLUDED.cobertura_automatica, actualizado_en = now()`,
      [sucursalId, coberturaAutomatica],
    );
    await cliente.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/* ============================================================
   Planificador
   ============================================================ */

/** Programa la tarea de cada contrato que está en el estado de una regla activa. */
export async function planificarReglasContrato(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.sucursal_id, c.oportunidad_id, c.estado, c.eventos, c.actualizado_en::text AS actualizado_en, r.id AS regla_id, r.espera_horas
       FROM crm_reglas_contrato r
       JOIN crm_contratos c ON c.sucursal_id = r.sucursal_id AND c.estado = r.estado
       JOIN crm_oportunidades o ON o.id = c.oportunidad_id AND o.estado <> 'perdida'
      WHERE r.activa
      LIMIT 5000`,
  );
  const lote: { sucursal_id: string; regla_id: string; oportunidad_id: string; estado_desde: string; programado_para: string }[] = [];
  for (const r of rows) {
    const desde = entradaAlEstado(r.eventos, r.estado as string, r.actualizado_en as string);
    if (!desde) continue;
    lote.push({
      sucursal_id: r.sucursal_id,
      regla_id: r.regla_id,
      oportunidad_id: r.oportunidad_id,
      estado_desde: desde,
      programado_para: new Date(new Date(desde).getTime() + (r.espera_horas as number) * 3_600_000).toISOString(),
    });
  }
  let nuevas = 0;
  for (let i = 0; i < lote.length; i += 1000) {
    const { rowCount } = await pool.query(
      `INSERT INTO crm_regla_contrato_ejecuciones (sucursal_id, regla_id, oportunidad_id, estado_desde, programado_para)
       SELECT r.sucursal_id, r.regla_id, r.oportunidad_id, r.estado_desde, r.programado_para
         FROM jsonb_to_recordset($1::jsonb) AS r(sucursal_id uuid, regla_id uuid, oportunidad_id uuid, estado_desde timestamptz, programado_para timestamptz)
       ON CONFLICT (regla_id, oportunidad_id, estado_desde) DO NOTHING`,
      [JSON.stringify(lote.slice(i, i + 1000))],
    );
    nuevas += rowCount ?? 0;
  }
  return nuevas;
}

/* ============================================================
   Ejecutor
   ============================================================ */

const cerrar = (cl: Consulta, id: string, estado: "hecho" | "omitido", motivo: string | null, tareaId: string | null = null) =>
  cl.query(`UPDATE crm_regla_contrato_ejecuciones SET estado = $2, motivo = $3, tarea_id = $4 WHERE id = $1`, [id, estado, motivo, tareaId]);

/** Resuelve la ejecución más antigua que ya le toca. Devuelve false si no hay nada. */
async function ejecutarUna(): Promise<{ hubo: boolean; sucursal: string | null }> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `SELECT x.id, x.sucursal_id, x.oportunidad_id, x.estado_desde, r.nombre, r.estado AS estado_regla, r.titulo, r.descripcion, r.vence_horas
         FROM crm_regla_contrato_ejecuciones x JOIN crm_reglas_contrato r ON r.id = x.regla_id
        WHERE x.estado = 'pendiente' AND x.programado_para <= now() AND r.activa
        ORDER BY x.programado_para LIMIT 1 FOR UPDATE OF x SKIP LOCKED`,
    );
    const x = rows[0];
    if (!x) {
      await cliente.query("ROLLBACK");
      return { hubo: false, sucursal: null };
    }

    // El contrato debe seguir en el mismo estado y desde el mismo momento: si avanzó (o se reinició), la tarea ya no tiene sentido.
    const { rows: c } = await cliente.query(`SELECT estado, eventos, actualizado_en::text AS actualizado_en FROM crm_contratos WHERE oportunidad_id = $1`, [x.oportunidad_id]);
    const desde = c[0] ? entradaAlEstado(c[0].eventos, c[0].estado as string, c[0].actualizado_en as string) : null;
    if (!c[0] || c[0].estado !== x.estado_regla || !desde || new Date(desde).getTime() !== new Date(x.estado_desde).getTime()) {
      await cerrar(cliente, x.id, "omitido", "cambio_de_estado");
      await cliente.query("COMMIT");
      return { hubo: true, sucursal: null };
    }

    const { rows: f } = await cliente.query(`SELECT to_jsonb(v) AS f FROM crm_v_oportunidades v WHERE v.id = $1 AND v.sucursal_id = $2`, [x.oportunidad_id, x.sucursal_id]);
    const fila = (f[0]?.f ?? null) as Record<string, unknown> | null;
    if (!fila || fila.estado_oportunidad === "perdida") {
      await cerrar(cliente, x.id, "omitido", "ya_no_aplica");
      await cliente.query("COMMIT");
      return { hubo: true, sucursal: null };
    }

    const { rows: tarea } = await cliente.query(
      `INSERT INTO crm_tareas (sucursal_id, oportunidad_id, regla_contrato_id, tipo, titulo, descripcion, config, asignado_a, vence_en)
       VALUES ($1, $2, (SELECT regla_id FROM crm_regla_contrato_ejecuciones WHERE id = $3), 'tarea', $4, $5, $6::jsonb, $7,
               CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(hours => $8::int) END)
       RETURNING id`,
      [
        x.sucursal_id,
        x.oportunidad_id,
        x.id,
        rellenarTexto(String(x.titulo), fila),
        x.descripcion ? rellenarTexto(String(x.descripcion), fila) : null,
        JSON.stringify({ contrato: true, regla: x.nombre, estado: x.estado_regla }),
        (fila.ejecutivo as string | null) ?? null,
        x.vence_horas as number | null,
      ],
    );
    await cliente.query(`INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle) VALUES ($1, $2, 'regla_contrato', $3, $4)`, [
      x.sucursal_id,
      x.oportunidad_id,
      `Contrato: tarea «${x.nombre}» creada`,
      { regla: x.nombre, estado: x.estado_regla },
    ]);
    await cerrar(cliente, x.id, "hecho", null, tarea[0].id as string);
    await cliente.query("COMMIT");
    return { hubo: true, sucursal: x.sucursal_id as string };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Ejecuta lo que ya toca, con un presupuesto de tiempo. Devuelve cuántas resolvió. */
export async function ejecutarReglasContrato(presupuestoMs = 15_000, maximo = 200): Promise<number> {
  const inicio = Date.now();
  const conTareas = new Set<string>();
  let hechas = 0;
  while (hechas < maximo && Date.now() - inicio < presupuestoMs) {
    let r: { hubo: boolean; sucursal: string | null };
    try {
      r = await ejecutarUna();
    } catch (err) {
      console.error("[reglas-contrato] error ejecutando una regla", err instanceof Error ? err.message : err);
      break;
    }
    if (!r.hubo) break;
    if (r.sucursal) conTareas.add(r.sucursal);
    hechas++;
  }
  for (const s of conTareas) emitirBroadcast(`datos:${s}`, "tareas", {});
  return hechas;
}

/* ============================================================
   Cobertura automática
   ============================================================ */

/** Pasa a «Cobertura iniciada» los contratos con certificado entregado cuya garantía original ya terminó. */
export async function iniciarCoberturasVencidas(maximo = 200): Promise<number> {
  const hoy = ahoraLocal().fecha;
  const { rows } = await getPool().query(
    `SELECT c.sucursal_id, c.oportunidad_id, v.fecha_factura::text AS fecha_factura, pg.meses_garantia_original
       FROM crm_contratos c
       JOIN crm_oportunidades o ON o.id = c.oportunidad_id
       JOIN crm_vehiculos v ON v.id = o.vehiculo_id
       LEFT JOIN crm_config cc ON cc.sucursal_id = c.sucursal_id
       LEFT JOIN crm_programa_ge pg ON pg.sucursal_id = c.sucursal_id
      WHERE c.estado = 'certificado_entregado' AND coalesce(cc.cobertura_automatica, true) AND v.fecha_factura IS NOT NULL`,
  );
  let cambios = 0;
  for (const r of rows) {
    if (cambios >= maximo) break;
    // Los meses de la garantía original son del programa de la sucursal (36 si nunca se configuró).
    if (!coberturaYaInicio(r.fecha_factura as string, hoy, (r.meses_garantia_original as number | null) ?? undefined)) continue;
    try {
      const res = await guardarContrato({ sucursalId: r.sucursal_id, oportunidadId: r.oportunidad_id, estado: "cobertura_iniciada", origen: "sistema" });
      if (res.ok) cambios++;
    } catch (err) {
      console.error("[reglas-contrato] no se pudo iniciar una cobertura", err instanceof Error ? err.message : err);
    }
  }
  return cambios;
}
