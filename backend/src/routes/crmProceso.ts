import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getPool } from "../lib/db.js";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { emitirBroadcast } from "../lib/realtime.js";
import { restringidoDe, exigirUuid } from "../lib/permisos.js";
import { MAX_MASIVO, borrarVista, ejecutarAccionMasiva, guardarVista, listarVistas, resumenInicio } from "../lib/crmMasivo.js";
import { estadoSincronizacion, sincronizarCrm, type ResumenSync } from "../lib/sincronizacionCrm.js";
import {
  CANALES,
  ESTADOS_CONTRATO,
  RESULTADOS,
  agregarNota,
  estadoEquipo,
  guardarConfigEquipo,
  guardarContrato,
  leerContrato,
  lineaDeTiempo,
  reasignarCartera,
  registrarContacto,
  reporteEmbudo,
} from "../lib/crmProceso.js";

/**
 * Proceso comercial del CRM en el portal: ficha de oportunidad (contacto, notas, contrato, línea de
 * tiempo), reporte del embudo, equipo (roster y reasignación) y SLA por etapa.
 */
export const crmProcesoRouter = Router();

crmProcesoRouter.use(requireAuth);
exigirUuid(crmProcesoRouter, "oid", "etapaId", "vid");
crmProcesoRouter.use("/sucursales/:id/crm", requireAccesoSucursal);

const restringidoA = restringidoDe;

/** Verifica que la oportunidad sea de la sucursal y que el usuario pueda tocarla (un asesor, solo las de su ejecutivo). */
async function oportunidadAccesible(req: Request, res: Response): Promise<boolean> {
  const { rows } = await getPool().query(`SELECT ejecutivo FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2`, [
    req.params.oid,
    req.params.id,
  ]);
  if (!rows[0]) {
    res.status(404).json({ error: "Registro no encontrado." });
    return false;
  }
  const r = restringidoA(req);
  if (r && rows[0].ejecutivo !== r) {
    res.status(403).json({ error: "Esta oportunidad es de otro ejecutivo." });
    return false;
  }
  return true;
}

const avisarCambio = (sucursalId: string, oportunidadId: string) => emitirBroadcast(`datos:${sucursalId}`, "refresh", { rowId: oportunidadId });

/* ============================================================
   Ficha de oportunidad
   ============================================================ */

const COLUMNAS_FICHA = [
  "cliente", "telefono_principal", "correo", "vin", "agencia", "linea", "version_vehiculo", "anio_vin", "campana",
  "fase_campana", "inicio_campana", "fin_campana", "proxima_campania", "fecha_proxima_campania", "estado_fuente",
  "etapa_embudo", "estado_contacto", "intentos", "motivo_perdida", "comentarios", "fecha_ultimo_contacto",
  "fecha_compra", "ejecutivo", "entro_a_etapa_en", "kilometraje", "etapa_vehiculo",
];
/** Siempre se muestran: sin ellas la ficha no tiene sentido. */
const SIEMPRE = new Set(["cliente", "etapa_embudo", "estado_contacto", "ejecutivo", "entro_a_etapa_en", "intentos"]);

crmProcesoRouter.get("/sucursales/:id/crm/oportunidades/:oid", async (req, res, next) => {
  try {
    if (!(await oportunidadAccesible(req, res))) return;

    // Respeta las columnas que el admin dejó ocultas en la tabla.
    const { data: def } = await getSupabase().from("entidad_definiciones").select("id").eq("sucursal_id", req.params.id).maybeSingle();
    const { data: meta } = def
      ? await getSupabase().from("entidad_campos").select("nombre_tecnico, nombre_visible, tipo, visible").eq("entidad_id", def.id)
      : { data: [] };
    const visibles = new Set((meta ?? []).filter((c) => c.visible !== false).map((c) => c.nombre_tecnico as string));
    const columnas = COLUMNAS_FICHA.filter((c) => SIEMPRE.has(c) || visibles.has(c));

    const { rows } = await getPool().query(
      `SELECT ${columnas.map((c) => `"${c}"`).join(", ")} FROM crm_v_oportunidades WHERE id = $1 AND sucursal_id = $2`,
      [req.params.oid, req.params.id],
    );
    const { rows: tareas } = await getPool().query(
      `SELECT id, tipo, titulo, descripcion, config, vence_en FROM crm_tareas
        WHERE oportunidad_id = $1 AND sucursal_id = $2 AND estado = 'pendiente' ORDER BY vence_en NULLS LAST, creado_en`,
      [req.params.oid, req.params.id],
    );
    const { rows: cfg } = await getPool().query(`SELECT exigir_evidencia_venta FROM crm_config WHERE sucursal_id = $1`, [req.params.id]);

    res.json({
      oportunidad: rows[0],
      etiquetas: Object.fromEntries((meta ?? []).map((c) => [c.nombre_tecnico, c.nombre_visible])),
      contrato: await leerContrato(req.params.id, req.params.oid),
      exigir_evidencia_venta: cfg[0]?.exigir_evidencia_venta === true,
      tareas,
      linea_tiempo: await lineaDeTiempo(req.params.id, req.params.oid),
      estados_contrato: ESTADOS_CONTRATO,
    });
  } catch (err) {
    next(err);
  }
});

