import { getPool } from "./db.js";
import { autorValido } from "./crm.js";

/**
 * Proceso comercial del CRM: registro de contactos, línea de tiempo, contrato (evidencia de venta),
 * reportes del embudo y reasignación de cartera.
 */

const ZONA = "America/Hermosillo";

/* ============================================================
   Registro de contacto y notas
   ============================================================ */

export const CANALES = ["llamada", "whatsapp"] as const;
export const RESULTADOS = ["contesto", "buzon", "no_contesto", "numero_equivocado"] as const;
export type Canal = (typeof CANALES)[number];
export type Resultado = (typeof RESULTADOS)[number];

const TITULO_CONTACTO: Record<Canal, Record<Resultado, string>> = {
  llamada: {
    contesto: "Llamada: contestó",
    buzon: "Llamada: buzón de voz",
    no_contesto: "Llamada: no contestó",
    numero_equivocado: "Llamada: número equivocado",
  },
  whatsapp: {
    contesto: "WhatsApp: el cliente respondió",
    buzon: "WhatsApp: buzón",
    no_contesto: "WhatsApp: sin respuesta",
    numero_equivocado: "WhatsApp: número equivocado",
  },
};

/** Estado de contacto que deja cada resultado. */
const ESTADO_POR_RESULTADO: Record<Resultado, string> = {
  contesto: "contactado",
  buzon: "buzon",
  no_contesto: "intentando",
  numero_equivocado: "no_contactable",
};

export type ResultadoOperacion = { ok: true } | { ok: false; estado: 400 | 404; error: string };

/**
 * Registra un intento de contacto: lo deja en la línea de tiempo, suma un intento, pone la fecha de
 * último contacto (hoy en Hermosillo) y actualiza el estado de contacto. Quien ya está "Contactado"
 * no retrocede por un buzón o un "no contestó": el intento se cuenta, el estado se conserva.
 * No mueve la etapa: eso sigue siendo decisión del ejecutivo.
 */
export async function registrarContacto(p: {
  sucursalId: string;
  oportunidadId: string;
  canal: Canal;
  resultado: Resultado;
  nota?: string | null;
  usuarioId?: string;
}): Promise<ResultadoOperacion> {
  if (p.canal === "whatsapp" && p.resultado === "buzon") return { ok: false, estado: 400, error: "WhatsApp no tiene buzón." };
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `SELECT estado_contacto FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2 FOR UPDATE`,
      [p.oportunidadId, p.sucursalId],
    );
    if (!rows[0]) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }
    const actual = rows[0].estado_contacto as string;
    const retrocede = actual === "contactado" && (p.resultado === "buzon" || p.resultado === "no_contesto");
    const nuevo = retrocede ? actual : ESTADO_POR_RESULTADO[p.resultado];

    await cliente.query(
      `UPDATE crm_oportunidades
          SET estado_contacto = $3, intentos = intentos + 1, ultimo_intento_en = now(),
              fecha_ultimo_contacto = (now() AT TIME ZONE '${ZONA}')::date
        WHERE id = $1 AND sucursal_id = $2`,
      [p.oportunidadId, p.sucursalId, nuevo],
    );
    await cliente.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        p.sucursalId,
        p.oportunidadId,
        p.canal,
        TITULO_CONTACTO[p.canal][p.resultado],
        { resultado: p.resultado, nota: p.nota?.trim() || null },
        await autorValido(cliente, p.usuarioId),
      ],
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

