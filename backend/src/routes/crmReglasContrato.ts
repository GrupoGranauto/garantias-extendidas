import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { guardarReglasContrato, leerReglasContrato } from "../lib/reglasContrato.js";
import { ESTADOS_CON_REGLA } from "../lib/contratoLogica.js";

/** Reglas del contrato (tareas por tiempo en un estado) y cobertura automática: solo el admin de la sucursal. */
export const crmReglasContratoRouter = Router();

crmReglasContratoRouter.use(requireAuth);
crmReglasContratoRouter.use("/sucursales/:id/crm/contrato-reglas", requireAccesoSucursal, requireAdminSucursal);

crmReglasContratoRouter.get("/sucursales/:id/crm/contrato-reglas", async (req, res, next) => {
  try {
    res.json(await leerReglasContrato(req.params.id));
  } catch (err) {
    next(err);
  }
});

const reglaSchema = z.object({
  id: z.string().uuid().optional(),
  nombre: z.string().trim().min(1, "Cada regla necesita un nombre.").max(80),
  activa: z.boolean(),
  estado: z.enum(ESTADOS_CON_REGLA),
  espera_horas: z.number().int().min(0).max(8760),
  titulo: z.string().trim().min(1, "Escribe el título de la tarea.").max(160),
  descripcion: z.string().trim().max(1000).nullable(),
  vence_horas: z.number().int().min(0).max(8760).nullable(),
});

const guardarSchema = z.object({
  reglas: z.array(reglaSchema).max(20, "Máximo 20 reglas."),
  cobertura_automatica: z.boolean(),
});

crmReglasContratoRouter.put("/sucursales/:id/crm/contrato-reglas", async (req, res, next) => {
  const parsed = guardarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarReglasContrato(req.params.id, parsed.data.reglas, parsed.data.cobertura_automatica);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});
