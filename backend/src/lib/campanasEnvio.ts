import { getPool } from "./db.js";
import { configPorSucursalId, enviarMensaje, ErrorEnvioMeta } from "./whatsapp.js";
import { emitirEventoChat } from "./eventosChat.js";
import { diasTranscurridos, horaDelPaso } from "./campanasDefLogica.js";
import { leerDescripciones, leerFuente } from "./campanasDefinidas.js";
import {
  CAMPANAS_CONOCIDAS,
  ZONA_ENVIOS,
  ahoraLocal,
  calcularProgramacion,
  decidirEnvio,
  sanearParametro,
  siguienteApertura,
  telefono10,
  topeEfectivo,
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
  /** Activación gradual: agencias del piloto (vacío = todas) y rampa del tope diario. */
  piloto_agencias: string[];
  rampa_activa: boolean;
  rampa_inicial: number;
  rampa_incremento: number;
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
    `SELECT id, campana, activa, modo, dias_semana, hora_inicio::text AS hora_inicio, hora_fin::text AS hora_fin, max_por_dia, dias_entre_mensajes,
            piloto_agencias, rampa_activa, rampa_inicial, rampa_incremento
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
    piloto_agencias: c.piloto_agencias as string[],
    rampa_activa: c.rampa_activa as boolean,
    rampa_inicial: c.rampa_inicial as number,
    rampa_incremento: c.rampa_incremento as number,
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
    const { rows } = await cliente.query(`SELECT id, modo FROM crm_campanas_envio WHERE sucursal_id = $1 AND campana = $2 FOR UPDATE`, [sucursalId, campana]);
    if (!rows[0]) {
      await cliente.query("ROLLBACK");
      return { ok: false, error: "La campaña no existe." };
    }
    const configId = rows[0].id as string;
    const pasaAReal = rows[0].modo === "simulacion" && datos.modo === "real";

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
          SET activa = $2, modo = $3, dias_semana = $4, hora_inicio = $5, hora_fin = $6, max_por_dia = $7, dias_entre_mensajes = $8,
              piloto_agencias = $9, rampa_activa = $10, rampa_inicial = $11, rampa_incremento = $12
        WHERE id = $1`,
      [
        configId, datos.activa, datos.modo, datos.dias_semana, datos.hora_inicio, datos.hora_fin, datos.max_por_dia, datos.dias_entre_mensajes,
        datos.piloto_agencias, datos.rampa_activa, datos.rampa_inicial, datos.rampa_incremento,
      ],
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
    if (aBorrar.length > 0) {
      // Borrar un paso borra (en cascada) su registro de envíos, y sin registro el planificador volvería a mandar ese mensaje
      // si el paso se crea de nuevo. Un paso que ya habló con clientes de verdad no se quita.
      const { rows: conHistorial } = await cliente.query(
        `SELECT 1 FROM crm_envios WHERE paso_id = ANY($1::uuid[])
            AND (estado IN ('enviado', 'entregado', 'leido', 'fallido') OR (estado = 'pendiente' AND motivo = 'enviando')) LIMIT 1`,
        [aBorrar],
      );
      if (conHistorial[0]) {
        await cliente.query("ROLLBACK");
        return {
          ok: false,
          error: "Ese mensaje ya se mandó a clientes y no se puede quitar: se perdería su registro y podría repetirse. Si ya no quieres que salga, apaga la campaña.",
        };
      }
      await cliente.query(`DELETE FROM crm_campana_pasos WHERE id = ANY($1::uuid[])`, [aBorrar]);
    }

    // Lo pendiente se reprograma con las reglas nuevas (el planificador lo vuelve a crear). Lo que está saliendo en este
    // momento («enviando») no se toca: borrarlo dejaría el mensaje sin registro y se volvería a mandar.
    await cliente.query(
      `DELETE FROM crm_envios WHERE estado = 'pendiente' AND motivo IS DISTINCT FROM 'enviando'
          AND paso_id IN (SELECT id FROM crm_campana_pasos WHERE config_id = $1)`,
      [configId],
    );

    // Al pasar de simulación a real, lo simulado se descarta: cada envío es único por oportunidad y paso, así que un lead que
    // ya «recibió» la simulación nunca recibiría el mensaje de verdad. El planificador lo vuelve a crear (y si ya pasó su
    // vigencia, se omite y queda registrado). Lo mismo con sus seguimientos simulados.
    if (pasaAReal) {
      await cliente.query(
        `DELETE FROM crm_envios WHERE estado = 'simulado' AND paso_id IN (SELECT id FROM crm_campana_pasos WHERE config_id = $1)`,
        [configId],
      );
      await cliente.query(
        `DELETE FROM crm_seguimiento_ejecuciones x USING crm_seguimientos s
          WHERE x.seguimiento_id = s.id AND s.sucursal_id = $1 AND s.campana = $2 AND x.simulada`,
        [sucursalId, campana],
      );
    }

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

/** Las agencias que hay en la cartera, para elegir las del piloto. */
export async function listarAgencias(sucursalId: string): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT agencia FROM crm_vehiculos WHERE sucursal_id = $1 AND agencia IS NOT NULL AND btrim(agencia) <> '' ORDER BY 1`,
    [sucursalId],
  );
  return rows.map((r) => r.agencia as string);
}

export type Revision = { clave: string; ok: boolean; bloqueante: boolean; texto: string };

/**
 * Lista de verificación antes de encender una campaña de verdad. Lo «bloqueante» impediría que el mensaje salga o saldría mal;
 * lo demás son recomendaciones para una salida gradual (probar en simulación, empezar con un piloto y una rampa).
 */
export async function revisarActivacion(sucursalId: string, campana: string) {
  const campanas = await leerCampanas(sucursalId);
  const cfg = campanas.find((c) => c.campana === campana);
  if (!cfg) return null;
  const pool = getPool();
  const checks: Revision[] = [];

  const whatsapp = await configPorSucursalId(sucursalId).catch(() => null);
  checks.push({ clave: "whatsapp", ok: Boolean(whatsapp && whatsapp.activo), bloqueante: true, texto: "WhatsApp está configurado y activo en esta sucursal." });
  checks.push({ clave: "motor", ok: process.env.CRM_ENVIOS === "on", bloqueante: true, texto: "El servidor tiene encendido el envío automático (variable CRM_ENVIOS=on)." });

  const conPlantilla = cfg.pasos.filter((p) => p.plantilla_id);
  checks.push({ clave: "mensajes", ok: conPlantilla.length > 0 && conPlantilla.length === cfg.pasos.length, bloqueante: true, texto: "La campaña tiene al menos un mensaje y todos tienen plantilla." });

  const ids = [...new Set(conPlantilla.map((p) => p.plantilla_id as string))];
  const { rows: pls } = ids.length
    ? await pool.query(
        `SELECT p.id, p.estado, p.componentes->'body'->>'texto' AS cuerpo,
                (SELECT count(*)::int FROM whatsapp_plantilla_variables v WHERE v.plantilla_id = p.id) AS mapeadas
           FROM whatsapp_plantillas p WHERE p.sucursal_id = $1 AND p.id = ANY($2::uuid[])`,
        [sucursalId, ids],
      )
    : { rows: [] as { id: string; estado: string; cuerpo: string | null; mapeadas: number }[] };
  checks.push({ clave: "aprobadas", ok: ids.length > 0 && pls.length === ids.length && pls.every((p) => p.estado === "aprobada"), bloqueante: true, texto: "Todas las plantillas están aprobadas por Meta." });
  const sinMapear = pls.filter((p) => {
    const vars = new Set([...String(p.cuerpo ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
    return vars > (p.mapeadas as number);
  });
  checks.push({ clave: "variables", ok: ids.length > 0 && sinMapear.length === 0, bloqueante: true, texto: "Las variables de cada plantilla están ligadas a una columna de la base." });

  // Al pasar a real lo simulado se descarta: cuenta también lo que ya salió de verdad.
  const { rows: sim } = await pool.query(
    `SELECT count(*)::int AS n FROM crm_envios WHERE sucursal_id = $1 AND campana = $2 AND estado IN ('simulado', 'enviado', 'entregado', 'leido')`,
    [sucursalId, campana],
  );
  checks.push({ clave: "simulacion", ok: (sim[0]?.n as number) > 0, bloqueante: false, texto: "Ya la probaste en simulación y revisaste a quién le habría llegado." });
  checks.push({
    clave: "gradual",
    ok: cfg.piloto_agencias.length > 0 || cfg.rampa_activa,
    bloqueante: false,
    texto: "Tiene un piloto (agencias) o una rampa de tope diario para empezar poco a poco.",
  });

  const bloqueos = checks.filter((c) => c.bloqueante && !c.ok).length;
  const { rows: primero } = await pool.query(
    `SELECT min((enviado_en AT TIME ZONE '${ZONA_ENVIOS}')::date)::text AS d FROM crm_envios
      WHERE sucursal_id = $1 AND campana = $2 AND estado IN ('enviado', 'entregado', 'leido')`,
    [sucursalId, campana],
  );
  const primerReal = (primero[0]?.d as string | null) ?? null;
  return {
    checks,
    bloqueos,
    listo_para_real: bloqueos === 0,
    modo: cfg.activa ? cfg.modo : "apagada",
    tope_hoy: topeEfectivo({
      maxPorDia: cfg.max_por_dia,
      rampa: { activa: cfg.rampa_activa, inicial: cfg.rampa_inicial, incremento: cfg.rampa_incremento },
      diasDesdePrimerEnvio: primerReal ? diasTranscurridos(primerReal, ahoraLocal().fecha) : null,
    }),
    primer_envio_real: primerReal,
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
      `SELECT e.id, e.campana, e.estado, e.motivo, e.programado_para, e.enviado_en, e.error, p.orden, sg.nombre AS seguimiento, c.nombre AS cliente, pl.nombre AS plantilla
         FROM crm_envios e
         LEFT JOIN crm_campana_pasos p ON p.id = e.paso_id
         LEFT JOIN crm_seguimientos sg ON sg.id = e.seguimiento_id
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
     ON CONFLICT DO NOTHING`,
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
  piloto_agencias: string[];
  rampa_activa: boolean;
  rampa_inicial: number;
  rampa_incremento: number;
  agencia: string | null;
  vigencia_dias: number;
  solo_sin_respuesta: boolean;
  solo_sin_contacto: boolean;
  etapas: string[];
  plantilla_id: string | null;
  campana: string | null;
  estado_cartera: string;
  estado: string;
  resultado_bdc: string | null;
  estado_contacto: string;
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
            cfg.piloto_agencias, cfg.rampa_activa, cfg.rampa_inicial, cfg.rampa_incremento, v.agencia,
            -- Un envío viene de un paso de la campaña o de un seguimiento (que no tiene esas condiciones: usa las suyas).
            coalesce(p.vigencia_dias::float8, sg.vigencia_horas / 24.0) AS vigencia_dias,
            coalesce(p.solo_sin_respuesta, false) AS solo_sin_respuesta, coalesce(p.solo_sin_contacto, false) AS solo_sin_contacto,
            coalesce(p.etapas, '{}'::text[]) AS etapas, coalesce(p.plantilla_id, sg.plantilla_id) AS plantilla_id,
            -- Con la web como fuente, la oportunidad «sigue en la campaña» mientras la web no la ponga en OTRA y siga
            -- sin garantía extendida: salir de la ventana de la campaña no corta la cadencia que ya empezó.
            -- Un envío de seguimiento no depende de que el lead siga dentro de la ventana de la campaña.
            CASE WHEN e.seguimiento_id IS NOT NULL THEN e.campana
                 WHEN coalesce(cc.campanas_fuente, 'bigquery') = 'web'
                 THEN (CASE WHEN w.campana IS NULL OR w.campana = e.campana THEN e.campana ELSE w.campana END)
                 ELSE o.campana END AS campana,
            -- Un vehículo excluido por las etapas (ya no puede contratar) deja de recibir mensajes con CUALQUIER fuente de campañas.
            CASE WHEN v.etapa_vehiculo_motivo IN ('excluido_km', 'excluido_fecha') THEN 'EXCLUIDO_ETAPA'
                 WHEN e.seguimiento_id IS NOT NULL OR coalesce(cc.campanas_fuente, 'bigquery') = 'web'
                 THEN (CASE WHEN coalesce(v.tiene_ge, false) THEN 'YA_TIENE_GE' ELSE 'ACTIVA' END)
                 ELSE o.estado_cartera END AS estado_cartera,
            o.estado, o.estado_contacto, o.resultado_bdc, coalesce(e.inicio, o.fecha_inicio_campana)::text AS inicio, o.ejecutivo, et.nombre AS etapa,
            c.id AS contacto_id, c.nombre AS cliente, c.telefono, c.tiene_celular, c.whatsapp_baja,
            wp.estado AS plantilla_estado, wp.nombre_tecnico, wp.idioma, wp.componentes, wp.nombre AS plantilla_nombre
       FROM crm_envios e
       LEFT JOIN crm_campana_pasos p ON p.id = e.paso_id
       LEFT JOIN crm_seguimientos sg ON sg.id = e.seguimiento_id
       JOIN crm_campanas_envio cfg ON cfg.sucursal_id = e.sucursal_id AND cfg.campana = e.campana
       JOIN crm_oportunidades o ON o.id = e.oportunidad_id
       JOIN crm_contactos c ON c.id = o.contacto_id
       JOIN crm_vehiculos v ON v.id = o.vehiculo_id
       LEFT JOIN crm_config cc ON cc.sucursal_id = e.sucursal_id
       LEFT JOIN crm_campana_calculada w ON w.oportunidad_id = o.id
       LEFT JOIN crm_etapas et ON et.id = o.etapa_id
       LEFT JOIN whatsapp_plantillas wp ON wp.id = coalesce(p.plantilla_id, sg.plantilla_id)
      WHERE e.id = $1`,
    [e.id],
  );
  const f = rows[0] as FilaContexto | undefined;
  if (!f) return null;

  const tel = telefono10(f.telefono);
  const ahora = ahoraLocal();

  // Todas estas consultas van por la MISMA conexión (la de la transacción del envío): se hacen una tras otra.
  const resp = tel
    ? await cl.query(
        `SELECT EXISTS (SELECT 1 FROM whatsapp_mensajes m JOIN whatsapp_conversaciones cv ON cv.id = m.conversacion_id
                         WHERE cv.sucursal_id = $1 AND right(regexp_replace(cv.wa_id, '\\D', '', 'g'), 10) = $2
                           AND m.direccion = 'entrante' AND m.creado_en >= $3::date) AS v`,
        [e.sucursal_id, tel, f.inicio],
      )
    : { rows: [{ v: false }], rowCount: 1 };
  const contactado = await cl.query(
    `SELECT EXISTS (SELECT 1 FROM crm_actividades a WHERE a.oportunidad_id = $1 AND a.tipo IN ('llamada', 'whatsapp')
                     AND a.detalle->>'resultado' = 'contesto' AND a.creado_en >= $2::date) AS v`,
    [e.oportunidad_id, f.inicio],
  );
  const reciente =
    f.dias_entre_mensajes > 0
      ? await cl.query(
          `SELECT EXISTS (SELECT 1 FROM crm_envios e2 JOIN crm_oportunidades o2 ON o2.id = e2.oportunidad_id
                           WHERE o2.contacto_id = $1 AND e2.campana <> $2 AND e2.estado IN ('enviado', 'entregado', 'leido')
                             AND e2.enviado_en > now() - make_interval(days => $3::int)) AS v`,
          [f.contacto_id, e.campana, f.dias_entre_mensajes],
        )
      : { rows: [{ v: false }], rowCount: 1 };
  // Ese teléfono ya recibió (o en simulación, «recibió») un mensaje hoy, de cualquier campaña y de cualquiera de sus autos.
  const telefonoHoy = await cl.query(
    `SELECT EXISTS (SELECT 1 FROM crm_envios e4 JOIN crm_oportunidades o4 ON o4.id = e4.oportunidad_id
                     WHERE o4.contacto_id = $1 AND e4.id <> $2 AND e4.estado IN ('enviado', 'entregado', 'leido', 'simulado')
                       AND (e4.enviado_en AT TIME ZONE '${ZONA_ENVIOS}')::date = $3::date) AS v`,
    [f.contacto_id, e.id, ahora.fecha],
  );
  const hoy = await cl.query(
    `SELECT count(*)::int AS n FROM crm_envios e3
      WHERE e3.sucursal_id = $1 AND e3.campana = $2 AND e3.estado IN ('enviado', 'entregado', 'leido', 'simulado')
        AND (e3.enviado_en AT TIME ZONE '${ZONA_ENVIOS}')::date = $3::date`,
    [e.sucursal_id, e.campana, ahora.fecha],
  );
  // La rampa del tope diario cuenta desde el primer envío REAL (la simulación no la hace avanzar).
  const primero = f.rampa_activa
    ? await cl.query(
        `SELECT min((enviado_en AT TIME ZONE '${ZONA_ENVIOS}')::date)::text AS d FROM crm_envios
          WHERE sucursal_id = $1 AND campana = $2 AND estado IN ('enviado', 'entregado', 'leido')`,
        [e.sucursal_id, e.campana],
      )
    : { rows: [{ d: null }], rowCount: 1 };
  const primerReal = (primero.rows[0]?.d as string | null) ?? null;

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
    maxPorDia: topeEfectivo({
      maxPorDia: f.max_por_dia,
      rampa: { activa: f.rampa_activa, inicial: f.rampa_inicial, incremento: f.rampa_incremento },
      diasDesdePrimerEnvio: primerReal ? diasTranscurridos(primerReal, ahora.fecha) : null,
    }),
    enviadosHoy: hoy.rows[0].n as number,
    oportunidad: {
      campana: f.campana,
      campanaEsperada: e.campana,
      estadoCartera: f.estado_cartera,
      estado: f.estado,
      etapa: f.etapa,
      agencia: f.agencia,
      estadoContacto: f.estado_contacto,
    },
    pilotoAgencias: f.piloto_agencias ?? [],
    contacto: { baja: f.whatsapp_baja, telefono10: tel, tieneCelular: f.tiene_celular },
    paso: { etapas: f.etapas ?? [], soloSinRespuesta: f.solo_sin_respuesta, soloSinContacto: f.solo_sin_contacto },
    respondio: resp.rows[0].v === true,
    yaContactado: contactado.rows[0].v === true,
    resultadoBdc: f.resultado_bdc,
    enviadoRecienteOtraCampana: reciente.rows[0].v === true,
    telefonoConMensajeHoy: telefonoHoy.rows[0].v === true,
    whatsappListo,
    plantillaDisponible: plantillaOk,
  };
  return { f, ctx, ventana, tel };
}

