import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin, requireAdminPlataforma } from "../middleware/auth.js";
import { sincronizarCrm, type ResumenSync } from "../lib/sincronizacionCrm.js";
import { getPool } from "../lib/db.js";

export const adminCrmRouter = Router();

adminCrmRouter.use(requireAuth, requireAdmin);
adminCrmRouter.all(["/sucursales/:id/crm/sincronizar", "/sucursales/:id/crm/corridas", "/sucursales/:id/crm/provisionar"], requireAdminPlataforma);

const sincronizarSchema = z.object({ aplicar: z.boolean().default(false) });

/**
 * Sincroniza la sucursal desde BigQuery. Sin `aplicar` es una simulación: calcula y
 * reporta el plan (solo conteos) sin escribir datos. Con `aplicar` escribe, en una
 * sola transacción, solo si el plan no tiene conflictos.
 */
adminCrmRouter.post("/sucursales/:id/crm/sincronizar", async (req, res, next) => {
  const parsed = sincronizarSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    const resumen = await sincronizarCrm(req.params.id, parsed.data.aplicar);
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

/** Últimas corridas de sincronización (solo conteos, sin datos de clientes). */
adminCrmRouter.get("/sucursales/:id/crm/corridas", async (req, res, next) => {
  try {
    const { rows } = await getPool().query(
      `SELECT modo, estado, filas_fuente, activas_fuente, nuevas, actualizadas, migradas, cerradas, conflictos, mensaje, creado_en
         FROM crm_sync_corridas WHERE sucursal_id = $1 ORDER BY creado_en DESC LIMIT 20`,
      [req.params.id],
    );
    res.json({ corridas: rows });
  } catch (err) {
    next(err);
  }
});

/** Deja lista para el CRM una sucursal existente que aún no lo tiene (idempotente: no pisa lo que ya hay). */
adminCrmRouter.post("/sucursales/:id/crm/provisionar", async (req, res, next) => {
  try {
    await getPool().query(`SELECT crm_provisionar_sucursal($1)`, [req.params.id]);
    res.json({ listo: true });
  } catch (err) {
    next(err);
  }
});
