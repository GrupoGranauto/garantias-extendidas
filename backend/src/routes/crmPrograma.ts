import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { guardarPrograma, leerPrograma } from "../lib/programaGe.js";
import { ESTADOS_MEXICO, PROGRAMA_POR_OMISION } from "../lib/programaGeLogica.js";

/** Programa de garantía extendida de la sucursal (reglas de venta y listas del portal): solo el admin de la sucursal. */
export const crmProgramaRouter = Router();

crmProgramaRouter.use(requireAuth);
crmProgramaRouter.use("/sucursales/:id/crm/programa", requireAccesoSucursal, requireAdminSucursal);

crmProgramaRouter.get("/sucursales/:id/crm/programa", async (req, res, next) => {
  try {
    res.json({ programa: await leerPrograma(req.params.id), por_omision: PROGRAMA_POR_OMISION, estados_mexico: ESTADOS_MEXICO });
  } catch (err) {
    next(err);
  }
});

const enteros = (max: number) => z.array(z.number().int()).max(max);

const programaSchema = z.object({
  nombre: z.string().max(120),
  area_venta: z.string().max(60),
  meses_garantia_original: z.number().int(),
  bandas_km: enteros(6),
  plazos_meses: enteros(10),
  msi_meses: enteros(10),
  liga_pago_horas: z.number().int(),
  estados_circulacion: z.array(z.string().max(60)).max(100),
  vendedores: z.array(z.string().max(120)).max(200),
});

crmProgramaRouter.put("/sucursales/:id/crm/programa", async (req, res, next) => {
  const parsed = programaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    const r = await guardarPrograma(req.params.id, parsed.data);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ guardado: true, programa: r.programa });
  } catch (err) {
    next(err);
  }
});
