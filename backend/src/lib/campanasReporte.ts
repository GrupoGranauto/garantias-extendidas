import { getPool } from "./db.js";
import { ZONA_ENVIOS } from "./campanasLogica.js";

/**
 * Reporte del ciclo de campañas en un periodo. Cuenta a cada lead en el periodo de su PRIMER mensaje real de la campaña
 * (las simulaciones se cuentan aparte y nunca entran a las tasas), y de ahí sigue qué pasó: si respondió, si contestó,
 * a qué etapas del embudo avanzó y si terminó en venta. Incluye también los mensajes de la campaña y sus seguimientos.
 */

export type FilaCampana = {
  campana: string;
  /** Leads cuyo primer mensaje real de la campaña cae en el periodo. */
  leads: number;
  respondieron: number;
  contestaron: number;
  ventas: number;
  /** A qué etapas llegaron esos leads después del primer mensaje (por equipo o automatización). */
  avance: { etapa: string; total: number }[];
  mensajes: { enviados: number; entregados: number; leidos: number; fallidos: number; omitidos: number; simulados: number; pendientes: number };
  /** Por qué no salieron los omitidos. */
  omitidos_por_motivo: { motivo: string; total: number }[];
  seguimientos: { hechos: number; omitidos: number; simulados: number; pendientes: number; tareas_creadas: number; tareas_hechas: number };
};

