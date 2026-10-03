import { getPool } from "./db.js";
import { emitirBroadcast } from "./realtime.js";
import {
  CAMPOS_CALCULADOS,
  calcularVencimiento,
  evaluarCondiciones,
  fechaLocal,
  rellenarTexto,
  validarSeguimiento,
  type Condicion,
  type SeguimientoEntrada,
  type TipoCampo,
} from "./seguimientosLogica.js";
import { telefono10 } from "./campanasLogica.js";

/**
 * Seguimientos después del primer contacto automático de una campaña.
 *
 *  - Planificador: por cada oportunidad que ya recibió el primer (o último) mensaje de una campaña con seguimientos
 *    activos, deja una fila en crm_seguimiento_ejecuciones con el momento en que le toca. Única por seguimiento y
 *    oportunidad: nunca corre dos veces.
 *  - Ejecutor: cuando le toca, revisa que la oportunidad siga abierta y sin garantía, que el cliente no haya pedido la
 *    baja y que se cumplan las condiciones. Entonces crea la tarea, agenda la llamada o deja en cola el WhatsApp
 *    (que pasa por las mismas reglas de envío que cualquier mensaje de campaña: ventana, tope, baja, plantilla).
 *
 * Si el primer mensaje fue una SIMULACIÓN, el seguimiento también se simula: se anota lo que habría hecho y no se crea
 * ninguna tarea ni se manda nada.
 */

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

const hhmm = (v: string | null | undefined) => (v ? String(v).slice(0, 5) : null);

/* ============================================================
   Configuración
   ============================================================ */

const TIPOS_VALIDOS = new Set<string>(["texto", "entero", "fecha", "fecha_hora", "booleano"]);

/** Tipo de cada columna que se puede usar en una condición: las de la tabla del portal y las calculadas. */
async function tiposDeCampos(cl: Consulta, sucursalId: string): Promise<Record<string, TipoCampo>> {
  const { rows } = await cl.query(
    `SELECT c.nombre_tecnico, c.tipo FROM entidad_campos c JOIN entidad_definiciones d ON d.id = c.entidad_id WHERE d.sucursal_id = $1`,
    [sucursalId],
  );
  const tipos: Record<string, TipoCampo> = {};
  for (const r of rows) if (TIPOS_VALIDOS.has(r.tipo as string)) tipos[r.nombre_tecnico as string] = r.tipo as TipoCampo;
  for (const c of CAMPOS_CALCULADOS) tipos[c.nombre] = c.tipo;
  return tipos;
}

export type Seguimiento = SeguimientoEntrada & { id: string; campana: string; orden: number };

function aSeguimiento(r: any): Seguimiento {
  return {
    id: r.id,
    campana: r.campana,
    orden: r.orden,
    nombre: r.nombre,
    activa: r.activa,
    desde: r.desde,
    espera_horas: r.espera_horas,
    accion: r.accion,
    condiciones: (r.condiciones ?? []) as Condicion[],
    titulo: r.titulo,
    descripcion: r.descripcion,
    vence_horas: r.vence_horas,
    hora: hhmm(r.hora),
    plantilla_id: r.plantilla_id,
    vigencia_horas: r.vigencia_horas,
  };
}

const COLUMNAS = `id, campana, orden, nombre, activa, desde, espera_horas, accion, condiciones, titulo, descripcion, vence_horas, hora::text AS hora, plantilla_id, vigencia_horas`;