type ParametrosPlantilla = { parametros: string[]; texto: string; /** Alguna variable quedó sin valor: el mensaje saldría a medias. */ incompleto: boolean };

/**
 * Los valores de las variables de la plantilla para esta oportunidad. Se usa también en la simulación, para que ahí se vea
 * a quién le faltaría un dato (por ejemplo, un vehículo sin agencia) en lugar de descubrirlo al enviar de verdad.
 */
async function armarParametros(cl: Consulta, e: { oportunidad_id: string }, f: FilaContexto): Promise<ParametrosPlantilla> {
  const cuerpo = f.componentes!.body.texto;
  const indices = [...new Set([...cuerpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

  let parametros: string[] = [];
  if (indices.length > 0) {
    const { rows: mapeos } = await cl.query(`SELECT v.indice, v.columna_tecnica FROM whatsapp_plantilla_variables v WHERE v.plantilla_id = $1`, [f.plantilla_id]);
    const { rows: filas } = await cl.query(`SELECT to_jsonb(v) AS f FROM crm_v_oportunidades v WHERE v.id = $1`, [e.oportunidad_id]);
    const fila = (filas[0]?.f ?? {}) as Record<string, unknown>;
    parametros = indices.map((i) => {
      const columna = mapeos.find((m) => m.indice === i)?.columna_tecnica as string | undefined;
      const valor = columna ? fila[columna] : null;
      return valor === null || valor === undefined ? "" : sanearParametro(dd(valor));
    });
  }
  let n = 0;
  const texto = cuerpo.replace(/\{\{\d+\}\}/g, () => parametros[n++] ?? "");
  return { parametros, texto, incompleto: parametros.some((p) => p === "") };
}

/** Manda la plantilla (ya con sus variables) por WhatsApp. El mensaje se deja en el chat después, con registrarEnChat. */
async function enviarPlantilla(
  cl: Consulta,
  e: { sucursal_id: string; oportunidad_id: string; campana: string },
  f: FilaContexto,
  tel: string,
  p: ParametrosPlantilla,
): Promise<{ waMessageId: string; texto: string; conversacionId: string }> {
  const config = await configPorSucursalId(e.sucursal_id);
  if (!config || !config.activo) throw new Error("WhatsApp no está configurado para esta sucursal.");
  const { parametros, texto } = p;

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

    // Quedó «enviando» de un intento anterior que no terminó (el proceso se cayó a medias): no se sabe si salió, así que NO
    // se reenvía.
    if (e.motivo === "enviando") {
      await cliente.query(
        `UPDATE crm_envios SET estado = 'fallido', error = 'Se interrumpió durante el envío; no se reintenta para no mandar el mensaje dos veces.' WHERE id = $1`,
        [e.id],
      );
      await cliente.query("COMMIT");
      return true;
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

    // Los datos de la plantilla se arman ANTES de enviar o simular: si falta alguno, el mensaje no sale a medias.
    let parametros: ParametrosPlantilla | null = null;
    if (decision.accion === "enviar") {
      parametros = await armarParametros(cliente, e, f);
      if (parametros.incompleto) {
        await cliente.query(`UPDATE crm_envios SET estado = 'omitido', motivo = 'variable_vacia' WHERE id = $1`, [e.id]);
        await cliente.query("COMMIT");
        return true;
      }
    }

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
      // Envío real, «a lo sumo una vez». Antes de hablar con Meta se deja DURABLE la marca «enviando» (y el envío sale de la
      // cola por una hora): si el proceso muere o la confirmación falla después de que Meta aceptó el mensaje, jamás se
      // reenvía solo; al encontrarlo así, se da por fallido y se avisa. Es preferible perder un mensaje a mandarlo dos veces.
      await cliente.query(`UPDATE crm_envios SET motivo = 'enviando', programado_para = now() + interval '1 hour' WHERE id = $1`, [e.id]);
      await cliente.query("COMMIT");
      let r: Awaited<ReturnType<typeof enviarPlantilla>>;
      try {
        r = await enviarPlantilla(cliente, e, f, tel!, parametros!);
      } catch (err) {
        const mensaje = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        const intentos = (e.intentos as number) + 1;
        // Un rechazo definitivo de Meta, o no saber si salió, no se reintenta.
        const resultado = err instanceof ErrorEnvioMeta ? err.resultado : "reintentar";
        if (resultado === "incierto") {
          await cliente.query(`UPDATE crm_envios SET estado = 'fallido', intentos = $2, error = $3 WHERE id = $1`, [
            e.id,
            intentos,
            `${mensaje} No se confirmó el envío; no se reintenta para no mandar el mensaje dos veces.`.slice(0, 300),
          ]);
        } else if (resultado === "definitivo" || intentos >= MAX_INTENTOS_ENVIO) {
          await cliente.query(`UPDATE crm_envios SET estado = 'fallido', intentos = $2, error = $3 WHERE id = $1`, [e.id, intentos, mensaje]);
        } else {
          await cliente.query(
            `UPDATE crm_envios SET intentos = $2, error = $3, motivo = 'reintento', programado_para = now() + interval '15 minutes' WHERE id = $1`,
            [e.id, intentos, mensaje],
          );
        }
        return true;
      }
      // Meta ya aceptó el mensaje: desde aquí ningún error puede llevar a un reintento. Si no se logra anotar «enviado», la fila
      // se queda con la marca «enviando» y el despachador la cierra como fallida sin reenviarla.
      try {
        await getPool().query(
          `UPDATE crm_envios SET estado = 'enviado', motivo = NULL, wa_message_id = $2, enviado_en = now(), intentos = intentos + 1, error = NULL WHERE id = $1`,
          [e.id, r.waMessageId],
        );
      } catch {
        console.error("[campanas] el mensaje salió pero no se pudo anotar como enviado; queda marcado «enviando» y no se reenvía");
        return true;
      }
      await registrarEnChat(getPool(), e, r.conversacionId, r.waMessageId, r.texto, f.plantilla_nombre);
      return true;
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
 * El cliente tocó «Ahora no» (o lo escribió). NO es una baja: deja de recibir lo que falta de la campaña que le escribió
 * (mensajes y seguimientos, incluidas las tareas y llamadas aún pendientes) y vuelve a contactarse en la siguiente campaña,
 * que es otra oportunidad (por ejemplo, de 48H pasa a 5M). La campaña es la del último mensaje real que recibió (30 días).
 *
 * Para que el planificador no vuelva a crear lo que falta, los pasos y seguimientos de esa campaña quedan registrados como
 * omitidos «ahora_no» (cada envío y cada seguimiento son únicos por oportunidad). Devuelve la campaña, o null si no aplica.
 */
export async function procesarAhoraNo(sucursalId: string, tel: string): Promise<{ campana: string; oportunidadId: string } | null> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `SELECT e.oportunidad_id, e.campana, e.inicio FROM crm_envios e
         JOIN crm_oportunidades o ON o.id = e.oportunidad_id
         JOIN crm_contactos c ON c.id = o.contacto_id
        WHERE e.sucursal_id = $1 AND right(regexp_replace(coalesce(c.telefono, ''), '\\D', '', 'g'), 10) = $2
          AND e.estado IN ('enviado', 'entregado', 'leido') AND e.enviado_en > now() - interval '30 days'
        ORDER BY e.enviado_en DESC LIMIT 1`,
      [sucursalId, tel],
    );
    const ultimo = rows[0];
    if (!ultimo) {
      await cliente.query("ROLLBACK");
      return null;
    }
    const opp = ultimo.oportunidad_id as string;
    const campana = ultimo.campana as string;

    // Lo pendiente de esa campaña se cancela (lo que está saliendo en este momento no se toca).
    await cliente.query(
      `UPDATE crm_envios SET estado = 'omitido', motivo = 'ahora_no'
        WHERE oportunidad_id = $1 AND campana = $2 AND estado = 'pendiente' AND motivo IS DISTINCT FROM 'enviando'`,
      [opp, campana],
    );
    // Los pasos que aún no se planificaban quedan cerrados para que no se creen después.
    await cliente.query(
      `INSERT INTO crm_envios (sucursal_id, oportunidad_id, paso_id, campana, campana_id, plantilla_id, inicio, programado_para, estado, motivo)
       SELECT $1, $2, p.id, $3,
              -- El paso de campaña del lead en esa campaña (aunque ya haya pasado a otra).
              (SELECT oc.id FROM crm_oportunidad_campanas oc WHERE oc.oportunidad_id = $2 AND oc.campana = $3 ORDER BY oc.abierta_en DESC LIMIT 1),
              p.plantilla_id, $4::date, now(), 'omitido', 'ahora_no'
         FROM crm_campana_pasos p JOIN crm_campanas_envio cfg ON cfg.id = p.config_id
        WHERE cfg.sucursal_id = $1 AND cfg.campana = $3
       ON CONFLICT DO NOTHING`,
      [sucursalId, opp, campana, ultimo.inicio],
    );
    // Seguimientos de esa campaña: los pendientes se omiten y los que aún no existían se crean ya omitidos.
    await cliente.query(
      `INSERT INTO crm_seguimiento_ejecuciones (sucursal_id, seguimiento_id, oportunidad_id, referencia_en, programado_para, estado, motivo)
       SELECT $1, s.id, $2, now(), now(), 'omitido', 'ahora_no' FROM crm_seguimientos s WHERE s.sucursal_id = $1 AND s.campana = $3
       ON CONFLICT (seguimiento_id, oportunidad_id) DO UPDATE SET estado = 'omitido', motivo = 'ahora_no'
         WHERE crm_seguimiento_ejecuciones.estado = 'pendiente'`,
      [sucursalId, opp, campana],
    );
    // Las tareas y llamadas que dejaron los seguimientos de esa campaña ya no tienen sentido.
    await cliente.query(
      `UPDATE crm_tareas t SET estado = 'cancelada' FROM crm_seguimientos s
        WHERE t.seguimiento_id = s.id AND s.campana = $3 AND t.oportunidad_id = $2 AND t.sucursal_id = $1 AND t.estado = 'pendiente'`,
      [sucursalId, opp, campana],
    );
    await cliente.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle) VALUES ($1, $2, 'ahora_no', $3, $4)`,
      [sucursalId, opp, `Respondió «Ahora no» a la campaña ${campana}: sin más mensajes de esta campaña`, { campana, canal: "whatsapp" }],
    );
    await cliente.query("COMMIT");
    return { campana, oportunidadId: opp };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
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
      // Todos sus leads salvo las ventas (también los que están fuera de ventana: así el ciclo diario no los reabre).
      await cliente.query(
        `WITH marcados AS (
           UPDATE crm_oportunidades SET estado_contacto = 'baja', respuesta_por_clasificar = false
            WHERE contacto_id = ANY($2::uuid[]) AND estado <> 'ganada'
           RETURNING id
         )
         INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle)
         SELECT $1, m.id, 'baja', 'Pidió no recibir más mensajes', '{"canal":"whatsapp"}'::jsonb FROM marcados m`,
        [sucursalId, ids],
      );
      await cliente.query(`UPDATE crm_contactos SET baja_canal = 'whatsapp' WHERE id = ANY($1::uuid[])`, [ids]);
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