export async function agregarNota(p: { sucursalId: string; oportunidadId: string; texto: string; usuarioId?: string }): Promise<ResultadoOperacion> {
  const cliente = await getPool().connect();
  try {
    const { rows } = await cliente.query(`SELECT 1 FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2`, [p.oportunidadId, p.sucursalId]);
    if (!rows[0]) return { ok: false, estado: 404, error: "Registro no encontrado." };
    await cliente.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id) VALUES ($1, $2, 'nota', 'Nota', $3, $4)`,
      [p.sucursalId, p.oportunidadId, { texto: p.texto.trim() }, await autorValido(cliente, p.usuarioId)],
    );
    return { ok: true };
  } finally {
    cliente.release();
  }
}

/* ============================================================
   Línea de tiempo y ficha
   ============================================================ */

export async function lineaDeTiempo(sucursalId: string, oportunidadId: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM (
       SELECT a.tipo, a.titulo, a.detalle, u.nombre AS autor, a.creado_en
         FROM crm_actividades a LEFT JOIN usuarios u ON u.id = a.usuario_id
        WHERE a.oportunidad_id = $1 AND a.sucursal_id = $2
       UNION ALL
       SELECT 'etapa', 'Etapa: ' || coalesce(eo.nombre || ' a ', '') || ed.nombre,
              jsonb_build_object('origen', h.origen, 'motivo', mp.nombre), u.nombre, h.creado_en
         FROM crm_historial_etapas h
         JOIN crm_etapas ed ON ed.id = h.etapa_destino_id
         LEFT JOIN crm_etapas eo ON eo.id = h.etapa_origen_id
         LEFT JOIN crm_motivos_perdida mp ON mp.id = h.motivo_perdida_id
         LEFT JOIN usuarios u ON u.id = h.usuario_id
        WHERE h.oportunidad_id = $1 AND h.sucursal_id = $2
       UNION ALL
       SELECT 'tarea', 'Tarea hecha: ' || t.titulo, jsonb_build_object('respuesta', t.respuesta), u.nombre, t.completada_en
         FROM crm_tareas t LEFT JOIN usuarios u ON u.id = t.completada_por
        WHERE t.oportunidad_id = $1 AND t.sucursal_id = $2 AND t.estado = 'hecha' AND t.completada_en IS NOT NULL
     ) x ORDER BY creado_en DESC LIMIT 200`,
    [oportunidadId, sucursalId],
  );
  return rows;
}

/* ============================================================
   Contrato (evidencia de venta)
   ============================================================ */

export const ESTADOS_CONTRATO = [
  "sin_contrato",
  "cotizado",
  "aceptado",
  "orden_pago",
  "pago_confirmado",
  "certificado_entregado",
  "cobertura_iniciada",
  "cancelado",
] as const;

export async function leerContrato(sucursalId: string, oportunidadId: string) {
  const { rows } = await getPool().query(
    `SELECT estado, folio, eventos, actualizado_en FROM crm_contratos WHERE oportunidad_id = $1 AND sucursal_id = $2`,
    [oportunidadId, sucursalId],
  );
  return rows[0] ?? { estado: "sin_contrato", folio: null, eventos: [], actualizado_en: null };
}

