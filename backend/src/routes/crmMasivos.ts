import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { exigirUuid } from "../lib/permisos.js";
import {
  crearMasivo,
  destinatariosMasivo,
  detenerMasivo,
  guardarReglas,
  listarMasivos,
  opcionesMasivo,
  reglasDePlantillas,
  revisarMasivo,
} from "../lib/masivos.js";
import { MAX_DESTINATARIOS } from "../lib/masivosLogica.js";
import { guardarPrimerMensaje, leerPrimerMensaje } from "../lib/primerMensaje.js";
import { guardarSinRespuesta, leerSinRespuesta } from "../lib/sinRespuesta.js";
import { INTENTOS_MAXIMOS } from "../lib/sinRespuestaLogica.js";
import { guardarSeguimiento, leerSeguimiento } from "../lib/seguimiento.js";
import { ESPERA_MAXIMA_HORAS } from "../lib/seguimientoLogica.js";

/** Masivos manuales de WhatsApp: solo el admin del grupo los ve y los manda. */
export const crmMasivosRouter = Router();

crmMasivosRouter.use(requireAuth);
crmMasivosRouter.use("/sucursales/:id/crm/masivos", requireAccesoSucursal, requireAdminSucursal);
exigirUuid(crmMasivosRouter, "mid", "pid");

const envioSchema = z.object({
  ids: z
    .array(z.string().uuid())
    .min(1, "Elige al menos una fila.")
    .max(MAX_DESTINATARIOS, `Un masivo puede llevar hasta ${MAX_DESTINATARIOS.toLocaleString("es-MX")} filas.`),
  plantilla_id: z.string().uuid("Elige una plantilla."),
});

crmMasivosRouter.get("/sucursales/:id/crm/masivos", async (req, res, next) => {
  try {
    res.json({ masivos: await listarMasivos(req.params.id) });
  } catch (err) {
    next(err);
  }
});

const idsSchema = z.object({ ids: z.array(z.string().uuid()).max(MAX_DESTINATARIOS) });

/** Para la ventana de envío: plantillas con sus reglas, campañas del filtro rápido y estados del lead. */
crmMasivosRouter.post("/sucursales/:id/crm/masivos/opciones", async (req, res, next) => {
  const parsed = idsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    res.json(await opcionesMasivo(req.params.id, parsed.data.ids));
  } catch (err) {
    next(err);
  }
});

/** Para la pantalla Plantillas: a quién se le puede mandar cada una. */
crmMasivosRouter.get("/sucursales/:id/crm/masivos/reglas", async (req, res, next) => {
  try {
    res.json(await reglasDePlantillas(req.params.id));
  } catch (err) {
    next(err);
  }
});

const lista = (max: number) => z.array(z.string().trim().min(1).max(80)).max(max);
const reglasSchema = z.object({
  campanas: lista(30),
  estados: z.array(z.string().uuid()).max(30),
  resultados: lista(30),
  etapas_vehiculo: z.array(z.string().uuid()).max(30),
});

crmMasivosRouter.put("/sucursales/:id/crm/masivos/plantillas/:pid/reglas", async (req, res, next) => {
  const parsed = reglasSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarReglas(req.params.id, req.params.pid, parsed.data);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

crmMasivosRouter.post("/sucursales/:id/crm/masivos/revisar", async (req, res, next) => {
  const parsed = envioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await revisarMasivo(req.params.id, parsed.data.ids, parsed.data.plantilla_id);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json(r.valor);
  } catch (err) {
    next(err);
  }
});

crmMasivosRouter.post("/sucursales/:id/crm/masivos", async (req, res, next) => {
  const parsed = envioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await crearMasivo(req.params.id, parsed.data.ids, parsed.data.plantilla_id, req.usuario?.id ?? null);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.status(201).json(r.valor);
  } catch (err) {
    next(err);
  }
});

/** Primer mensaje automático por campaña: su configuración, cuántos esperan y cómo le fue la última vez. */
crmMasivosRouter.get("/sucursales/:id/crm/masivos/primer-mensaje", async (req, res, next) => {
  try {
    res.json(await leerPrimerMensaje(req.params.id));
  } catch (err) {
    next(err);
  }
});

