import { getPool } from "./db.js";
import { configPorSucursalId, enviarMensaje } from "./whatsapp.js";
import { emitirEventoChat } from "./eventosChat.js";
import { horaDelPaso } from "./campanasDefLogica.js";
import { leerDescripciones, leerFuente } from "./campanasDefinidas.js";
import {
  CAMPANAS_CONOCIDAS,
  ZONA_ENVIOS,
  ahoraLocal,
  calcularProgramacion,
  decidirEnvio,
  siguienteApertura,
  telefono10,
  type ContextoEnvio,
  type Decision,
  type Ventana,
} from "./campanasLogica.js";

/**
 * Envíos automáticos de WhatsApp por campaña.
 *
 *  - Configuración: por campaña, una ventana de envío (días y horas), un tope diario, un descanso entre
 *    campañas y una cadencia de pasos (plantilla, días después del inicio, hora, condiciones).
 *  - Planificador: por cada oportunidad activa de una campaña encendida deja una fila en crm_envios por
 *    paso (única por oportunidad y paso: nunca se manda dos veces lo mismo).
 *  - Despachador: toma lo que ya le toca y decide (campanasLogica.decidirEnvio). En modo "simulación"
 *    solo registra qué enviaría; en modo "real" manda la plantilla por WhatsApp.
 *
 * Una baja (el contacto pidió no recibir más) se respeta siempre.
 */

/* ============================================================
   Configuración
   ============================================================ */

export type PasoCampana = {
  id?: string;
  plantilla_id: string | null;
  dias_despues: number;
  hora: string | null;
  vigencia_dias: number;
  solo_sin_respuesta: boolean;
  solo_sin_contacto: boolean;
  etapas: string[];
};

export type ConfigCampana = {
  activa: boolean;
  modo: "simulacion" | "real";
  dias_semana: number[];
  hora_inicio: string;
  hora_fin: string;
  max_por_dia: number;
  dias_entre_mensajes: number;
  pasos: PasoCampana[];
};

const hhmm = (v: string | null) => (v ? v.slice(0, 5) : null);

