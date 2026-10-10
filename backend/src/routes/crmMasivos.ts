import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { exigirUuid } from "../lib/permisos.js";
import { crearMasivo, destinatariosMasivo, detenerMasivo, listarMasivos, plantillasParaMasivo, revisarMasivo } from "../lib/masivos.js";
import { MAX_DESTINATARIOS } from "../lib/masivosLogica.js";

/** Masivos manuales de WhatsApp: solo el admin del grupo los ve y los manda. */
export const crmMasivosRouter = Router();

crmMasivosRouter.use(requireAuth);
crmMasivosRouter.use("/sucursales/:id/crm/masivos", requireAccesoSucursal, requireAdminSucursal);
exigirUuid(crmMasivosRouter, "mid");

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

crmMasivosRouter.get("/sucursales/:id/crm/masivos/plantillas", async (req, res, next) => {
  try {
    res.json({ plantillas: await plantillasParaMasivo(req.params.id) });
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