const primerMensajeSchema = z.object({
  activa: z.boolean(),
  plantilla_id: z.string().uuid().nullable(),
  dias_semana: z.array(z.number().int().min(1).max(7)).max(7),
  hora: z.string().regex(/^\d{2}:\d{2}$/, "La hora no es válida."),
  telefonos_prueba: z.array(z.string().trim().max(20)).max(10).default([]),
});

crmMasivosRouter.put("/sucursales/:id/crm/masivos/primer-mensaje/:campana", async (req, res, next) => {
  const parsed = primerMensajeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarPrimerMensaje(req.params.id, req.params.campana, parsed.data, req.usuario?.id ?? null);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json(await leerPrimerMensaje(req.params.id));
  } catch (err) {
    next(err);
  }
});

/** Mensaje por llamadas sin respuesta, por campaña: su configuración y cuántos leads ya llegaron al número de llamadas. */
crmMasivosRouter.get("/sucursales/:id/crm/masivos/sin-respuesta", async (req, res, next) => {
  try {
    res.json(await leerSinRespuesta(req.params.id));
  } catch (err) {
    next(err);
  }
});

const sinRespuestaSchema = z.object({
  activa: z.boolean(),
  plantilla_id: z.string().uuid().nullable(),
  intentos: z.number().int().min(1, `El número de llamadas va de 1 a ${INTENTOS_MAXIMOS}.`).max(INTENTOS_MAXIMOS, `El número de llamadas va de 1 a ${INTENTOS_MAXIMOS}.`),
  resultados: z.array(z.string().trim().max(40)).max(20),
  telefonos_prueba: z.array(z.string().trim().max(20)).max(10).default([]),
});

crmMasivosRouter.put("/sucursales/:id/crm/masivos/sin-respuesta/:campana", async (req, res, next) => {
  const parsed = sinRespuestaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarSinRespuesta(req.params.id, req.params.campana, parsed.data, req.usuario?.id ?? null);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json(await leerSinRespuesta(req.params.id));
  } catch (err) {
    next(err);
  }
});

/** Seguimiento de leads «Contactado», por campaña: su configuración y cuántos esperan o ya les toca. */
crmMasivosRouter.get("/sucursales/:id/crm/masivos/seguimiento", async (req, res, next) => {
  try {
    res.json(await leerSeguimiento(req.params.id));
  } catch (err) {
    next(err);
  }
});

const seguimientoSchema = z.object({
  activa: z.boolean(),
  plantilla_id: z.string().uuid().nullable(),
  espera_horas: z
    .number()
    .int("El tiempo de espera va en horas completas.")
    .min(1, `El tiempo de espera va de 1 hora a ${ESPERA_MAXIMA_HORAS / 24} días.`)
    .max(ESPERA_MAXIMA_HORAS, `El tiempo de espera va de 1 hora a ${ESPERA_MAXIMA_HORAS / 24} días.`),
  telefonos_prueba: z.array(z.string().trim().max(20)).max(10).default([]),
});

crmMasivosRouter.put("/sucursales/:id/crm/masivos/seguimiento/:campana", async (req, res, next) => {
  const parsed = seguimientoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarSeguimiento(req.params.id, req.params.campana, parsed.data, req.usuario?.id ?? null);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json(await leerSeguimiento(req.params.id));
  } catch (err) {
    next(err);
  }
});

crmMasivosRouter.get("/sucursales/:id/crm/masivos/:mid/destinatarios", async (req, res, next) => {
  try {
    res.json({ destinatarios: await destinatariosMasivo(req.params.id, req.params.mid) });
  } catch (err) {
    next(err);
  }
});

crmMasivosRouter.post("/sucursales/:id/crm/masivos/:mid/detener", async (req, res, next) => {
  try {
    const r = await detenerMasivo(req.params.id, req.params.mid);
    if (!r.ok) {
      res.status(409).json({ error: r.error });
      return;
    }
    res.json(r.valor);
  } catch (err) {
    next(err);
  }
});