/** Deja creadas (apagadas) las campañas conocidas y las que ya existan en la cartera. */
export async function asegurarCampanas(sucursalId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO crm_campanas_envio (sucursal_id, campana)
     SELECT $1, c FROM unnest($2::text[] || ARRAY(SELECT DISTINCT campana FROM crm_oportunidades WHERE sucursal_id = $1 AND campana IS NOT NULL AND campana <> '6M')) AS c
     ON CONFLICT (sucursal_id, campana) DO NOTHING`,
    [sucursalId, [...CAMPANAS_CONOCIDAS]],
  );
}

export async function leerCampanas(sucursalId: string) {
  await asegurarCampanas(sucursalId);
  const pool = getPool();
  const { rows: cfgs } = await pool.query(
    `SELECT id, campana, activa, modo, dias_semana, hora_inicio::text AS hora_inicio, hora_fin::text AS hora_fin, max_por_dia, dias_entre_mensajes
       FROM crm_campanas_envio WHERE sucursal_id = $1 ORDER BY campana`,
    [sucursalId],
  );
  const { rows: pasos } = await pool.query(
    `SELECT p.id, p.config_id, p.orden, p.plantilla_id, p.dias_despues, p.hora::text AS hora, p.vigencia_dias, p.solo_sin_respuesta, p.solo_sin_contacto, p.etapas
       FROM crm_campana_pasos p JOIN crm_campanas_envio c ON c.id = p.config_id WHERE c.sucursal_id = $1 ORDER BY p.orden`,
    [sucursalId],
  );
  const fuente = await leerFuente(pool, sucursalId);
  // Con la web como fuente, «activas» son las que ella calculó; con BigQuery, las que él mandó.
  const { rows: activas } =
    fuente === "web"
      ? await pool.query(
          `SELECT w.campana, count(*)::int AS n, min(w.inicio)::text AS inicio, max(w.inicio)::text AS fin
             FROM crm_campana_calculada w JOIN crm_oportunidades o ON o.id = w.oportunidad_id
            WHERE w.sucursal_id = $1 AND o.estado = 'abierta' GROUP BY w.campana`,
          [sucursalId],
        )
      : await pool.query(
          `SELECT campana, count(*)::int AS n, min(fecha_inicio_campana)::text AS inicio, max(fecha_fin_campana)::text AS fin
             FROM crm_oportunidades WHERE sucursal_id = $1 AND estado_cartera = 'ACTIVA' AND estado = 'abierta' GROUP BY campana`,
          [sucursalId],
        );
  const porCampana = new Map(activas.map((a) => [a.campana as string, a]));
  const detalles = await leerDescripciones(pool, sucursalId);
  return cfgs.map((c) => ({
    campana: c.campana as string,
    detalle: fuente === "web" ? (detalles.get(c.campana as string) ?? null) : null,
    activa: c.activa as boolean,
    modo: c.modo as "simulacion" | "real",
    dias_semana: c.dias_semana as number[],
    hora_inicio: hhmm(c.hora_inicio)!,
    hora_fin: hhmm(c.hora_fin)!,
    max_por_dia: c.max_por_dia as number,
    dias_entre_mensajes: c.dias_entre_mensajes as number,
    oportunidades_activas: (porCampana.get(c.campana)?.n as number | undefined) ?? 0,
    inicio: (porCampana.get(c.campana)?.inicio as string | undefined) ?? null,
    fin: (porCampana.get(c.campana)?.fin as string | undefined) ?? null,
    pasos: pasos
      .filter((p) => p.config_id === c.id)
      .map((p) => ({
        id: p.id as string,
        plantilla_id: p.plantilla_id as string | null,
        dias_despues: p.dias_despues as number,
        hora: hhmm(p.hora),
        vigencia_dias: p.vigencia_dias as number,
        solo_sin_respuesta: p.solo_sin_respuesta as boolean,
        solo_sin_contacto: p.solo_sin_contacto as boolean,
        etapas: p.etapas as string[],
      })),
  }));
}

export type ResultadoGuardar = { ok: true } | { ok: false; error: string };

/**
 * Guarda la configuración y la cadencia de una campaña. Lo que aún no se había enviado se vuelve a
 * programar con las reglas nuevas; lo ya enviado u omitido queda como historial.
 */
export async function guardarCampana(sucursalId: string, campana: string, datos: ConfigCampana): Promise<ResultadoGuardar> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(`SELECT id FROM crm_campanas_envio WHERE sucursal_id = $1 AND campana = $2 FOR UPDATE`, [sucursalId, campana]);
    if (!rows[0]) {
      await cliente.query("ROLLBACK");
      return { ok: false, error: "La campaña no existe." };
    }
    const configId = rows[0].id as string;

    // Las plantillas deben ser de esta sucursal.
    const plantillas = [...new Set(datos.pasos.map((p) => p.plantilla_id).filter((x): x is string => Boolean(x)))];
    if (plantillas.length > 0) {
      const { rows: ok } = await cliente.query(`SELECT id FROM whatsapp_plantillas WHERE sucursal_id = $1 AND id = ANY($2::uuid[])`, [sucursalId, plantillas]);
      if (ok.length !== plantillas.length) {
        await cliente.query("ROLLBACK");
        return { ok: false, error: "Una de las plantillas elegidas no existe en esta sucursal." };
      }
    }

    await cliente.query(
      `UPDATE crm_campanas_envio
          SET activa = $2, modo = $3, dias_semana = $4, hora_inicio = $5, hora_fin = $6, max_por_dia = $7, dias_entre_mensajes = $8
        WHERE id = $1`,
      [configId, datos.activa, datos.modo, datos.dias_semana, datos.hora_inicio, datos.hora_fin, datos.max_por_dia, datos.dias_entre_mensajes],
    );

    const { rows: existentes } = await cliente.query(`SELECT id FROM crm_campana_pasos WHERE config_id = $1`, [configId]);
    const ids = new Set(existentes.map((r) => r.id as string));
    const conservados = new Set<string>();
    for (const [orden, p] of datos.pasos.entries()) {
      const valores = [orden, p.plantilla_id, p.dias_despues, p.hora, p.vigencia_dias, p.solo_sin_respuesta, p.solo_sin_contacto, p.etapas];
      if (p.id && ids.has(p.id)) {
        conservados.add(p.id);
        await cliente.query(
          `UPDATE crm_campana_pasos SET orden = $2, plantilla_id = $3, dias_despues = $4, hora = $5, vigencia_dias = $6,
                  solo_sin_respuesta = $7, solo_sin_contacto = $8, etapas = $9 WHERE id = $1`,
          [p.id, ...valores],
        );
      } else {
        await cliente.query(
          `INSERT INTO crm_campana_pasos (config_id, orden, plantilla_id, dias_despues, hora, vigencia_dias, solo_sin_respuesta, solo_sin_contacto, etapas)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [configId, ...valores],
        );
      }
    }
    const aBorrar = [...ids].filter((id) => !conservados.has(id));
    if (aBorrar.length > 0) await cliente.query(`DELETE FROM crm_campana_pasos WHERE id = ANY($1::uuid[])`, [aBorrar]);

    // Lo pendiente se reprograma con las reglas nuevas (el planificador lo vuelve a crear).
    await cliente.query(`DELETE FROM crm_envios WHERE estado = 'pendiente' AND paso_id IN (SELECT id FROM crm_campana_pasos WHERE config_id = $1)`, [configId]);

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
   Vista previa y registro
   ============================================================ */

