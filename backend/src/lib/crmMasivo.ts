import { getPool } from "./db.js";
import { ajustarResultados, autorValido, CONTRATO_CON_EVIDENCIA } from "./crm.js";

/**
 * Acciones sobre varias oportunidades a la vez (selección en la tabla). Todo ocurre en una sola
 * transacción: o se aplica a todas las elegibles, o a ninguna. Un asesor restringido a su ejecutivo
 * solo puede tocar las suyas; las demás se cuentan como omitidas, no como error.
 */

export const MAX_MASIVO = 200;
const SEPARACION = 1024;

export type AccionMasiva =
  | { accion: "etapa"; etapa: string; motivo?: string | null }
  | { accion: "ejecutivo"; ejecutivo: string }
  | { accion: "tarea"; titulo: string; descripcion?: string | null; vence_horas?: number | null };

export type ResultadoMasivo = { afectadas: number; omitidas: number } | { error: string };

export async function ejecutarAccionMasiva(p: {
  sucursalId: string;
  ids: string[];
  restringidoA: string | null;
  usuarioId?: string;
  accion: AccionMasiva;
}): Promise<ResultadoMasivo> {
  const { sucursalId, restringidoA, accion } = p;
  const ids = [...new Set(p.ids)];
  if (ids.length === 0) return { error: "No hay oportunidades seleccionadas." };
  if (ids.length > MAX_MASIVO) return { error: `Se pueden tocar hasta ${MAX_MASIVO} oportunidades a la vez.` };

  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");

    const { rows: filas } = await cliente.query(
      `SELECT id, etapa_id, ejecutivo FROM crm_oportunidades
        WHERE sucursal_id = $1 AND id = ANY($2::uuid[])${restringidoA ? " AND ejecutivo = $3" : ""}
        ORDER BY id FOR UPDATE`,
      restringidoA ? [sucursalId, ids, restringidoA] : [sucursalId, ids],
    );
    const omitidasPorPermiso = ids.length - filas.length;
    const autor = await autorValido(cliente, p.usuarioId);

    if (filas.length === 0) {
      await cliente.query("ROLLBACK");
      return { afectadas: 0, omitidas: omitidasPorPermiso };
    }

    /* ---------- Cambiar de etapa ---------- */
    if (accion.accion === "etapa") {
      const { rows: etapas } = await cliente.query(
        `SELECT id, tipo FROM crm_etapas WHERE sucursal_id = $1 AND nombre = $2 AND activa`,
        [sucursalId, accion.etapa],
      );
      if (!etapas[0]) {
        await cliente.query("ROLLBACK");
        return { error: "Ese estado del lead no existe." };
      }
      const destino = etapas[0].id as string;
      const tipo = etapas[0].tipo as string;
      const aMover = filas.filter((f) => f.etapa_id !== destino);

      let motivoId: string | null = null;
      if (tipo === "perdida" && accion.motivo) {
        const { rows } = await cliente.query(
          `SELECT id, clave FROM crm_motivos_perdida WHERE sucursal_id = $1 AND nombre = $2 AND activo`,
          [sucursalId, accion.motivo],
        );
        if (!rows[0] || rows[0].clave === "pidio_baja") {
          await cliente.query("ROLLBACK");
          return { error: rows[0] ? "«Pidió baja» se registra con «Pidió no ser contactado» en la ficha." : "El motivo de pérdida no existe." };
        }
        motivoId = rows[0].id as string;
      }

      // Una venta exige evidencia si la sucursal así lo configuró: todas o ninguna.
      if (tipo === "ganada" && aMover.length > 0) {
        const { rows: cfg } = await cliente.query(`SELECT exigir_evidencia_venta FROM crm_config WHERE sucursal_id = $1`, [sucursalId]);
        if (cfg[0]?.exigir_evidencia_venta) {
          const { rows: con } = await cliente.query(
            `SELECT oportunidad_id FROM crm_contratos WHERE oportunidad_id = ANY($1::uuid[]) AND estado = ANY($2::text[])`,
            [aMover.map((f) => f.id), CONTRATO_CON_EVIDENCIA],
          );
          const faltan = aMover.length - con.length;
          if (faltan > 0) {
            await cliente.query("ROLLBACK");
            return {
              error: `${faltan} de las oportunidades elegidas no tienen el certificado entregado; una venta necesita ese contrato. No se movió ninguna.`,
            };
          }
        }
      }

      if (aMover.length > 0) {
        const { rows: pos } = await cliente.query(`SELECT coalesce(max(posicion), 0) AS p FROM crm_oportunidades WHERE etapa_id = $1`, [destino]);
        const lote = JSON.stringify(aMover.map((f, i) => ({ id: f.id, n: i + 1 })));
        await cliente.query(
          `UPDATE crm_oportunidades o
              SET etapa_id = $3, posicion = $4::float8 + r.n * ${SEPARACION}, estado = $5,
                  motivo_perdida_id = CASE WHEN $5 = 'perdida' THEN $6::uuid ELSE NULL END,
                  entro_a_etapa_en = now(), cerrada_en = CASE WHEN $5 = 'abierta' THEN NULL ELSE now() END
             FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, n int)
            WHERE o.id = r.id AND o.sucursal_id = $1`,
          [sucursalId, lote, destino, pos[0].p, tipo, motivoId],
        );
        await cliente.query(
          `INSERT INTO crm_historial_etapas (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, motivo_perdida_id, usuario_id, origen)
           SELECT $1, r.id, r.origen, $3, $4, $5, 'manual'
             FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, origen uuid)`,
          [sucursalId, JSON.stringify(aMover.map((f) => ({ id: f.id, origen: f.etapa_id }))), destino, tipo === "perdida" ? motivoId : null, autor],
        );
        // Cada lead toma el resultado BDC que corresponde a su nuevo estado.
        await ajustarResultados(cliente, sucursalId, aMover.map((f) => f.id as string));
      }
      await cliente.query("COMMIT");
      return { afectadas: aMover.length, omitidas: omitidasPorPermiso + (filas.length - aMover.length) };
    }

    /* ---------- Reasignar ejecutivo ---------- */
    if (accion.accion === "ejecutivo") {
      const aCambiar = filas.filter((f) => f.ejecutivo !== accion.ejecutivo);
      if (aCambiar.length > 0) {
        const lote = JSON.stringify(aCambiar.map((f) => ({ id: f.id, de: f.ejecutivo })));
        await cliente.query(
          `UPDATE crm_oportunidades o SET ejecutivo = $3 FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, de text)
            WHERE o.id = r.id AND o.sucursal_id = $1`,
          [sucursalId, lote, accion.ejecutivo],
        );
        await cliente.query(
          `UPDATE crm_tareas SET asignado_a = $3 WHERE sucursal_id = $1 AND estado = 'pendiente' AND oportunidad_id = ANY($2::uuid[])`,
          [sucursalId, aCambiar.map((f) => f.id), accion.ejecutivo],
        );
        await cliente.query(
          `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id)
           SELECT $1, r.id, 'reasignacion', 'Ejecutivo', jsonb_build_object('campo', 'ejecutivo', 'anterior', r.de, 'nuevo', $3::text, 'motivo', 'acción masiva'), $4
             FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, de text)`,
          [sucursalId, lote, accion.ejecutivo, autor],
        );
      }
      await cliente.query("COMMIT");
      return { afectadas: aCambiar.length, omitidas: omitidasPorPermiso + (filas.length - aCambiar.length) };
    }

    /* ---------- Crear una tarea para cada una ---------- */
    const titulo = accion.titulo.trim();
    if (!titulo) {
      await cliente.query("ROLLBACK");
      return { error: "La tarea necesita un título." };
    }
    await cliente.query(
      `INSERT INTO crm_tareas (sucursal_id, oportunidad_id, tipo, titulo, descripcion, config, asignado_a, vence_en)
       SELECT $1, o.id, 'tarea', $3, $4, '{}'::jsonb, o.ejecutivo,
              CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(hours => $5::int) END
         FROM crm_oportunidades o WHERE o.sucursal_id = $1 AND o.id = ANY($2::uuid[])`,
      [sucursalId, filas.map((f) => f.id), titulo, accion.descripcion?.trim() || null, accion.vence_horas ?? null],
    );
    await cliente.query("COMMIT");
    return { afectadas: filas.length, omitidas: omitidasPorPermiso };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/* ============================================================
   Resumen de Inicio
   ============================================================ */

const ZONA = "America/Hermosillo";

/** Números del día para la pantalla de Inicio. Con `ejecutivo`, solo lo de ese ejecutivo. */
export async function resumenInicio(sucursalId: string, ejecutivo: string | null) {
  const pool = getPool();
  const filtro = ejecutivo ? " AND o.ejecutivo = $2" : "";
  const args = ejecutivo ? [sucursalId, ejecutivo] : [sucursalId];

  const fueraSla = `e.tiempo_max_horas IS NOT NULL AND o.entro_a_etapa_en < now() - make_interval(hours => e.tiempo_max_horas)`;
  const [cartera, tareas, contactos, ventas, atender, embudo, campanas, actividad] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta')::int AS cartera_abierta,
              count(*) FILTER (WHERE o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta' AND o.estado_contacto = 'sin_intentar')::int AS sin_intentar,
              count(*) FILTER (WHERE o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta' AND e.tiempo_max_horas IS NOT NULL
                               AND o.entro_a_etapa_en < now() - make_interval(hours => e.tiempo_max_horas))::int AS fuera_sla
         FROM crm_oportunidades o LEFT JOIN crm_etapas e ON e.id = o.etapa_id
        WHERE o.sucursal_id = $1${filtro}`,
      args,
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE t.estado = 'pendiente')::int AS pendientes,
              count(*) FILTER (WHERE t.estado = 'pendiente' AND t.vence_en < now())::int AS vencidas,
              count(*) FILTER (WHERE t.estado = 'pendiente' AND t.vence_en >= now() AND t.vence_en < now() + interval '24 hours')::int AS vencen_hoy
         FROM crm_tareas t WHERE t.sucursal_id = $1${ejecutivo ? " AND t.asignado_a = $2" : ""}`,
      args,
    ),
    pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE a.detalle->>'resultado' = 'contesto')::int AS efectivos
         FROM crm_actividades a JOIN crm_oportunidades o ON o.id = a.oportunidad_id
        WHERE a.sucursal_id = $1 AND a.tipo IN ('llamada', 'whatsapp') AND coalesce(a.detalle->>'origen', '') <> 'migracion'
          AND (a.creado_en AT TIME ZONE '${ZONA}')::date = (now() AT TIME ZONE '${ZONA}')::date${filtro}`,
      args,
    ),
    pool.query(
      `SELECT count(*)::int AS total
         FROM crm_historial_etapas h JOIN crm_etapas e ON e.id = h.etapa_destino_id AND e.tipo = 'ganada'
         JOIN crm_oportunidades o ON o.id = h.oportunidad_id
        WHERE h.sucursal_id = $1 AND h.origen IN ('manual', 'automatizacion')
          AND (h.creado_en AT TIME ZONE '${ZONA}') >= date_trunc('month', now() AT TIME ZONE '${ZONA}')${filtro}`,
      args,
    ),
    // A quién atender ahora: primero lo que ya pasó su tiempo máximo, luego lo que nunca se ha intentado, por la ventana
    // de campaña que cierra antes (48 horas va primero) y por antigüedad en el estado.
    pool.query(
      `SELECT o.id, c.nombre AS cliente, o.campana, e.nombre AS estado, e.color, o.ejecutivo, o.entro_a_etapa_en,
              (${fueraSla}) AS fuera_sla, count(*) OVER ()::int AS total
         FROM crm_oportunidades o
         JOIN crm_etapas e ON e.id = o.etapa_id
         LEFT JOIN crm_contactos c ON c.id = o.contacto_id
        WHERE o.sucursal_id = $1 AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta'
          AND o.estado_contacto NOT IN ('baja', 'no_contactable') AND NOT coalesce(c.whatsapp_baja, false)
          AND (o.estado_contacto = 'sin_intentar' OR (${fueraSla}))${filtro}
        ORDER BY (${fueraSla}) DESC, o.fecha_fin_campana NULLS LAST, o.entro_a_etapa_en
        LIMIT 8`,
      args,
    ),
    pool.query(
      `SELECT e.nombre, e.color, count(o.id)::int AS total
         FROM crm_etapas e
         LEFT JOIN crm_oportunidades o ON o.etapa_id = e.id AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta'${filtro}
        WHERE e.sucursal_id = $1 AND e.activa AND e.tipo = 'abierta'
        GROUP BY e.id ORDER BY e.orden`,
      args,
    ),
    pool.query(
      `SELECT o.campana, count(*)::int AS total
         FROM crm_oportunidades o
         LEFT JOIN crm_campanas_def d ON d.sucursal_id = o.sucursal_id AND d.nombre = o.campana
        WHERE o.sucursal_id = $1 AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta' AND o.campana IS NOT NULL${filtro}
        GROUP BY o.campana ORDER BY min(d.orden) NULLS LAST, o.campana`,
      args,
    ),
    // Lo último que pasó en la cartera activa (7 días): contactos, notas, contrato y cambios de estado. Las ediciones
    // de campos no cuentan: son ruido para el día a día.
    pool.query(
      `SELECT * FROM (
         SELECT a.tipo, a.titulo, a.creado_en, a.oportunidad_id, c.nombre AS cliente, u.nombre AS autor
           FROM crm_actividades a
           JOIN crm_oportunidades o ON o.id = a.oportunidad_id
           LEFT JOIN crm_contactos c ON c.id = o.contacto_id
           LEFT JOIN usuarios u ON u.id = a.usuario_id
          WHERE a.sucursal_id = $1 AND a.tipo <> 'edicion' AND o.estado_cartera = 'ACTIVA'
            AND a.creado_en > now() - interval '7 days'${filtro}
         UNION ALL
         SELECT 'estado', 'Pasó a ' || ed.nombre || CASE WHEN h.origen = 'automatizacion' THEN ' (automático)' ELSE '' END,
                h.creado_en, h.oportunidad_id, c.nombre, u.nombre
           FROM crm_historial_etapas h
           JOIN crm_etapas ed ON ed.id = h.etapa_destino_id
           JOIN crm_oportunidades o ON o.id = h.oportunidad_id
           LEFT JOIN crm_contactos c ON c.id = o.contacto_id
           LEFT JOIN usuarios u ON u.id = h.usuario_id
          WHERE h.sucursal_id = $1 AND h.origen IN ('manual', 'automatizacion') AND o.estado_cartera = 'ACTIVA'
            AND h.creado_en > now() - interval '7 days'${filtro}
       ) x ORDER BY creado_en DESC LIMIT 8`,
      args,
    ),
  ]);

  return {
    ...cartera.rows[0],
    tareas_pendientes: tareas.rows[0].pendientes,
    tareas_vencidas: tareas.rows[0].vencidas,
    tareas_vencen_hoy: tareas.rows[0].vencen_hoy,
    contactos_hoy: contactos.rows[0].total,
    contactos_efectivos_hoy: contactos.rows[0].efectivos,
    ventas_mes: ventas.rows[0].total,
    atender: atender.rows.map(({ total: _total, ...fila }) => fila),
    atender_total: (atender.rows[0]?.total as number | undefined) ?? 0,
    embudo: embudo.rows,
    campanas: campanas.rows,
    actividad: actividad.rows,
  };
}

/* ============================================================
   Vistas guardadas
   ============================================================ */

export async function listarVistas(sucursalId: string, usuarioId: string) {
  const { rows } = await getPool().query(
    `SELECT v.id, v.nombre, v.compartida, v.config, (v.usuario_id = $2) AS propia, u.nombre AS autor
       FROM crm_vistas v LEFT JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.sucursal_id = $1 AND (v.usuario_id = $2 OR v.compartida)
      ORDER BY v.compartida, lower(v.nombre)`,
    [sucursalId, usuarioId],
  );
  return rows;
}

export async function guardarVista(p: {
  sucursalId: string;
  usuarioId: string;
  nombre: string;
  config: Record<string, unknown>;
  compartida: boolean;
}): Promise<{ id: string } | { error: string }> {
  const { rows } = await getPool().query(`SELECT id FROM usuarios WHERE id = $1`, [p.usuarioId]);
  if (!rows[0]) return { error: "Tu cuenta no puede guardar vistas." };
  try {
    const r = await getPool().query(
      `INSERT INTO crm_vistas (sucursal_id, usuario_id, nombre, compartida, config) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [p.sucursalId, p.usuarioId, p.nombre.trim(), p.compartida, p.config],
    );
    return { id: r.rows[0].id as string };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { error: "Ya tienes una vista con ese nombre." };
    throw err;
  }
}

/** Borra una vista propia; el admin también puede borrar las compartidas. */
export async function borrarVista(sucursalId: string, vistaId: string, usuarioId: string, esAdmin: boolean): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM crm_vistas WHERE id = $1 AND sucursal_id = $2 AND (usuario_id = $3 OR ($4 AND compartida))`,
    [vistaId, sucursalId, usuarioId, esAdmin],
  );
  return (rowCount ?? 0) > 0;
}
