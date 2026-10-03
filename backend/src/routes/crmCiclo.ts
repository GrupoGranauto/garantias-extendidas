import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { guardarCiclo, leerCiclo, probarEtapa } from "../lib/cicloVehiculo.js";
import { emitirBroadcast } from "../lib/realtime.js";

/** Etapas del vehículo (por fecha y kilometraje): las define el admin de la sucursal. */
export const crmCicloRouter = Router();

crmCicloRouter.use(requireAuth);
crmCicloRouter.use("/sucursales/:id/crm/ciclo", requireAccesoSucursal, requireAdminSucursal);

crmCicloRouter.get("/sucursales/:id/crm/ciclo", async (req, res, next) => {
  try {
    res.json(await leerCiclo(req.params.id));
  } catch (err) {
    next(err);
  }
});

const etapaSchema = z.object({
  nombre: z.string().trim().min(1, "Cada etapa necesita un nombre.").max(60),
  meses_desde: z.number().int().min(0).max(600),
  meses_hasta: z.number().int().min(0).max(600),
  km_max: z.number().int().min(1, "El kilometraje máximo debe ser mayor a 0.").max(5_000_000),
});

const cicloSchema = z.object({
  columna_fecha: z.string().min(1).max(40),
  etapas: z.array(etapaSchema).min(1, "Define al menos una etapa.").max(10, "Máximo 10 etapas."),
});

crmCicloRouter.put("/sucursales/:id/crm/ciclo", async (req, res, next) => {
  const parsed = cicloSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarCiclo(req.params.id, parsed.data.columna_fecha, parsed.data.etapas);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    emitirBroadcast(`datos:${req.params.id}`, "refresh", {});
    res.json({ guardado: true, revisados: r.revisados, cambiaron: r.cambiaron });
  } catch (err) {
    next(err);
  }
});

const probarSchema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  km: z.number().int().min(0).max(5_000_000).nullable().default(null),
});

crmCicloRouter.post("/sucursales/:id/crm/ciclo/probar", async (req, res, next) => {
  const parsed = probarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    res.json(await probarEtapa(req.params.id, parsed.data.fecha, parsed.data.km));
  } catch (err) {
    next(err);
  }
});
