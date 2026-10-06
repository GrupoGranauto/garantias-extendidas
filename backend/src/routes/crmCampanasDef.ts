import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { calcularYGuardar, guardarCampanasDef, leerCampanasDef, probarCampanas } from "../lib/campanasDefinidas.js";

/** Campañas que define el admin de la sucursal (por días o por meses) y su cálculo diario. */
export const crmCampanasDefRouter = Router();

crmCampanasDefRouter.use(requireAuth);
crmCampanasDefRouter.use("/sucursales/:id/crm/campanas-def", requireAccesoSucursal, requireAdminSucursal);

crmCampanasDefRouter.get("/sucursales/:id/crm/campanas-def", async (req, res, next) => {
  try {
    res.json(await leerCampanasDef(req.params.id));
  } catch (err) {
    next(err);
  }
});

const defSchema = z.object({
  nombre: z.string().trim().min(1, "Cada campaña necesita un nombre.").max(30, "El nombre puede tener hasta 30 caracteres."),
  tipo: z.enum(["dias", "meses"]),
  columna_fecha: z.enum(["fecha_factura", "fecha_reporte"]),
  dias_desde: z.number().int().min(0).max(3650).nullable(),
  dias_hasta: z.number().int().min(1).max(3650).nullable(),
  meses_atras: z.number().int().min(0).max(120).nullable(),
  dia_envio: z.number().int().min(1).max(28).nullable(),
  hora_envio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  etapa_orden: z.number().int().min(1).max(10).nullable(),
  activa: z.boolean(),
});

const guardarSchema = z.object({
  campanas: z.array(defSchema).max(20, "Máximo 20 campañas."),
  hora_calculo: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "La hora del cálculo no es válida (HH:MM)."),
});

crmCampanasDefRouter.put("/sucursales/:id/crm/campanas-def", async (req, res, next) => {
  const parsed = guardarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarCampanasDef(req.params.id, parsed.data.campanas, parsed.data.hora_calculo);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ guardado: true, ...r.calculo });
  } catch (err) {
    next(err);
  }
});

crmCampanasDefRouter.post("/sucursales/:id/crm/campanas-def/calcular", async (req, res, next) => {
  try {
    res.json(await calcularYGuardar(req.params.id, "manual"));
  } catch (err) {
    next(err);
  }
});

const probarSchema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Escribe una fecha."),
  etapa_orden: z.number().int().min(1).max(10).nullable().default(null),
});

crmCampanasDefRouter.post("/sucursales/:id/crm/campanas-def/probar", async (req, res, next) => {
  const parsed = probarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    res.json(await probarCampanas(req.params.id, parsed.data.fecha, parsed.data.etapa_orden));
  } catch (err) {
    next(err);
  }
});