export async function leerSeguimientos(sucursalId: string) {
  const pool = getPool();
  const [segs, campanas, plantillas, etapas, campos, resumen, recientes] = await Promise.all([
    pool.query(`SELECT ${COLUMNAS} FROM crm_seguimientos WHERE sucursal_id = $1 ORDER BY campana, orden`, [sucursalId]),
    pool.query(`SELECT campana FROM crm_campanas_envio WHERE sucursal_id = $1 ORDER BY campana`, [sucursalId]),
    pool.query(`SELECT id, coalesce(nombre, nombre_tecnico) AS nombre FROM whatsapp_plantillas WHERE sucursal_id = $1 AND estado = 'aprobada' ORDER BY 2`, [sucursalId]),
    pool.query(`SELECT nombre FROM crm_etapas WHERE sucursal_id = $1 AND activa ORDER BY orden`, [sucursalId]),
    pool.query(
      `SELECT c.nombre_tecnico, c.nombre_visible, c.tipo FROM entidad_campos c JOIN entidad_definiciones d ON d.id = c.entidad_id
        WHERE d.sucursal_id = $1 ORDER BY c.posicion`,
      [sucursalId],
    ),
    pool.query(
      `SELECT seguimiento_id, estado, count(*)::int AS n FROM crm_seguimiento_ejecuciones WHERE sucursal_id = $1 GROUP BY 1, 2`,
      [sucursalId],
    ),
    pool.query(
      `SELECT x.id, s.nombre AS seguimiento, s.campana, s.accion, x.estado, x.motivo, x.simulada, x.programado_para, x.actualizado_en, c.nombre AS cliente
         FROM crm_seguimiento_ejecuciones x
         JOIN crm_seguimientos s ON s.id = x.seguimiento_id
         JOIN crm_oportunidades o ON o.id = x.oportunidad_id
         JOIN crm_contactos c ON c.id = o.contacto_id
        WHERE x.sucursal_id = $1 ORDER BY x.actualizado_en DESC LIMIT 30`,
      [sucursalId],
    ),
  ]);

  const conteo = (id: string, estado: string) => (resumen.rows.find((r) => r.seguimiento_id === id && r.estado === estado)?.n as number | undefined) ?? 0;
  return {
    seguimientos: segs.rows.map((r) => ({
      ...aSeguimiento(r),
      resumen: { pendientes: conteo(r.id, "pendiente"), hechos: conteo(r.id, "hecho"), omitidos: conteo(r.id, "omitido"), simulados: conteo(r.id, "simulado") },
    })),
    campanas: campanas.rows.map((r) => r.campana as string),
    plantillas: plantillas.rows as { id: string; nombre: string }[],
    etapas: etapas.rows.map((r) => r.nombre as string),
    campos: [
      ...campos.rows
        .filter((r) => TIPOS_VALIDOS.has(r.tipo as string))
        .map((r) => ({ nombre: r.nombre_tecnico as string, etiqueta: r.nombre_visible as string, tipo: r.tipo as TipoCampo })),
      ...CAMPOS_CALCULADOS.map((c) => ({ nombre: c.nombre, etiqueta: c.etiqueta, tipo: c.tipo })),
    ],
    estados_contacto: ["Sin intentar", "Intentando", "Contactado", "Buzón de voz", "No contactable", "Baja"],
    recientes: recientes.rows,
  };
}

export type ResultadoGuardarSeguimientos = { ok: true } | { ok: false; error: string };

/**
 * Guarda los seguimientos de la sucursal. Los que ya existían se actualizan (conservan su historial); lo pendiente
 * de un seguimiento que cambió se reprograma con las reglas nuevas. Los que ya no vienen en la lista se borran.
 */