const SQL_TEL_VALIDO = `length(regexp_replace(coalesce(c.telefono, ''), '\\D', '', 'g')) >= 10`;

/**
 * Qué pasaría con la configuración guardada: a cuántas personas llegaría y cuándo, y por qué otras no.
 * No escribe nada. Sirve para revisar antes de encender una campaña.
 */
export async function vistaPrevia(sucursalId: string, campana: string) {
  const campanas = await leerCampanas(sucursalId);
  const cfg = campanas.find((c) => c.campana === campana);
  if (!cfg) return null;

  const conteos = `count(*)::int AS total,
            count(*) FILTER (WHERE c.whatsapp_baja)::int AS bajas,
            count(*) FILTER (WHERE NOT ${SQL_TEL_VALIDO} OR c.tiene_celular IS FALSE)::int AS sin_telefono,
            count(*) FILTER (WHERE ${SQL_TEL_VALIDO} AND c.tiene_celular IS NOT FALSE AND NOT c.whatsapp_baja)::int AS alcanzables`;
  const fuente = await leerFuente(getPool(), sucursalId);
  const { rows: grupos } =
    fuente === "web"
      ? await getPool().query(
          `SELECT w.inicio::text AS inicio, w.hora_envio::text AS hora_envio, ${conteos}
             FROM crm_campana_calculada w
             JOIN crm_oportunidades o ON o.id = w.oportunidad_id
             JOIN crm_contactos c ON c.id = o.contacto_id
            WHERE w.sucursal_id = $1 AND w.campana = $2 AND w.inicio IS NOT NULL AND o.estado = 'abierta'
            GROUP BY 1, 2 ORDER BY 1`,
          [sucursalId, campana],
        )
      : await getPool().query(
          `SELECT o.fecha_inicio_campana::text AS inicio, NULL::text AS hora_envio, ${conteos}
             FROM crm_oportunidades o JOIN crm_contactos c ON c.id = o.contacto_id
            WHERE o.sucursal_id = $1 AND o.campana = $2 AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta'
            GROUP BY 1 ORDER BY 1`,
          [sucursalId, campana],
        );

  const suma = (k: "total" | "bajas" | "sin_telefono" | "alcanzables") => grupos.reduce((n, g) => n + (g[k] as number), 0);
  const ventana: Ventana = { dias_semana: cfg.dias_semana, hora_inicio: cfg.hora_inicio, hora_fin: cfg.hora_fin };
  const ahoraMs = Date.now();

  const pasos = cfg.pasos.map((p, i) => {
    const fechas = new Map<string, { fecha: string; hora: string; oportunidades: number; vigente: boolean }>();
    for (const g of grupos) {
      const prog = calcularProgramacion(g.inicio as string, p.dias_despues, horaDelPaso(p.hora, hhmm(g.hora_envio as string | null)), ventana);
      const programadoMs = Date.parse(`${prog.fecha}T${prog.hora}:00-07:00`);
      const vigente = ahoraMs <= programadoMs + p.vigencia_dias * 86_400_000;
      const k = `${prog.fecha} ${prog.hora}`;
      const previo = fechas.get(k);
      fechas.set(k, { fecha: prog.fecha, hora: prog.hora, oportunidades: (previo?.oportunidades ?? 0) + (g.total as number), vigente });
    }
    return { orden: i + 1, plantilla_id: p.plantilla_id, programacion: [...fechas.values()].sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora)) };
  });

  return {
    oportunidades: suma("total"),
    bajas: suma("bajas"),
    sin_telefono: suma("sin_telefono"),
    alcanzables: suma("alcanzables"),
    pasos,
  };
}

/** Resumen y últimos movimientos de los envíos (de una campaña o de todas). */
export async function registroEnvios(sucursalId: string, campana: string | null) {
  const pool = getPool();
  const filtro = campana ? " AND e.campana = $2" : "";
  const args = campana ? [sucursalId, campana] : [sucursalId];

  const [porEstado, porMotivo, recientes] = await Promise.all([
    pool.query(
      `SELECT e.estado, count(*)::int AS n FROM crm_envios e
        WHERE e.sucursal_id = $1${filtro} AND e.creado_en > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`,
      args,
    ),
    pool.query(
      `SELECT coalesce(e.motivo, '—') AS motivo, e.estado, count(*)::int AS n FROM crm_envios e
        WHERE e.sucursal_id = $1${filtro} AND e.estado IN ('omitido', 'pendiente', 'fallido') AND e.motivo IS NOT NULL
          AND e.creado_en > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 3 DESC`,
      args,
    ),
    pool.query(
      `SELECT e.id, e.campana, e.estado, e.motivo, e.programado_para, e.enviado_en, e.error, p.orden, c.nombre AS cliente, pl.nombre AS plantilla
         FROM crm_envios e
         JOIN crm_campana_pasos p ON p.id = e.paso_id
         JOIN crm_oportunidades o ON o.id = e.oportunidad_id
         JOIN crm_contactos c ON c.id = o.contacto_id
         LEFT JOIN whatsapp_plantillas pl ON pl.id = e.plantilla_id
        WHERE e.sucursal_id = $1${filtro}
        ORDER BY e.actualizado_en DESC LIMIT 50`,
      args,
    ),
  ]);
  return { por_estado: porEstado.rows, por_motivo: porMotivo.rows, recientes: recientes.rows };
}