export async function guardarContrato(p: {
  sucursalId: string;
  oportunidadId: string;
  estado: (typeof ESTADOS_CONTRATO)[number];
  folio?: string | null;
  usuarioId?: string;
  /** «sistema» cuando el cambio lo hizo una regla automática y no una persona. */
  origen?: "sistema";
}): Promise<ResultadoOperacion> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(`SELECT 1 FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2`, [p.oportunidadId, p.sucursalId]);
    if (!rows[0]) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }
    const autor = await autorValido(cliente, p.usuarioId);
    const evento = { estado: p.estado, folio: p.folio?.trim() || null, en: new Date().toISOString(), usuario_id: autor, ...(p.origen ? { origen: p.origen } : {}) };
    await cliente.query(
      `INSERT INTO crm_contratos (sucursal_id, oportunidad_id, estado, folio, eventos)
       VALUES ($1, $2, $3, $4, jsonb_build_array($5::jsonb))
       ON CONFLICT (oportunidad_id) DO UPDATE
         SET estado = EXCLUDED.estado, folio = coalesce(EXCLUDED.folio, crm_contratos.folio),
             eventos = crm_contratos.eventos || EXCLUDED.eventos`,
      [p.sucursalId, p.oportunidadId, p.estado, p.folio?.trim() || null, JSON.stringify(evento)],
    );
    await cliente.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id) VALUES ($1, $2, 'contrato', $3, $4, $5)`,
      [
        p.sucursalId,
        p.oportunidadId,
        `Contrato: ${p.estado.replace(/_/g, " ")}${p.origen === "sistema" ? " (automático)" : ""}`,
        { estado: p.estado, folio: p.folio?.trim() || null, ...(p.origen ? { origen: p.origen } : {}) },
        autor,
      ],
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
   Reporte del embudo
   ============================================================ */

/**
 * Embudo actual (cuántas hay en cada etapa y cuánto llevan ahí), flujo del periodo (a qué etapas
 * entraron, ventas y pérdidas), motivos de pérdida, desempeño por ejecutivo y resultado de los
 * contactos. Con `ejecutivo` solo cuenta lo de ese ejecutivo (el asesor ve lo suyo).
 * Solo cuentan movimientos hechos por personas o automatizaciones: la migración y la sincronización
 * no son trabajo del equipo.
 */
export async function reporteEmbudo(sucursalId: string, desde: string, hasta: string, ejecutivo: string | null) {
  const pool = getPool();
  const ini = `(($2::date)::timestamp AT TIME ZONE '${ZONA}')`;
  const fin = `((($3::date) + 1)::timestamp AT TIME ZONE '${ZONA}')`;
  const filtroEj = ejecutivo ? " AND o.ejecutivo = $4" : "";
  const args = (extra: unknown[] = []) => [sucursalId, desde, hasta, ...(ejecutivo ? [ejecutivo] : []), ...extra];
  const argsActual = ejecutivo ? [sucursalId, ejecutivo] : [sucursalId];

  const [actual, flujo, motivos, equipo, contactos, tareas] = await Promise.all([
    pool.query(
      `SELECT e.id, e.nombre, e.color, e.tipo, e.orden, e.tiempo_max_horas, count(o.id)::int AS total,
              coalesce(round(avg(extract(epoch FROM now() - o.entro_a_etapa_en) / 3600)::numeric, 1), 0)::float AS horas_promedio,
              count(*) FILTER (WHERE e.tipo = 'abierta' AND e.tiempo_max_horas IS NOT NULL
                               AND o.entro_a_etapa_en < now() - make_interval(hours => e.tiempo_max_horas))::int AS fuera_sla
         FROM crm_etapas e
         LEFT JOIN crm_oportunidades o ON o.etapa_id = e.id AND (e.tipo <> 'abierta' OR o.estado_cartera = 'ACTIVA')${ejecutivo ? " AND o.ejecutivo = $2" : ""}
        WHERE e.sucursal_id = $1 AND e.activa GROUP BY e.id ORDER BY e.orden`,
      argsActual,
    ),
    pool.query(
      `SELECT ed.id, ed.nombre, ed.tipo, count(*)::int AS entradas
         FROM crm_historial_etapas h JOIN crm_etapas ed ON ed.id = h.etapa_destino_id
         JOIN crm_oportunidades o ON o.id = h.oportunidad_id
        WHERE h.sucursal_id = $1 AND h.origen IN ('manual', 'automatizacion')
          AND h.creado_en >= ${ini} AND h.creado_en < ${fin}${filtroEj}
        GROUP BY ed.id ORDER BY ed.orden`,
      args(),
    ),
    pool.query(
      `SELECT coalesce(mp.nombre, 'Sin motivo') AS motivo, count(*)::int AS total
         FROM crm_historial_etapas h JOIN crm_etapas ed ON ed.id = h.etapa_destino_id AND ed.tipo = 'perdida'
         JOIN crm_oportunidades o ON o.id = h.oportunidad_id
         LEFT JOIN crm_motivos_perdida mp ON mp.id = h.motivo_perdida_id
        WHERE h.sucursal_id = $1 AND h.origen IN ('manual', 'automatizacion')
          AND h.creado_en >= ${ini} AND h.creado_en < ${fin}${filtroEj}
        GROUP BY 1 ORDER BY 2 DESC`,
      args(),
    ),
    pool.query(
      `SELECT o.ejecutivo,
              count(*) FILTER (WHERE o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta')::int AS cartera_abierta,
              count(*) FILTER (WHERE o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta' AND o.estado_contacto = 'sin_intentar')::int AS sin_intentar
         FROM crm_oportunidades o
        WHERE o.sucursal_id = $1 AND o.ejecutivo IS NOT NULL${ejecutivo ? " AND o.ejecutivo = $2" : ""}
        GROUP BY o.ejecutivo ORDER BY o.ejecutivo`,
      argsActual,
    ),
    pool.query(
      `SELECT o.ejecutivo, a.tipo AS canal, coalesce(a.detalle->>'resultado', 'sin_dato') AS resultado, count(*)::int AS total
         FROM crm_actividades a JOIN crm_oportunidades o ON o.id = a.oportunidad_id
        WHERE a.sucursal_id = $1 AND a.tipo IN ('llamada', 'whatsapp') AND coalesce(a.detalle->>'origen', '') <> 'migracion'
          AND a.creado_en >= ${ini} AND a.creado_en < ${fin}${filtroEj}
        GROUP BY 1, 2, 3`,
      args(),
    ),
    pool.query(
      `SELECT t.asignado_a AS ejecutivo,
              count(*) FILTER (WHERE t.estado = 'pendiente')::int AS pendientes,
              count(*) FILTER (WHERE t.estado = 'pendiente' AND t.vence_en < now())::int AS vencidas,
              count(*) FILTER (WHERE t.estado = 'hecha' AND t.completada_en >= ${ini} AND t.completada_en < ${fin})::int AS hechas_periodo
         FROM crm_tareas t JOIN crm_oportunidades o ON o.id = t.oportunidad_id
        WHERE t.sucursal_id = $1${filtroEj}
        GROUP BY 1`,
      args(),
    ),
  ]);

  const entradas = (tipo: string) => flujo.rows.filter((r) => r.tipo === tipo).reduce((n, r) => n + (r.entradas as number), 0);
  const ganadas = entradas("ganada");
  const perdidas = entradas("perdida");

  const porEjecutivo = new Map<string, Record<string, unknown>>();
  const fila = (nombre: string) => {
    if (!porEjecutivo.has(nombre)) {
      porEjecutivo.set(nombre, {
        ejecutivo: nombre,
        cartera_abierta: 0,
        sin_intentar: 0,
        llamadas: 0,
        whatsapps: 0,
        contactos_efectivos: 0,
        tareas_pendientes: 0,
        tareas_vencidas: 0,
        tareas_hechas: 0,
      });
    }
    return porEjecutivo.get(nombre)!;
  };
  for (const r of equipo.rows) Object.assign(fila(r.ejecutivo), { cartera_abierta: r.cartera_abierta, sin_intentar: r.sin_intentar });
  for (const r of contactos.rows) {
    const f = fila((r.ejecutivo as string | null) ?? "Sin asignar");
    if (r.canal === "llamada") f.llamadas = (f.llamadas as number) + (r.total as number);
    else f.whatsapps = (f.whatsapps as number) + (r.total as number);
    if (r.resultado === "contesto") f.contactos_efectivos = (f.contactos_efectivos as number) + (r.total as number);
  }
  for (const r of tareas.rows) {
    const f = fila((r.ejecutivo as string | null) ?? "Sin asignar");
    Object.assign(f, { tareas_pendientes: r.pendientes, tareas_vencidas: r.vencidas, tareas_hechas: r.hechas_periodo });
  }

  return {
    periodo: { desde, hasta },
    embudo_actual: actual.rows,
    flujo: flujo.rows,
    ventas: { ganadas, perdidas, tasa_cierre: ganadas + perdidas > 0 ? Math.round((ganadas / (ganadas + perdidas)) * 1000) / 10 : null },
    motivos_perdida: motivos.rows,
    por_ejecutivo: [...porEjecutivo.values()],
  };
}

/* ============================================================
   Equipo: roster, carga y reasignación
   ============================================================ */

export async function estadoEquipo(sucursalId: string) {
  const pool = getPool();
  const [cfg, carga] = await Promise.all([
    pool.query(`SELECT roster_ejecutivos, exigir_evidencia_venta FROM crm_config WHERE sucursal_id = $1`, [sucursalId]),
    pool.query(
      `SELECT o.ejecutivo,
              count(*) FILTER (WHERE o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta')::int AS abiertas,
              (SELECT count(*)::int FROM crm_tareas t WHERE t.sucursal_id = $1 AND t.estado = 'pendiente' AND t.asignado_a = o.ejecutivo) AS tareas_pendientes
         FROM crm_oportunidades o WHERE o.sucursal_id = $1 AND o.ejecutivo IS NOT NULL GROUP BY o.ejecutivo ORDER BY 1`,
      [sucursalId],
    ),
  ]);
  return {
    roster: (cfg.rows[0]?.roster_ejecutivos as string[] | undefined) ?? [],
    exigir_evidencia_venta: cfg.rows[0]?.exigir_evidencia_venta === true,
    carga: carga.rows,
  };
}

export async function guardarConfigEquipo(sucursalId: string, cambios: { roster?: string[]; exigir_evidencia_venta?: boolean }): Promise<void> {
  await getPool().query(
    `INSERT INTO crm_config (sucursal_id, roster_ejecutivos, exigir_evidencia_venta)
     VALUES ($1, coalesce($2::text[], '{}'), coalesce($3, false))
     ON CONFLICT (sucursal_id) DO UPDATE SET
       roster_ejecutivos = coalesce($2::text[], crm_config.roster_ejecutivos),
       exigir_evidencia_venta = coalesce($3, crm_config.exigir_evidencia_venta),
       actualizado_en = now()`,
    [sucursalId, cambios.roster ?? null, cambios.exigir_evidencia_venta ?? null],
  );
}

export type ResultadoReasignacion = { total: number; destinos: { ejecutivo: string; cantidad: number }[]; aplicado: boolean };

/**
 * Pasa la cartera abierta y activa de un ejecutivo a otro, o la reparte de forma equilibrada entre
 * el resto del roster (cada una va al menos cargado). Las tareas pendientes viajan con su
 * oportunidad. Con `simular` solo calcula. Cada traspaso queda en la línea de tiempo.
 */
export async function reasignarCartera(p: {
  sucursalId: string;
  de: string;
  a: string | null;
  simular: boolean;
  usuarioId?: string;
}): Promise<ResultadoReasignacion | { error: string }> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows: cfg } = await cliente.query(`SELECT roster_ejecutivos FROM crm_config WHERE sucursal_id = $1`, [p.sucursalId]);
    const roster = (cfg[0]?.roster_ejecutivos as string[] | undefined) ?? [];
    const candidatos = p.a ? [p.a] : roster.filter((e) => e !== p.de);
    if (candidatos.length === 0) {
      await cliente.query("ROLLBACK");
      return { error: "No hay ejecutivos de destino: revisa el roster del equipo." };
    }
    if (p.a === p.de) {
      await cliente.query("ROLLBACK");
      return { error: "El origen y el destino son el mismo ejecutivo." };
    }

    const { rows: aMover } = await cliente.query(
      `SELECT id FROM crm_oportunidades WHERE sucursal_id = $1 AND ejecutivo = $2 AND estado_cartera = 'ACTIVA' AND estado = 'abierta' ORDER BY posicion FOR UPDATE`,
      [p.sucursalId, p.de],
    );
    const { rows: cargas } = await cliente.query(
      `SELECT ejecutivo, count(*)::int AS n FROM crm_oportunidades
        WHERE sucursal_id = $1 AND estado_cartera = 'ACTIVA' AND estado = 'abierta' AND ejecutivo = ANY($2::text[]) GROUP BY ejecutivo`,
      [p.sucursalId, candidatos],
    );
    const carga = new Map<string, number>(candidatos.map((e) => [e, 0]));
    for (const r of cargas) carga.set(r.ejecutivo as string, r.n as number);

    const asignaciones: { id: string; a: string }[] = [];
    for (const o of aMover) {
      let mejor = candidatos[0];
      for (const c of candidatos) if ((carga.get(c) ?? 0) < (carga.get(mejor) ?? 0)) mejor = c;
      carga.set(mejor, (carga.get(mejor) ?? 0) + 1);
      asignaciones.push({ id: o.id as string, a: mejor });
    }

    const conteo = new Map<string, number>();
    for (const x of asignaciones) conteo.set(x.a, (conteo.get(x.a) ?? 0) + 1);
    const resumen: ResultadoReasignacion = {
      total: asignaciones.length,
      destinos: [...conteo.entries()].map(([ejecutivo, cantidad]) => ({ ejecutivo, cantidad })),
      aplicado: !p.simular,
    };

    if (p.simular || asignaciones.length === 0) {
      await cliente.query("ROLLBACK");
      return resumen;
    }

    const json = JSON.stringify(asignaciones);
    await cliente.query(
      `UPDATE crm_oportunidades o SET ejecutivo = r.a FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, a text)
        WHERE o.id = r.id AND o.sucursal_id = $1`,
      [p.sucursalId, json],
    );
    await cliente.query(
      `UPDATE crm_tareas t SET asignado_a = r.a FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, a text)
        WHERE t.oportunidad_id = r.id AND t.sucursal_id = $1 AND t.estado = 'pendiente'`,
      [p.sucursalId, json],
    );
    const autor = await autorValido(cliente, p.usuarioId);
    await cliente.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id)
       SELECT $1, r.id, 'reasignacion', 'Ejecutivo', jsonb_build_object('campo', 'ejecutivo', 'anterior', $3::text, 'nuevo', r.a, 'motivo', 'reasignacion masiva'), $4
         FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, a text)`,
      [p.sucursalId, json, p.de, autor],
    );
    await cliente.query("COMMIT");
    return resumen;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}
