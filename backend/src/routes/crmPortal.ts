import { Router } from "express";
import { z } from "zod";
import { getPool } from "../lib/db.js";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { listarEtapas, editarOportunidad } from "../lib/crm.js";
import { DESTINOS_PREGUNTA, TIPOS_RESPUESTA, automatizacionSchema, validarRespuesta } from "../lib/motorCrm.js";
import { emitirBroadcast } from "../lib/realtime.js";
import { ejecutivoRestringido, exigirUuid } from "../lib/permisos.js";

/**
 * Rutas del CRM para el portal de la sucursal: configuración de automatizaciones por etapa
 * (solo admin) y la bandeja de tareas del ejecutivo (todos, filtrada por su ejecutivo).
 */
export const crmPortalRouter = Router();

crmPortalRouter.use(requireAuth);
exigirUuid(crmPortalRouter, "etapaId", "tid");
crmPortalRouter.use("/sucursales/:id/crm", requireAccesoSucursal);

/** Un asesor con ejecutivo asignado solo ve lo suyo; el admin y un asesor sin ejecutivo, todo. */

/* ============================================================
   Automatizaciones (admin de la sucursal)
   ============================================================ */

crmPortalRouter.get("/sucursales/:id/crm/automatizaciones", requireAdminSucursal, async (req, res, next) => {
  try {
    const etapas = await listarEtapas(req.params.id);
    const { rows } = await getPool().query(
      `SELECT id, etapa_id, evento, tipo, nombre, config, orden, activa FROM crm_automatizaciones
        WHERE sucursal_id = $1 ORDER BY orden, creado_en`,
      [req.params.id],
    );
    const { data: plantillas, error } = await getSupabase()
      .from("whatsapp_plantillas")
      .select("id, nombre, nombre_tecnico, estado")
      .eq("sucursal_id", req.params.id)
      .order("nombre");
    if (error) throw new Error(error.message);

    const campos = await camposDestino(req.params.id);
    res.json({
      etapas: etapas.map((e) => ({ ...e, automatizaciones: rows.filter((r) => r.etapa_id === e.id) })),
      plantillas: plantillas ?? [],
      destinos: campos,
      tipos_respuesta: TIPOS_RESPUESTA,
    });
  } catch (err) {
    next(err);
  }
});

/** Columnas de la tabla donde una pregunta puede guardar su respuesta, con su nombre visible. */
async function camposDestino(sucursalId: string): Promise<{ nombre_tecnico: string; nombre_visible: string; tipo: string }[]> {
  const { data: def } = await getSupabase().from("entidad_definiciones").select("id").eq("sucursal_id", sucursalId).maybeSingle();
  if (!def) return [];
  const { data } = await getSupabase()
    .from("entidad_campos")
    .select("nombre_tecnico, nombre_visible, tipo")
    .eq("entidad_id", def.id)
    .in("nombre_tecnico", [...DESTINOS_PREGUNTA]);
  return data ?? [];
}

const guardarSchema = z.object({ items: z.array(automatizacionSchema).max(30) });

/** Reemplaza el conjunto de automatizaciones de una etapa (el arreglo define también el orden). */
crmPortalRouter.put("/sucursales/:id/crm/automatizaciones/:etapaId", requireAdminSucursal, async (req, res, next) => {
  const parsed = guardarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  const cliente = await getPool().connect();
  try {
    const { rows: etapa } = await cliente.query(`SELECT id FROM crm_etapas WHERE id = $1 AND sucursal_id = $2`, [
      req.params.etapaId,
      req.params.id,
    ]);
    if (!etapa[0]) {
      res.status(404).json({ error: "Ese estado del lead no existe." });
      return;
    }

    await cliente.query("BEGIN");
    const { rows: existentes } = await cliente.query(
      `SELECT id, activa FROM crm_automatizaciones WHERE etapa_id = $1 AND sucursal_id = $2`,
      [req.params.etapaId, req.params.id],
    );
    const idsExistentes = new Set(existentes.map((r) => r.id as string));
    const estabaActiva = new Map(existentes.map((r) => [r.id as string, r.activa === true]));
    const conservados = new Set<string>();

    for (const [orden, item] of parsed.data.items.entries()) {
      if (item.id && idsExistentes.has(item.id)) {
        conservados.add(item.id);
        await cliente.query(
          `UPDATE crm_automatizaciones
              SET tipo = $2, nombre = $3, config = $4, orden = $5, activa = $6, evento = $7,
                  activa_desde = CASE WHEN NOT $6 THEN NULL WHEN $8 THEN activa_desde ELSE now() END
            WHERE id = $1`,
          [item.id, item.tipo, item.nombre, item.config, orden, item.activa, item.evento, estabaActiva.get(item.id) === true],
        );
      } else {
        await cliente.query(
          `INSERT INTO crm_automatizaciones (sucursal_id, etapa_id, tipo, nombre, config, orden, activa, evento, activa_desde)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 THEN now() END)`,
          [req.params.id, req.params.etapaId, item.tipo, item.nombre, item.config, orden, item.activa, item.evento],
        );
      }
    }
    const aBorrar = [...idsExistentes].filter((id) => !conservados.has(id));
    if (aBorrar.length > 0) await cliente.query(`DELETE FROM crm_automatizaciones WHERE id = ANY($1::uuid[])`, [aBorrar]);

    await cliente.query("COMMIT");
    res.json({ guardado: true });
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    cliente.release();
  }
});

/* ============================================================
   Tareas del ejecutivo
   ============================================================ */