/* ============================================================
   Planificador
   ============================================================ */

/** Crea la fila de cada paso que aún no existe para las oportunidades de campañas encendidas. */
export async function planificarEnvios(): Promise<number> {
  const pool = getPool();
  // Cada sucursal usa UNA fuente de campañas: la que manda BigQuery (por omisión) o la que calcula la web.
  const { rows: deBigQuery } = await pool.query(
    `SELECT cfg.sucursal_id, cfg.campana, cfg.dias_semana, cfg.hora_inicio::text AS hora_inicio, cfg.hora_fin::text AS hora_fin,
            p.id AS paso_id, p.plantilla_id, p.dias_despues, p.hora::text AS hora,
            o.id AS oportunidad_id, o.fecha_inicio_campana::text AS inicio, NULL::text AS hora_envio
       FROM crm_campanas_envio cfg
       LEFT JOIN crm_config cc ON cc.sucursal_id = cfg.sucursal_id
       JOIN crm_campana_pasos p ON p.config_id = cfg.id AND p.plantilla_id IS NOT NULL
       JOIN crm_oportunidades o ON o.sucursal_id = cfg.sucursal_id AND o.campana = cfg.campana
                               AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta' AND o.fecha_inicio_campana IS NOT NULL
      WHERE cfg.activa AND coalesce(cc.campanas_fuente, 'bigquery') = 'bigquery'
        AND NOT EXISTS (SELECT 1 FROM crm_envios e WHERE e.oportunidad_id = o.id AND e.paso_id = p.id)
      LIMIT 3000`,
  );
  const { rows: deLaWeb } = await pool.query(
    `SELECT cfg.sucursal_id, cfg.campana, cfg.dias_semana, cfg.hora_inicio::text AS hora_inicio, cfg.hora_fin::text AS hora_fin,
            p.id AS paso_id, p.plantilla_id, p.dias_despues, p.hora::text AS hora,
            o.id AS oportunidad_id, w.inicio::text AS inicio, w.hora_envio::text AS hora_envio
       FROM crm_campanas_envio cfg
       JOIN crm_config cc ON cc.sucursal_id = cfg.sucursal_id AND cc.campanas_fuente = 'web'
       JOIN crm_campana_pasos p ON p.config_id = cfg.id AND p.plantilla_id IS NOT NULL
       JOIN crm_campana_calculada w ON w.sucursal_id = cfg.sucursal_id AND w.campana = cfg.campana AND w.inicio IS NOT NULL
       JOIN crm_oportunidades o ON o.id = w.oportunidad_id AND o.estado = 'abierta'
      WHERE cfg.activa
        AND NOT EXISTS (SELECT 1 FROM crm_envios e WHERE e.oportunidad_id = o.id AND e.paso_id = p.id)
      LIMIT 3000`,
  );
  const rows = [...deBigQuery, ...deLaWeb];
  if (rows.length === 0) return 0;

  const lote = rows.map((r) => {
    const ventana: Ventana = { dias_semana: r.dias_semana, hora_inicio: r.hora_inicio, hora_fin: r.hora_fin };
    const prog = calcularProgramacion(r.inicio, r.dias_despues, horaDelPaso(hhmm(r.hora), hhmm(r.hora_envio)), ventana);
    return {
      sucursal_id: r.sucursal_id,
      oportunidad_id: r.oportunidad_id,
      paso_id: r.paso_id,
      campana: r.campana,
      plantilla_id: r.plantilla_id,
      inicio: r.inicio,
      local: `${prog.fecha} ${prog.hora}:00`,
    };
  });

  const { rowCount } = await pool.query(
    `INSERT INTO crm_envios (sucursal_id, oportunidad_id, paso_id, campana, plantilla_id, inicio, programado_para)
     SELECT r.sucursal_id, r.oportunidad_id, r.paso_id, r.campana, r.plantilla_id, r.inicio::date, (r.local::timestamp AT TIME ZONE '${ZONA_ENVIOS}')
       FROM jsonb_to_recordset($1::jsonb) AS r(sucursal_id uuid, oportunidad_id uuid, paso_id uuid, campana text, plantilla_id uuid, inicio text, local text)
     ON CONFLICT (oportunidad_id, paso_id) DO NOTHING`,
    [JSON.stringify(lote)],
  );
  return rowCount ?? 0;
}