export async function reporteCampanas(sucursalId: string, desde: string, hasta: string, ejecutivo: string | null) {
  const pool = getPool();
  const ini = `(($2::date)::timestamp AT TIME ZONE '${ZONA_ENVIOS}')`;
  const fin = `((($3::date) + 1)::timestamp AT TIME ZONE '${ZONA_ENVIOS}')`;
  const filtroEj = ejecutivo ? " AND o.ejecutivo = $4" : "";
  const args = [sucursalId, desde, hasta, ...(ejecutivo ? [ejecutivo] : [])];

  // Los leads del periodo: el primer mensaje REAL de cada campaña.
  const primeros = `
    SELECT e.campana, e.oportunidad_id, o.contacto_id, min(e.enviado_en) AS primero
      FROM crm_envios e JOIN crm_oportunidades o ON o.id = e.oportunidad_id
     WHERE e.sucursal_id = $1 AND e.paso_id IS NOT NULL AND e.estado IN ('enviado', 'entregado', 'leido')${filtroEj}
     GROUP BY e.campana, e.oportunidad_id, o.contacto_id
    HAVING min(e.enviado_en) >= ${ini} AND min(e.enviado_en) < ${fin}`;

  const [cohorte, avance, mensajes, motivos, seg] = await Promise.all([
    pool.query(
      `WITH p AS (${primeros})
       SELECT p.campana, count(*)::int AS leads,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM whatsapp_mensajes m JOIN whatsapp_conversaciones cv ON cv.id = m.conversacion_id
                  JOIN crm_contactos c ON c.id = p.contacto_id
                 WHERE cv.sucursal_id = $1 AND m.direccion = 'entrante' AND m.creado_en >= p.primero
                   AND length(regexp_replace(coalesce(c.telefono, ''), '\\D', '', 'g')) >= 10
                   AND right(regexp_replace(cv.wa_id, '\\D', '', 'g'), 10) = right(regexp_replace(c.telefono, '\\D', '', 'g'), 10)
              ))::int AS respondieron,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM crm_actividades a WHERE a.oportunidad_id = p.oportunidad_id AND a.tipo IN ('llamada', 'whatsapp')
                   AND a.detalle->>'resultado' = 'contesto' AND a.creado_en >= p.primero
              ))::int AS contestaron
         FROM p GROUP BY p.campana`,
      args,
    ),
    pool.query(
      `WITH p AS (${primeros})
       SELECT p.campana, ed.nombre AS etapa, ed.tipo, ed.orden, count(DISTINCT p.oportunidad_id)::int AS total
         FROM p JOIN crm_historial_etapas h ON h.oportunidad_id = p.oportunidad_id AND h.creado_en >= p.primero
                                           AND h.origen IN ('manual', 'automatizacion')
         JOIN crm_etapas ed ON ed.id = h.etapa_destino_id
        GROUP BY p.campana, ed.nombre, ed.tipo, ed.orden ORDER BY p.campana, ed.orden`,
      args,
    ),
    pool.query(
      `SELECT e.campana,
              count(*) FILTER (WHERE e.estado IN ('enviado', 'entregado', 'leido'))::int AS enviados,
              count(*) FILTER (WHERE e.estado IN ('entregado', 'leido'))::int AS entregados,
              count(*) FILTER (WHERE e.estado = 'leido')::int AS leidos,
              count(*) FILTER (WHERE e.estado = 'fallido')::int AS fallidos,
              count(*) FILTER (WHERE e.estado = 'omitido')::int AS omitidos,
              count(*) FILTER (WHERE e.estado = 'simulado')::int AS simulados,
              count(*) FILTER (WHERE e.estado = 'pendiente')::int AS pendientes
         FROM crm_envios e JOIN crm_oportunidades o ON o.id = e.oportunidad_id
        WHERE e.sucursal_id = $1 AND coalesce(e.enviado_en, e.programado_para) >= ${ini} AND coalesce(e.enviado_en, e.programado_para) < ${fin}${filtroEj}
        GROUP BY e.campana`,
      args,
    ),
    pool.query(
      `SELECT e.campana, e.motivo, count(*)::int AS total
         FROM crm_envios e JOIN crm_oportunidades o ON o.id = e.oportunidad_id
        WHERE e.sucursal_id = $1 AND e.estado = 'omitido' AND e.motivo IS NOT NULL
          AND coalesce(e.enviado_en, e.programado_para) >= ${ini} AND coalesce(e.enviado_en, e.programado_para) < ${fin}${filtroEj}
        GROUP BY e.campana, e.motivo ORDER BY total DESC`,
      args,
    ),
    pool.query(
      `SELECT s.campana,
              count(*) FILTER (WHERE x.estado = 'hecho')::int AS hechos,
              count(*) FILTER (WHERE x.estado = 'omitido')::int AS omitidos,
              count(*) FILTER (WHERE x.estado = 'simulado')::int AS simulados,
              count(*) FILTER (WHERE x.estado = 'pendiente')::int AS pendientes,
              count(*) FILTER (WHERE x.tarea_id IS NOT NULL)::int AS tareas_creadas,
              count(*) FILTER (WHERE t.estado = 'hecha')::int AS tareas_hechas
         FROM crm_seguimiento_ejecuciones x
         JOIN crm_seguimientos s ON s.id = x.seguimiento_id
         JOIN crm_oportunidades o ON o.id = x.oportunidad_id
         LEFT JOIN crm_tareas t ON t.id = x.tarea_id
        WHERE x.sucursal_id = $1 AND x.programado_para >= ${ini} AND x.programado_para < ${fin}${filtroEj}
        GROUP BY s.campana`,
      args,
    ),
  ]);

  const nombres = new Set<string>();
  for (const r of [...cohorte.rows, ...mensajes.rows, ...seg.rows]) nombres.add(r.campana as string);

  const campanas: FilaCampana[] = [...nombres].sort().map((nombre) => {
    const c = cohorte.rows.find((r) => r.campana === nombre);
    const m = mensajes.rows.find((r) => r.campana === nombre);
    const s = seg.rows.find((r) => r.campana === nombre);
    const av = avance.rows.filter((r) => r.campana === nombre);
    return {
      campana: nombre,
      leads: (c?.leads as number | undefined) ?? 0,
      respondieron: (c?.respondieron as number | undefined) ?? 0,
      contestaron: (c?.contestaron as number | undefined) ?? 0,
      ventas: av.filter((r) => r.tipo === "ganada").reduce((n, r) => n + (r.total as number), 0),
      avance: av.map((r) => ({ etapa: r.etapa as string, total: r.total as number })),
      mensajes: {
        enviados: (m?.enviados as number | undefined) ?? 0,
        entregados: (m?.entregados as number | undefined) ?? 0,
        leidos: (m?.leidos as number | undefined) ?? 0,
        fallidos: (m?.fallidos as number | undefined) ?? 0,
        omitidos: (m?.omitidos as number | undefined) ?? 0,
        simulados: (m?.simulados as number | undefined) ?? 0,
        pendientes: (m?.pendientes as number | undefined) ?? 0,
      },
      omitidos_por_motivo: motivos.rows.filter((r) => r.campana === nombre).map((r) => ({ motivo: r.motivo as string, total: r.total as number })),
      seguimientos: {
        hechos: (s?.hechos as number | undefined) ?? 0,
        omitidos: (s?.omitidos as number | undefined) ?? 0,
        simulados: (s?.simulados as number | undefined) ?? 0,
        pendientes: (s?.pendientes as number | undefined) ?? 0,
        tareas_creadas: (s?.tareas_creadas as number | undefined) ?? 0,
        tareas_hechas: (s?.tareas_hechas as number | undefined) ?? 0,
      },
    };
  });

  return { periodo: { desde, hasta }, campanas };
}
