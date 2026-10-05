import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { guardarSeguimientos, leerSeguimientos } from "../lib/seguimientos.js";

/** Seguimientos después del primer contacto automático de una campaña (solo el admin de la sucursal). */
export const crmSeguimientosRouter = Router();

crmSeguimientosRouter.use(requireAuth);
crmSeguimientosRouter.use("/sucursales/:id/crm/seguimientos", requireAccesoSucursal, requireAdminSucursal);

crmSeguimientosRouter.get("/sucursales/:id/crm/seguimientos", async (req, res, next) => {
  try {
    res.json(await leerSeguimientos(req.params.id));
  } catch (err) {
    next(err);
  }
});

const condicionSchema = z.object({
  campo: z.string().min(1).max(60),
  operador: z.enum(["igual", "distinto", "contiene", "vacio", "no_vacio", "mayor", "menor"]),
  valor: z.string().max(200).default(""),
});

const seguimientoSchema = z.object({
  id: z.string().uuid().optional(),
  campana: z.string().regex(/^[A-Za-z0-9_]{1,30}$/, "Campaña inválida."),
  nombre: z.string().trim().min(1, "Cada seguimiento necesita un nombre.").max(80),
  activa: z.boolean(),
  desde: z.enum(["primer_envio", "ultimo_envio"]),
  espera_horas: z.number().int().min(0).max(8760),
  accion: z.enum(["tarea", "llamada", "whatsapp"]),
  condiciones: z.array(condicionSchema).max(8, "Máximo 8 condiciones por seguimiento."),
  titulo: z.string().trim().max(160).nullable(),
  descripcion: z.string().trim().max(1000).nullable(),
  vence_horas: z.number().int().min(0).max(8760).nullable(),
  hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  plantilla_id: z.string().uuid().nullable(),
  vigencia_horas: z.number().int().min(1, "La vigencia debe ser de al menos 1 hora.").max(1440),
});

const guardarSchema = z.object({ seguimientos: z.array(seguimientoSchema).max(40, "Máximo 40 seguimientos.") });

crmSeguimientosRouter.put("/sucursales/:id/crm/seguimientos", async (req, res, next) => {
  const parsed = guardarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarSeguimientos(req.params.id, parsed.data.seguimientos);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});