/* ============================================================
   Despachador
   ============================================================ */

type FilaContexto = {
  activa: boolean;
  modo: "simulacion" | "real";
  dias_semana: number[];
  hora_inicio: string;
  hora_fin: string;
  max_por_dia: number;
  dias_entre_mensajes: number;
  vigencia_dias: number;
  solo_sin_respuesta: boolean;
  solo_sin_contacto: boolean;
  etapas: string[];
  campana: string | null;
  estado_cartera: string;
  estado: string;
  inicio: string;
  ejecutivo: string | null;
  etapa: string | null;
  contacto_id: string;
  cliente: string | null;
  telefono: string | null;
  tiene_celular: boolean | null;
  whatsapp_baja: boolean;
  plantilla_estado: string | null;
  nombre_tecnico: string | null;
  idioma: string | null;
  componentes: { header: { tipo: string } | null; body: { texto: string } } | null;
  plantilla_nombre: string | null;
};

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

const dd = (v: unknown): string => {
  const s = String(v ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};

/** Lo que cada paso necesita saber del momento y de la persona para decidir. */
async function armarContexto(cl: Consulta, e: { id: string; sucursal_id: string; oportunidad_id: string; campana: string; programado_para: Date; motivo: string | null }, whatsappListo: boolean) {
  const { rows } = await cl.query(
    `SELECT cfg.activa, cfg.modo, cfg.dias_semana, cfg.hora_inicio::text AS hora_inicio, cfg.hora_fin::text AS hora_fin, cfg.max_por_dia, cfg.dias_entre_mensajes,
            p.vigencia_dias, p.solo_sin_respuesta, p.solo_sin_contacto, p.etapas,
            -- Con la web como fuente, la oportunidad «sigue en la campaña» mientras la web no la ponga en OTRA y siga
            -- sin garantía extendida: salir de la ventana de la campaña no corta la cadencia que ya empezó.
            CASE WHEN coalesce(cc.campanas_fuente, 'bigquery') = 'web'
                 THEN (CASE WHEN w.campana IS NULL OR w.campana = e.campana THEN e.campana ELSE w.campana END)
                 ELSE o.campana END AS campana,
            CASE WHEN coalesce(cc.campanas_fuente, 'bigquery') = 'web'
                 THEN (CASE WHEN coalesce(v.tiene_ge, false) THEN 'YA_TIENE_GE' ELSE 'ACTIVA' END)
                 ELSE o.estado_cartera END AS estado_cartera,
            o.estado, coalesce(e.inicio, o.fecha_inicio_campana)::text AS inicio, o.ejecutivo, et.nombre AS etapa,
            c.id AS contacto_id, c.nombre AS cliente, c.telefono, c.tiene_celular, c.whatsapp_baja,
            wp.estado AS plantilla_estado, wp.nombre_tecnico, wp.idioma, wp.componentes, wp.nombre AS plantilla_nombre
       FROM crm_envios e
       JOIN crm_campana_pasos p ON p.id = e.paso_id
       JOIN crm_campanas_envio cfg ON cfg.id = p.config_id
       JOIN crm_oportunidades o ON o.id = e.oportunidad_id
       JOIN crm_contactos c ON c.id = o.contacto_id
       JOIN crm_vehiculos v ON v.id = o.vehiculo_id
       LEFT JOIN crm_config cc ON cc.sucursal_id = e.sucursal_id
       LEFT JOIN crm_campana_calculada w ON w.oportunidad_id = o.id
       LEFT JOIN crm_etapas et ON et.id = o.etapa_id
       LEFT JOIN whatsapp_plantillas wp ON wp.id = p.plantilla_id
      WHERE e.id = $1`,
    [e.id],
  );
  const f = rows[0] as FilaContexto | undefined;
  if (!f) return null;

  const tel = telefono10(f.telefono);
  const ahora = ahoraLocal();

  const [resp, contactado, reciente, hoy] = await Promise.all([
    tel
      ? cl.query(
          `SELECT EXISTS (SELECT 1 FROM whatsapp_mensajes m JOIN whatsapp_conversaciones cv ON cv.id = m.conversacion_id
                           WHERE cv.sucursal_id = $1 AND right(regexp_replace(cv.wa_id, '\\D', '', 'g'), 10) = $2
                             AND m.direccion = 'entrante' AND m.creado_en >= $3::date) AS v`,
          [e.sucursal_id, tel, f.inicio],
        )
      : Promise.resolve({ rows: [{ v: false }], rowCount: 1 }),
    cl.query(
      `SELECT EXISTS (SELECT 1 FROM crm_actividades a WHERE a.oportunidad_id = $1 AND a.tipo IN ('llamada', 'whatsapp')
                       AND a.detalle->>'resultado' = 'contesto' AND a.creado_en >= $2::date) AS v`,
      [e.oportunidad_id, f.inicio],
    ),
    f.dias_entre_mensajes > 0
      ? cl.query(
          `SELECT EXISTS (SELECT 1 FROM crm_envios e2 JOIN crm_oportunidades o2 ON o2.id = e2.oportunidad_id
                           WHERE o2.contacto_id = $1 AND e2.campana <> $2 AND e2.estado IN ('enviado', 'entregado', 'leido')
                             AND e2.enviado_en > now() - make_interval(days => $3::int)) AS v`,
          [f.contacto_id, e.campana, f.dias_entre_mensajes],
        )
      : Promise.resolve({ rows: [{ v: false }], rowCount: 1 }),
    cl.query(
      `SELECT count(*)::int AS n FROM crm_envios e3
        WHERE e3.sucursal_id = $1 AND e3.campana = $2 AND e3.estado IN ('enviado', 'entregado', 'leido', 'simulado')
          AND (e3.enviado_en AT TIME ZONE '${ZONA_ENVIOS}')::date = $3::date`,
      [e.sucursal_id, e.campana, ahora.fecha],
    ),
  ]);

  const ventana: Ventana = { dias_semana: f.dias_semana, hora_inicio: f.hora_inicio, hora_fin: f.hora_fin };
  const plantillaOk = f.plantilla_estado === "aprobada" && !!f.componentes && (!f.componentes.header || f.componentes.header.tipo === "texto");

  const ctx: ContextoEnvio = {
    ahora,
    ahoraMs: Date.now(),
    programadoMs: new Date(e.programado_para).getTime(),
    motivoPrevio: e.motivo,
    vigenciaDias: f.vigencia_dias,
    configActiva: f.activa,
    ventana,
    maxPorDia: f.max_por_dia,
    enviadosHoy: hoy.rows[0].n as number,
    oportunidad: { campana: f.campana, campanaEsperada: e.campana, estadoCartera: f.estado_cartera, estado: f.estado, etapa: f.etapa },
    contacto: { baja: f.whatsapp_baja, telefono10: tel, tieneCelular: f.tiene_celular },
    paso: { etapas: f.etapas ?? [], soloSinRespuesta: f.solo_sin_respuesta, soloSinContacto: f.solo_sin_contacto },
    respondio: resp.rows[0].v === true,
    yaContactado: contactado.rows[0].v === true,
    enviadoRecienteOtraCampana: reciente.rows[0].v === true,
    whatsappListo,
    plantillaDisponible: plantillaOk,
  };
  return { f, ctx, ventana, tel };
}

/** Pasa la plantilla por las variables de la oportunidad y la manda; deja el mensaje en el chat. */
async function enviarPlantilla(
  cl: Consulta,
  e: { sucursal_id: string; oportunidad_id: string; paso_id: string; campana: string },
  f: FilaContexto,
  tel: string,
): Promise<{ waMessageId: string; texto: string; conversacionId: string }> {
  const config = await configPorSucursalId(e.sucursal_id);
  if (!config || !config.activo) throw new Error("WhatsApp no está configurado para esta sucursal.");

  const cuerpo = f.componentes!.body.texto;
  const indices = [...new Set([...cuerpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

  let parametros: string[] = [];
  if (indices.length > 0) {
    const { rows: mapeos } = await cl.query(
      `SELECT v.indice, v.columna_tecnica FROM whatsapp_plantilla_variables v
         JOIN crm_campana_pasos p ON p.plantilla_id = v.plantilla_id WHERE p.id = $1`,
      [e.paso_id],
    );
    const { rows: filas } = await cl.query(`SELECT to_jsonb(v) AS f FROM crm_v_oportunidades v WHERE v.id = $1`, [e.oportunidad_id]);
    const fila = (filas[0]?.f ?? {}) as Record<string, unknown>;
    parametros = indices.map((i) => {
      const columna = mapeos.find((m) => m.indice === i)?.columna_tecnica as string | undefined;
      const valor = columna ? fila[columna] : null;
      return valor === null || valor === undefined ? "" : dd(valor);
    });
  }
  let n = 0;
  const texto = cuerpo.replace(/\{\{\d+\}\}/g, () => parametros[n++] ?? "");

  // Conversación existente del teléfono (se conserva su wa_id) o una nueva.
  const { rows: conv } = await cl.query(
    `SELECT id, wa_id FROM whatsapp_conversaciones
      WHERE sucursal_id = $1 AND right(regexp_replace(wa_id, '\\D', '', 'g'), 10) = $2 ORDER BY ultimo_mensaje_en DESC NULLS LAST LIMIT 1`,
    [e.sucursal_id, tel],
  );
  let conversacionId: string;
  let waId: string;
  if (conv[0]) {
    conversacionId = conv[0].id as string;
    waId = conv[0].wa_id as string;
  } else {
    waId = `52${tel}`;
    const nueva = await cl.query(
      `INSERT INTO whatsapp_conversaciones (sucursal_id, wa_id, nombre_contacto, asignado_a, no_leidos) VALUES ($1, $2, $3, $4, 0) RETURNING id`,
      [e.sucursal_id, waId, f.cliente, f.ejecutivo],
    );
    conversacionId = nueva.rows[0].id as string;
  }

  const enviado = await enviarMensaje(config, waId, { tipo: "plantilla", nombreTecnico: f.nombre_tecnico!, idioma: f.idioma!, parametrosBody: parametros });
  return { waMessageId: enviado.id, texto, conversacionId };
}

/** Deja el mensaje en el chat y la marca en el historial. Si falla no deshace el envío (ya salió). */
async function registrarEnChat(
  cl: Consulta,
  e: { sucursal_id: string; oportunidad_id: string; campana: string },
  conversacionId: string,
  waMessageId: string,
  texto: string,
  plantilla: string | null,
) {
  try {
    await cl.query(
      `INSERT INTO whatsapp_mensajes (conversacion_id, sucursal_id, wa_message_id, direccion, tipo, texto, estado)
       VALUES ($1, $2, $3, 'saliente', 'texto', $4, 'enviado')`,
      [conversacionId, e.sucursal_id, waMessageId, texto],
    );
    await cl.query(
      `UPDATE whatsapp_conversaciones SET ultimo_mensaje_en = now(), ultimo_mensaje_tipo = 'texto', ultimo_mensaje_texto = $2,
              ultimo_mensaje_direccion = 'saliente', ultimo_mensaje_wa_message_id = $3, ultimo_mensaje_estado = 'enviado'
        WHERE id = $1`,
      [conversacionId, texto, waMessageId],
    );
    await cl.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle) VALUES ($1, $2, 'envio_campana', $3, $4)`,
      [e.sucursal_id, e.oportunidad_id, `Campaña ${e.campana}: mensaje enviado`, { campana: e.campana, plantilla }],
    );
    emitirEventoChat(e.sucursal_id, { tipo: "mensaje_saliente", conversacionId });
  } catch {
    console.error("[campanas] el mensaje salió pero no se pudo dejar en el chat");
  }
}

const MAX_INTENTOS_ENVIO = 3;

/** Toma el envío más antiguo que ya le toca, decide qué hacer y lo ejecuta. Devuelve false si no hay nada. */
async function procesarUnEnvio(listos: Map<string, boolean>): Promise<boolean> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `SELECT id, sucursal_id, oportunidad_id, paso_id, campana, programado_para, motivo, intentos FROM crm_envios
        WHERE estado = 'pendiente' AND programado_para <= now() ORDER BY programado_para LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const e = rows[0];
    if (!e) {
      await cliente.query("ROLLBACK");
      return false;
    }

    if (!listos.has(e.sucursal_id)) {
      const cfg = await configPorSucursalId(e.sucursal_id as string).catch(() => null);
      listos.set(e.sucursal_id, Boolean(cfg && cfg.activo));
    }
    const armado = await armarContexto(cliente, e, listos.get(e.sucursal_id) === true);
    if (!armado) {
      await cliente.query(`UPDATE crm_envios SET estado = 'omitido', motivo = 'ya_no_aplica' WHERE id = $1`, [e.id]);
      await cliente.query("COMMIT");
      return true;
    }
    const { f, ctx, ventana, tel } = armado;
    const decision: Decision = decidirEnvio(ctx);

    if (decision.accion === "omitir") {
      await cliente.query(`UPDATE crm_envios SET estado = 'omitido', motivo = $2 WHERE id = $1`, [e.id, decision.motivo]);
    } else if (decision.accion === "posponer") {
      let local: { fecha: string; hora: string } | null = null;
      if (decision.hasta === "ventana") local = siguienteApertura(ctx.ahora, ventana);
      else if (decision.hasta === "dia_siguiente") local = siguienteApertura({ fecha: ctx.ahora.fecha, minutos: 24 * 60 }, ventana);
      if (local) {
        await cliente.query(
          `UPDATE crm_envios SET motivo = $2, programado_para = ($3::timestamp AT TIME ZONE '${ZONA_ENVIOS}') WHERE id = $1`,
          [e.id, decision.motivo, `${local.fecha} ${local.hora}:00`],
        );
      } else {
        const minutos = (decision.hasta as { minutos: number }).minutos;
        await cliente.query(`UPDATE crm_envios SET motivo = $2, programado_para = now() + make_interval(mins => $3::int) WHERE id = $1`, [e.id, decision.motivo, minutos]);
      }
    } else if (f.modo === "simulacion") {
      await cliente.query(`UPDATE crm_envios SET estado = 'simulado', motivo = NULL, enviado_en = now() WHERE id = $1`, [e.id]);
    } else {
      // Envío real. El estado se confirma ANTES de cualquier otra cosa: si algo falla después, no se repite el mensaje.
      try {
        const r = await enviarPlantilla(cliente, e, f, tel!);
        await cliente.query(
          `UPDATE crm_envios SET estado = 'enviado', motivo = NULL, wa_message_id = $2, enviado_en = now(), intentos = intentos + 1, error = NULL WHERE id = $1`,
          [e.id, r.waMessageId],
        );
        await cliente.query("COMMIT");
        await registrarEnChat(getPool(), e, r.conversacionId, r.waMessageId, r.texto, f.plantilla_nombre);
        return true;
      } catch (err) {
        const mensaje = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        const intentos = (e.intentos as number) + 1;
        if (intentos >= MAX_INTENTOS_ENVIO) {
          await cliente.query(`UPDATE crm_envios SET estado = 'fallido', intentos = $2, error = $3 WHERE id = $1`, [e.id, intentos, mensaje]);
        } else {
          await cliente.query(
            `UPDATE crm_envios SET intentos = $2, error = $3, motivo = 'reintento', programado_para = now() + interval '15 minutes' WHERE id = $1`,
            [e.id, intentos, mensaje],
          );
        }
      }
    }
    await cliente.query("COMMIT");
    return true;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Despacha lo que ya toca, con un presupuesto de tiempo y una pausa entre mensajes reales. */
export async function despacharEnvios(presupuestoMs = 45_000, maximo = 120): Promise<number> {
  const inicio = Date.now();
  const listos = new Map<string, boolean>();
  let hechos = 0;
  while (hechos < maximo && Date.now() - inicio < presupuestoMs) {
    let hubo: boolean;
    try {
      hubo = await procesarUnEnvio(listos);
    } catch {
      console.error("[campanas] error procesando un envío");
      break;
    }
    if (!hubo) break;
    hechos++;
    await new Promise((r) => setTimeout(r, 150));
  }
  return hechos;
}

/* ============================================================
   Estados de entrega y bajas
   ============================================================ */

const RANGO_SQL = `(CASE %s WHEN 'enviado' THEN 1 WHEN 'entregado' THEN 2 WHEN 'leido' THEN 3 WHEN 'fallido' THEN 4 ELSE 0 END)`;

/** Lo llama el webhook de Meta: pasa a entregado/leído/fallido el envío que corresponda, sin retroceder. */
export async function registrarEstadoEnvio(waMessageId: string, estado: "enviado" | "entregado" | "leido" | "fallido", error?: string | null): Promise<void> {
  await getPool().query(
    `UPDATE crm_envios SET estado = $2, error = coalesce($3, error)
      WHERE wa_message_id = $1 AND estado IN ('enviado', 'entregado', 'leido')
        AND ${RANGO_SQL.replace("%s", "estado")} < ${RANGO_SQL.replace("%s", "$2")}`,
    [waMessageId, estado, error ?? null],
  );
}

/**
 * El contacto pidió no recibir más: queda en baja (para siempre), se cancela lo que tenía pendiente y
 * sus oportunidades activas pasan a estado de contacto "Baja". Devuelve cuántos contactos tocó.
 */
export async function procesarBaja(sucursalId: string, tel: string): Promise<number> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `UPDATE crm_contactos SET whatsapp_baja = true, whatsapp_baja_en = now()
        WHERE sucursal_id = $1 AND right(regexp_replace(coalesce(telefono, ''), '\\D', '', 'g'), 10) = $2 RETURNING id`,
      [sucursalId, tel],
    );
    const ids = rows.map((r) => r.id as string);
    if (ids.length > 0) {
      await cliente.query(
        `UPDATE crm_envios e SET estado = 'omitido', motivo = 'baja' FROM crm_oportunidades o
          WHERE e.oportunidad_id = o.id AND o.contacto_id = ANY($1::uuid[]) AND e.estado = 'pendiente'`,
        [ids],
      );
      await cliente.query(
        `UPDATE crm_oportunidades SET estado_contacto = 'baja' WHERE contacto_id = ANY($1::uuid[]) AND estado_cartera = 'ACTIVA' AND estado = 'abierta'`,
        [ids],
      );
      await cliente.query(
        `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle)
         SELECT $1, o.id, 'baja', 'Pidió no recibir más mensajes', '{"canal":"whatsapp"}'::jsonb
           FROM crm_oportunidades o WHERE o.contacto_id = ANY($2::uuid[]) AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta'`,
        [sucursalId, ids],
      );
    }
    await cliente.query("COMMIT");
    return ids.length;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}