const contactoSchema = z.object({
  canal: z.enum(CANALES),
  resultado: z.enum(RESULTADOS),
  nota: z.string().trim().max(500).nullable().optional(),
});

crmProcesoRouter.post("/sucursales/:id/crm/oportunidades/:oid/contacto", async (req, res, next) => {
  const parsed = contactoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    if (!(await oportunidadAccesible(req, res))) return;
    const r = await registrarContacto({
      sucursalId: req.params.id,
      oportunidadId: req.params.oid,
      ...parsed.data,
      usuarioId: req.usuario?.id,
    });
    if (!r.ok) {
      res.status(r.estado).json({ error: r.error });
      return;
    }
    avisarCambio(req.params.id, req.params.oid);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

crmProcesoRouter.post("/sucursales/:id/crm/oportunidades/:oid/notas", async (req, res, next) => {
  const parsed = z.object({ texto: z.string().trim().min(1, "Escribe la nota.").max(1000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    if (!(await oportunidadAccesible(req, res))) return;
    const r = await agregarNota({ sucursalId: req.params.id, oportunidadId: req.params.oid, texto: parsed.data.texto, usuarioId: req.usuario?.id });
    if (!r.ok) {
      res.status(r.estado).json({ error: r.error });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const contratoSchema = z.object({
  estado: z.enum(ESTADOS_CONTRATO),
  folio: z.string().trim().max(60).nullable().optional(),
});

crmProcesoRouter.put("/sucursales/:id/crm/oportunidades/:oid/contrato", async (req, res, next) => {
  const parsed = contratoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    if (!(await oportunidadAccesible(req, res))) return;
    const r = await guardarContrato({ sucursalId: req.params.id, oportunidadId: req.params.oid, ...parsed.data, usuarioId: req.usuario?.id });
    if (!r.ok) {
      res.status(r.estado).json({ error: r.error });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   Reporte del embudo
   ============================================================ */

const fechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

crmProcesoRouter.get("/sucursales/:id/crm/reportes/embudo", async (req, res, next) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const hace30 = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const desde = fechaSchema.safeParse(req.query.desde);
    const hasta = fechaSchema.safeParse(req.query.hasta);
    const d = desde.success ? desde.data : hace30;
    const h = hasta.success ? hasta.data : hoy;
    if (d > h) {
      res.status(400).json({ error: "La fecha inicial no puede ser posterior a la final." });
      return;
    }
    res.json(await reporteEmbudo(req.params.id, d, h, restringidoA(req)));
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   Equipo (admin de la sucursal)
   ============================================================ */

crmProcesoRouter.get("/sucursales/:id/crm/equipo", requireAdminSucursal, async (req, res, next) => {
  try {
    res.json(await estadoEquipo(req.params.id));
  } catch (err) {
    next(err);
  }
});

const equipoSchema = z.object({
  roster: z
    .array(z.string().trim().min(1).max(80))
    .max(30)
    .transform((l) => [...new Set(l)])
    .optional(),
  exigir_evidencia_venta: z.boolean().optional(),
});

crmProcesoRouter.put("/sucursales/:id/crm/equipo", requireAdminSucursal, async (req, res, next) => {
  const parsed = equipoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    await guardarConfigEquipo(req.params.id, parsed.data);
    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});

const reasignarSchema = z.object({
  de: z.string().trim().min(1).max(80),
  a: z.string().trim().min(1).max(80).nullable().default(null),
  simular: z.boolean().default(true),
});

crmProcesoRouter.post("/sucursales/:id/crm/equipo/reasignar", requireAdminSucursal, async (req, res, next) => {
  const parsed = reasignarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    const r = await reasignarCartera({ sucursalId: req.params.id, ...parsed.data, usuarioId: req.usuario?.id });
    if ("error" in r) {
      res.status(400).json({ error: r.error });
      return;
    }
    if (r.aplicado) {
      emitirBroadcast(`datos:${req.params.id}`, "refresh", {});
      emitirBroadcast(`datos:${req.params.id}`, "tareas", {});
    }
    res.json(r);
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   SLA por etapa (admin)
   ============================================================ */

crmProcesoRouter.put("/sucursales/:id/crm/etapas/:etapaId/sla", requireAdminSucursal, async (req, res, next) => {
  const parsed = z.object({ tiempo_max_horas: z.number().int().min(1).max(24 * 365).nullable() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Indica las horas (un entero positivo) o déjalo vacío." });
    return;
  }
  try {
    const { rowCount } = await getPool().query(
      `UPDATE crm_etapas SET tiempo_max_horas = $3 WHERE id = $1 AND sucursal_id = $2 AND tipo = 'abierta'`,
      [req.params.etapaId, req.params.id, parsed.data.tiempo_max_horas],
    );
    if (!rowCount) {
      res.status(404).json({ error: "La etapa no existe o no es una etapa abierta." });
      return;
    }
    emitirBroadcast(`datos:${req.params.id}`, "refresh", {});
    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   Sincronización con BigQuery (admin de la sucursal)
   ============================================================ */

crmProcesoRouter.get("/sucursales/:id/crm/sincronizacion", requireAdminSucursal, async (req, res, next) => {
  try {
    res.json(await estadoSincronizacion(req.params.id));
  } catch (err) {
    next(err);
  }
});

/** Simula (sin `aplicar`) o aplica la sincronización. Devuelve solo conteos. */
crmProcesoRouter.post("/sucursales/:id/crm/sincronizacion", requireAdminSucursal, async (req, res, next) => {
  const parsed = z.object({ aplicar: z.boolean().default(false) }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    const resumen = await sincronizarCrm(req.params.id, parsed.data.aplicar);
    if (parsed.data.aplicar) {
      emitirBroadcast(`datos:${req.params.id}`, "refresh", {});
      emitirBroadcast(`datos:${req.params.id}`, "tareas", {});
    }
    res.json(resumen);
  } catch (err) {
    const resumen = (err as { resumen?: ResumenSync }).resumen;
    if (resumen) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Sincronización abortada.", resumen });
      return;
    }
    next(err);
  }
});

/* ============================================================
   Inicio: resumen del día
   ============================================================ */

crmProcesoRouter.get("/sucursales/:id/crm/resumen", async (req, res, next) => {
  try {
    res.json(await resumenInicio(req.params.id, restringidoA(req)));
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   Acciones masivas sobre las filas elegidas en la tabla
   ============================================================ */

const masivoSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_MASIVO),
  accion: z.discriminatedUnion("accion", [
    z.object({ accion: z.literal("etapa"), etapa: z.string().trim().min(1).max(80), motivo: z.string().trim().max(80).nullable().optional() }),
    z.object({ accion: z.literal("ejecutivo"), ejecutivo: z.string().trim().min(1).max(80) }),
    z.object({
      accion: z.literal("tarea"),
      titulo: z.string().trim().min(1, "La tarea necesita un título.").max(160),
      descripcion: z.string().trim().max(1000).nullable().optional(),
      vence_horas: z.number().int().min(0).max(24 * 365).nullable().optional(),
    }),
  ]),
});

crmProcesoRouter.post("/sucursales/:id/crm/masivo", async (req, res, next) => {
  const parsed = masivoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const accion = parsed.data.accion;
    const r = await ejecutarAccionMasiva({
      sucursalId: req.params.id,
      ids: parsed.data.ids,
      restringidoA: restringidoA(req),
      usuarioId: req.usuario?.id,
      accion,
    });
    if ("error" in r) {
      res.status(400).json({ error: r.error });
      return;
    }
    emitirBroadcast(`datos:${req.params.id}`, "refresh", {});
    if (parsed.data.accion.accion !== "etapa") emitirBroadcast(`datos:${req.params.id}`, "tareas", {});
    res.json(r);
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   Vistas guardadas
   ============================================================ */

crmProcesoRouter.get("/sucursales/:id/crm/vistas", async (req, res, next) => {
  try {
    if (!req.usuario) return;
    res.json({ vistas: await listarVistas(req.params.id, req.usuario.id) });
  } catch (err) {
    next(err);
  }
});

const vistaSchema = z.object({
  nombre: z.string().trim().min(1, "Ponle un nombre a la vista.").max(60),
  compartida: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).refine((c) => JSON.stringify(c).length < 20000, "La vista es demasiado grande."),
});

crmProcesoRouter.post("/sucursales/:id/crm/vistas", async (req, res, next) => {
  const parsed = vistaSchema.safeParse(req.body);
  if (!parsed.success || !req.usuario) {
    res.status(400).json({ error: parsed.success ? "Sesión requerida." : (parsed.error.issues[0]?.message ?? "Datos inválidos.") });
    return;
  }
  try {
    // Solo el admin comparte vistas con toda la sucursal.
    const compartida = parsed.data.compartida && req.perfil?.rol === "admin";
    const r = await guardarVista({ sucursalId: req.params.id, usuarioId: req.usuario.id, nombre: parsed.data.nombre, config: parsed.data.config, compartida });
    if ("error" in r) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

crmProcesoRouter.delete("/sucursales/:id/crm/vistas/:vid", async (req, res, next) => {
  try {
    if (!req.usuario) return;
    const ok = await borrarVista(req.params.id, req.params.vid, req.usuario.id, req.perfil?.rol === "admin");
    if (!ok) {
      res.status(404).json({ error: "Vista no encontrada." });
      return;
    }
    res.json({ eliminada: true });
  } catch (err) {
    next(err);
  }
});