crmPortalRouter.get("/sucursales/:id/crm/tareas", async (req, res, next) => {
  try {
    const estado = ["pendiente", "hecha", "cancelada"].includes(String(req.query.estado)) ? String(req.query.estado) : "pendiente";
    const restringido = ejecutivoRestringido(req.perfil);
    const filtroEjecutivo = typeof req.query.ejecutivo === "string" && req.query.ejecutivo && !restringido ? req.query.ejecutivo : restringido;

    const params: unknown[] = [req.params.id, estado];
    let extra = "";
    if (filtroEjecutivo) {
      params.push(filtroEjecutivo);
      extra = ` AND t.asignado_a = $${params.length}`;
    }

    const { rows } = await getPool().query(
      `SELECT t.id, t.tipo, t.titulo, t.descripcion, t.config, t.asignado_a, t.vence_en, t.estado, t.respuesta, t.creado_en,
              t.completada_en, t.oportunidad_id, v.cliente, v.telefono_principal, v.etapa_embudo
         FROM crm_tareas t JOIN crm_v_oportunidades v ON v.id = t.oportunidad_id
        WHERE t.sucursal_id = $1 AND t.estado = $2${extra}
        ORDER BY t.vence_en NULLS LAST, t.creado_en
        LIMIT 300`,
      params,
    );

    const { rows: conteos } = await getPool().query(
      `SELECT count(*)::int AS n FROM crm_tareas t WHERE t.sucursal_id = $1 AND t.estado = 'pendiente'${filtroEjecutivo ? " AND t.asignado_a = $2" : ""}`,
      filtroEjecutivo ? [req.params.id, filtroEjecutivo] : [req.params.id],
    );

    res.json({ tareas: rows, pendientes: conteos[0]?.n ?? 0 });
  } catch (err) {
    next(err);
  }
});

type TareaFila = {
  id: string;
  oportunidad_id: string;
  tipo: "tarea" | "pregunta";
  titulo: string;
  config: Record<string, unknown>;
  asignado_a: string | null;
  estado: string;
};

/** Carga una tarea de la sucursal y verifica que el usuario pueda tocarla. */
async function tareaAccesible(req: import("express").Request, res: import("express").Response): Promise<TareaFila | null> {
  const { rows } = await getPool().query(
    `SELECT id, oportunidad_id, tipo, titulo, config, asignado_a, estado FROM crm_tareas WHERE id = $1 AND sucursal_id = $2`,
    [req.params.tid, req.params.id],
  );
  const tarea = rows[0] as TareaFila | undefined;
  if (!tarea) {
    res.status(404).json({ error: "Tarea no encontrada." });
    return null;
  }
  const restringido = ejecutivoRestringido(req.perfil);
  if (restringido && tarea.asignado_a !== restringido) {
    res.status(403).json({ error: "Esta tarea es de otro ejecutivo." });
    return null;
  }
  if (tarea.estado !== "pendiente") {
    res.status(409).json({ error: "La tarea ya no está pendiente." });
    return null;
  }
  return tarea;
}

const completarSchema = z.object({ respuesta: z.union([z.string(), z.number()]).nullable().optional() });

crmPortalRouter.post("/sucursales/:id/crm/tareas/:tid/completar", async (req, res, next) => {
  const parsed = completarSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    const tarea = await tareaAccesible(req, res);
    if (!tarea) return;

    let respuesta: string | null = null;
    if (tarea.tipo === "pregunta") {
      const vacia = parsed.data.respuesta === undefined || parsed.data.respuesta === null || String(parsed.data.respuesta).trim() === "";
      if (vacia && tarea.config.obligatoria !== true) {
        // Pregunta opcional sin respuesta: se cierra sin registrar nada.
      } else {
        const r = validarRespuesta(tarea.config, parsed.data.respuesta);
        if ("error" in r) {
          res.status(400).json({ error: r.error });
          return;
        }
        respuesta = r.valor;
      }

      // Registrar la respuesta en la columna destino de la tabla.
      const destino = tarea.config.campo_destino as string | null | undefined;
      if (respuesta !== null && destino && (DESTINOS_PREGUNTA as readonly string[]).includes(destino)) {
        let valor: string = respuesta;
        if (destino === "comentarios") {
          const { rows } = await getPool().query(`SELECT comentarios FROM crm_oportunidades WHERE id = $1`, [tarea.oportunidad_id]);
          const previo = (rows[0]?.comentarios as string | null) ?? "";
          const linea = `${String(tarea.config.texto ?? tarea.titulo)} ${respuesta}`;
          valor = previo ? `${previo}\n${linea}` : linea;
        }
        const edicion = await editarOportunidad({
          sucursalId: req.params.id,
          oportunidadId: tarea.oportunidad_id,
          valores: { [destino]: valor },
          usuarioId: req.usuario?.id,
        });
        if (!edicion.ok) {
          res.status(edicion.estado).json({ error: edicion.error });
          return;
        }
        emitirBroadcast(`datos:${req.params.id}`, "refresh", { rowId: tarea.oportunidad_id });
      }
    }

    await getPool().query(
      `UPDATE crm_tareas SET estado = 'hecha', respuesta = $2, completada_en = now(),
              completada_por = (SELECT id FROM usuarios WHERE id = $3)
        WHERE id = $1`,
      [tarea.id, respuesta, req.usuario?.id ?? null],
    );
    emitirBroadcast(`datos:${req.params.id}`, "tareas", {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

crmPortalRouter.post("/sucursales/:id/crm/tareas/:tid/cancelar", async (req, res, next) => {
  try {
    const tarea = await tareaAccesible(req, res);
    if (!tarea) return;
    await getPool().query(
      `UPDATE crm_tareas SET estado = 'cancelada', completada_en = now(), completada_por = (SELECT id FROM usuarios WHERE id = $2) WHERE id = $1`,
      [tarea.id, req.usuario?.id ?? null],
    );
    emitirBroadcast(`datos:${req.params.id}`, "tareas", {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