export async function guardarSeguimientos(sucursalId: string, lista: (SeguimientoEntrada & { id?: string; campana: string })[]): Promise<ResultadoGuardarSeguimientos> {
  if (lista.length > 40) return { ok: false, error: "Máximo 40 seguimientos." };
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const tipos = await tiposDeCampos(cliente, sucursalId);

    const { rows: campanas } = await cliente.query(`SELECT campana FROM crm_campanas_envio WHERE sucursal_id = $1`, [sucursalId]);
    const conocidas = new Set(campanas.map((r) => r.campana as string));
    const plantillasUsadas = [...new Set(lista.map((s) => s.plantilla_id).filter((x): x is string => Boolean(x)))];
    if (plantillasUsadas.length > 0) {
      const { rows } = await cliente.query(`SELECT id FROM whatsapp_plantillas WHERE sucursal_id = $1 AND id = ANY($2::uuid[])`, [sucursalId, plantillasUsadas]);
      if (rows.length !== plantillasUsadas.length) {
        await cliente.query("ROLLBACK");
        return { ok: false, error: "Una de las plantillas elegidas no existe en esta sucursal." };
      }
    }
    for (const s of lista) {
      if (!conocidas.has(s.campana)) {
        await cliente.query("ROLLBACK");
        return { ok: false, error: `La campaña «${s.campana}» no existe.` };
      }
      const error = validarSeguimiento(s, tipos);
      if (error) {
        await cliente.query("ROLLBACK");
        return { ok: false, error };
      }
    }

    const { rows: existentes } = await cliente.query(`SELECT ${COLUMNAS} FROM crm_seguimientos WHERE sucursal_id = $1`, [sucursalId]);
    const porId = new Map(existentes.map((r) => [r.id as string, aSeguimiento(r)]));
    const conservados = new Set<string>();

    // Primero se libera el orden para no chocar con la unicidad (sucursal, campaña, orden) al reordenar.
    await cliente.query(`UPDATE crm_seguimientos SET orden = orden + 1000 WHERE sucursal_id = $1`, [sucursalId]);

    const ordenPorCampana = new Map<string, number>();
    for (const s of lista) {
      const orden = (ordenPorCampana.get(s.campana) ?? 0) + 1;
      ordenPorCampana.set(s.campana, orden);
      const valores = [
        s.campana, orden, s.nombre.trim(), s.activa, s.desde, s.espera_horas, s.accion, JSON.stringify(s.condiciones),
        s.accion === "whatsapp" ? null : (s.titulo ?? "").trim() || null,
        s.accion === "whatsapp" ? null : (s.descripcion ?? "").trim() || null,
        s.accion === "whatsapp" ? null : s.vence_horas,
        s.accion === "whatsapp" ? null : s.hora,
        s.accion === "whatsapp" ? s.plantilla_id : null,
        s.vigencia_horas,
      ];
      const previo = s.id ? porId.get(s.id) : undefined;
      if (previo) {
        conservados.add(previo.id);
        await cliente.query(
          `UPDATE crm_seguimientos SET campana = $2, orden = $3, nombre = $4, activa = $5, desde = $6, espera_horas = $7, accion = $8,
                  condiciones = $9::jsonb, titulo = $10, descripcion = $11, vence_horas = $12, hora = $13, plantilla_id = $14, vigencia_horas = $15
            WHERE id = $1`,
          [previo.id, ...valores],
        );
        // Si cambió algo que afecta cuándo o a quién le toca, lo pendiente se vuelve a programar.
        const cambio =
          previo.campana !== s.campana || previo.desde !== s.desde || previo.espera_horas !== s.espera_horas || previo.accion !== s.accion;
        if (cambio) await cliente.query(`DELETE FROM crm_seguimiento_ejecuciones WHERE seguimiento_id = $1 AND estado = 'pendiente'`, [previo.id]);
      } else {
        await cliente.query(
          `INSERT INTO crm_seguimientos (sucursal_id, campana, orden, nombre, activa, desde, espera_horas, accion, condiciones, titulo, descripcion, vence_horas, hora, plantilla_id, vigencia_horas)
           VALUES ($15, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)`,
          [...valores, sucursalId],
        );
      }
    }
    const aBorrar = existentes.map((r) => r.id as string).filter((id) => !conservados.has(id));
    if (aBorrar.length > 0) await cliente.query(`DELETE FROM crm_seguimientos WHERE id = ANY($1::uuid[])`, [aBorrar]);

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

/** Programa el seguimiento de cada oportunidad que ya recibió el mensaje de la campaña. */
export async function planificarSeguimientos(): Promise<number> {
  const { rowCount } = await getPool().query(
    `INSERT INTO crm_seguimiento_ejecuciones (sucursal_id, seguimiento_id, oportunidad_id, referencia_en, programado_para, simulada)
     SELECT s.sucursal_id, s.id, r.oportunidad_id,
            CASE s.desde WHEN 'primer_envio' THEN r.primero ELSE r.ultimo END,
            CASE s.desde WHEN 'primer_envio' THEN r.primero ELSE r.ultimo END + make_interval(hours => s.espera_horas),
            r.simulada
       FROM crm_seguimientos s
       JOIN (
         SELECT e.sucursal_id, e.campana, e.oportunidad_id,
                min(e.enviado_en) FILTER (WHERE e.estado IN ('enviado', 'entregado', 'leido', 'simulado')) AS primero,
                max(e.enviado_en) FILTER (WHERE e.estado IN ('enviado', 'entregado', 'leido', 'simulado')) AS ultimo,
                count(*) FILTER (WHERE e.estado = 'pendiente')::int AS pendientes,
                coalesce(bool_or(e.estado = 'simulado'), false) AS simulada
           FROM crm_envios e
          WHERE e.paso_id IS NOT NULL
            AND (e.sucursal_id, e.campana) IN (SELECT sucursal_id, campana FROM crm_seguimientos WHERE activa)
          GROUP BY 1, 2, 3
       ) r ON r.sucursal_id = s.sucursal_id AND r.campana = s.campana
       JOIN crm_oportunidades o ON o.id = r.oportunidad_id AND o.estado = 'abierta'
      WHERE s.activa AND r.primero IS NOT NULL AND (s.desde = 'primer_envio' OR r.pendientes = 0)
        AND NOT EXISTS (SELECT 1 FROM crm_seguimiento_ejecuciones x WHERE x.seguimiento_id = s.id AND x.oportunidad_id = r.oportunidad_id)
      LIMIT 2000
     ON CONFLICT (seguimiento_id, oportunidad_id) DO NOTHING`,
  );
  return rowCount ?? 0;
}

/* ============================================================
   Ejecutor
   ============================================================ */

type FilaEjecucion = {
  id: string;
  sucursal_id: string;
  seguimiento_id: string;
  oportunidad_id: string;
  referencia_en: Date;
  simulada: boolean;
};

/** Los datos de la oportunidad con los que se evalúan las condiciones y se rellenan los textos. */
async function cargarFila(cl: Consulta, x: FilaEjecucion): Promise<{ fila: Record<string, unknown>; baja: boolean } | null> {
  const { rows } = await cl.query(
    `SELECT to_jsonb(v) AS f, c.whatsapp_baja
       FROM crm_v_oportunidades v JOIN crm_oportunidades o ON o.id = v.id JOIN crm_contactos c ON c.id = o.contacto_id
      WHERE v.id = $1 AND v.sucursal_id = $2`,
    [x.oportunidad_id, x.sucursal_id],
  );
  if (!rows[0]) return null;
  const fila = rows[0].f as Record<string, unknown>;
  const tel = telefono10(fila.telefono_principal);

  const [resp, contesto] = await Promise.all([
    tel
      ? cl.query(
          `SELECT EXISTS (SELECT 1 FROM whatsapp_mensajes m JOIN whatsapp_conversaciones cv ON cv.id = m.conversacion_id
                           WHERE cv.sucursal_id = $1 AND right(regexp_replace(cv.wa_id, '\\D', '', 'g'), 10) = $2
                             AND m.direccion = 'entrante' AND m.creado_en >= $3) AS v`,
          [x.sucursal_id, tel, x.referencia_en],
        )
      : Promise.resolve({ rows: [{ v: false }] }),
    cl.query(
      `SELECT EXISTS (SELECT 1 FROM crm_actividades a WHERE a.oportunidad_id = $1 AND a.tipo IN ('llamada', 'whatsapp')
                       AND a.detalle->>'resultado' = 'contesto' AND a.creado_en >= $2) AS v`,
      [x.oportunidad_id, x.referencia_en],
    ),
  ]);
  fila.respondio_whatsapp = resp.rows[0].v === true;
  fila.contesto = contesto.rows[0].v === true;
  return { fila, baja: rows[0].whatsapp_baja === true };
}

const cerrar = (cl: Consulta, id: string, estado: "hecho" | "omitido" | "simulado", motivo: string | null, extra: { tarea_id?: string; envio_id?: string } = {}) =>
  cl.query(`UPDATE crm_seguimiento_ejecuciones SET estado = $2, motivo = $3, tarea_id = $4, envio_id = $5 WHERE id = $1`, [
    id,
    estado,
    motivo,
    extra.tarea_id ?? null,
    extra.envio_id ?? null,
  ]);

/** Toma la ejecución más antigua que ya le toca y la resuelve. Devuelve false si no hay nada. */
async function ejecutarUno(tiposPorSucursal: Map<string, Record<string, TipoCampo>>): Promise<{ hubo: boolean; tarea: string | null }> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `SELECT x.id, x.sucursal_id, x.seguimiento_id, x.oportunidad_id, x.referencia_en, x.simulada,
              s.campana, s.nombre, s.accion, s.condiciones, s.titulo, s.descripcion, s.vence_horas, s.hora::text AS hora, s.plantilla_id
         FROM crm_seguimiento_ejecuciones x JOIN crm_seguimientos s ON s.id = x.seguimiento_id
        WHERE x.estado = 'pendiente' AND x.programado_para <= now() AND s.activa
        ORDER BY x.programado_para LIMIT 1 FOR UPDATE OF x SKIP LOCKED`,
    );
    const x = rows[0];
    if (!x) {
      await cliente.query("ROLLBACK");
      return { hubo: false, tarea: null };
    }

    const datos = await cargarFila(cliente, x as FilaEjecucion);
    if (!datos || datos.fila.estado_oportunidad !== "abierta") {
      await cerrar(cliente, x.id, "omitido", "ya_no_aplica");
      await cliente.query("COMMIT");
      return { hubo: true, tarea: null };
    }
    const { fila, baja } = datos;
    if (fila.tiene_ge === true) {
      await cerrar(cliente, x.id, "omitido", "ya_tiene_ge");
      await cliente.query("COMMIT");
      return { hubo: true, tarea: null };
    }
    if (baja) {
      await cerrar(cliente, x.id, "omitido", "baja");
      await cliente.query("COMMIT");
      return { hubo: true, tarea: null };
    }

    if (!tiposPorSucursal.has(x.sucursal_id)) tiposPorSucursal.set(x.sucursal_id, await tiposDeCampos(cliente, x.sucursal_id as string));
    const { cumple } = evaluarCondiciones((x.condiciones ?? []) as Condicion[], fila, tiposPorSucursal.get(x.sucursal_id)!);
    if (!cumple) {
      await cerrar(cliente, x.id, "omitido", "no_cumple_condicion");
      await cliente.query("COMMIT");
      return { hubo: true, tarea: null };
    }

    if (x.simulada) {
      await cerrar(cliente, x.id, "simulado", null);
      await cliente.query("COMMIT");
      return { hubo: true, tarea: null };
    }

    if (x.accion === "whatsapp") {
      const { rows: envio } = await cliente.query(
        `INSERT INTO crm_envios (sucursal_id, oportunidad_id, seguimiento_id, campana, plantilla_id, inicio, programado_para)
         VALUES ($1, $2, $3, $4, $5, $6::date, now())
         ON CONFLICT (oportunidad_id, seguimiento_id) WHERE seguimiento_id IS NOT NULL DO NOTHING RETURNING id`,
        [x.sucursal_id, x.oportunidad_id, x.seguimiento_id, x.campana, x.plantilla_id, fechaLocal(new Date(x.referencia_en).toISOString())],
      );
      await cerrar(cliente, x.id, "hecho", null, { envio_id: envio[0]?.id });
      await cliente.query("COMMIT");
      return { hubo: true, tarea: null };
    }

    // Tarea o llamada: una tarea con fecha (y, si es llamada, con el teléfono a la mano).
    const esLlamada = x.accion === "llamada";
    const vence = calcularVencimiento(new Date(), x.vence_horas as number | null, hhmm(x.hora as string | null));
    const { rows: tarea } = await cliente.query(
      `INSERT INTO crm_tareas (sucursal_id, oportunidad_id, seguimiento_id, tipo, titulo, descripcion, config, asignado_a, vence_en)
       VALUES ($1, $2, $3, 'tarea', $4, $5, $6::jsonb, $7, $8) RETURNING id`,
      [
        x.sucursal_id,
        x.oportunidad_id,
        x.seguimiento_id,
        rellenarTexto(String(x.titulo ?? ""), fila),
        x.descripcion ? rellenarTexto(String(x.descripcion), fila) : null,
        JSON.stringify({ llamada: esLlamada, seguimiento: x.nombre, telefono: fila.telefono_principal ?? null }),
        (fila.ejecutivo as string | null) ?? null,
        vence,
      ],
    );
    await cliente.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle) VALUES ($1, $2, 'seguimiento', $3, $4)`,
      [x.sucursal_id, x.oportunidad_id, `Seguimiento «${x.nombre}»: ${esLlamada ? "llamada agendada" : "tarea creada"}`, { seguimiento_id: x.seguimiento_id, campana: x.campana }],
    );
    await cerrar(cliente, x.id, "hecho", null, { tarea_id: tarea[0].id });
    await cliente.query("COMMIT");
    return { hubo: true, tarea: x.sucursal_id as string };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Ejecuta lo que ya toca, con un presupuesto de tiempo. Devuelve cuántos resolvió. */
export async function ejecutarSeguimientos(presupuestoMs = 20_000, maximo = 200): Promise<number> {
  const inicio = Date.now();
  const tipos = new Map<string, Record<string, TipoCampo>>();
  const conTareas = new Set<string>();
  let hechos = 0;
  while (hechos < maximo && Date.now() - inicio < presupuestoMs) {
    let r: { hubo: boolean; tarea: string | null };
    try {
      r = await ejecutarUno(tipos);
    } catch (err) {
      console.error("[seguimientos] error ejecutando un seguimiento", err instanceof Error ? err.message : err);
      break;
    }
    if (!r.hubo) break;
    if (r.tarea) conTareas.add(r.tarea);
    hechos++;
  }
  // Las bandejas de Tareas abiertas se refrescan solas.
  for (const sucursal of conTareas) emitirBroadcast(`datos:${sucursal}`, "tareas", {});
  return hechos;
}
