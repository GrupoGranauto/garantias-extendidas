import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import { query } from "../lib/bigquery.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";

export const garantiasRouter = Router();

// Todo lo de aqui exige sesion
garantiasRouter.use(requireAuth);

/**
 * Ejemplo Supabase: lista de polizas.
 * Ajusta el nombre de la tabla cuando exista el esquema.
 */
garantiasRouter.get("/", async (req, res, next) => {
  try {
    const limite = Number(req.query.limite ?? 50);
    const { data, error } = await getSupabase()
      .from("garantias")
      .select("*")
      .limit(limite);

    if (error) throw new Error(error.message);
    res.json({ total: data?.length ?? 0, data });
  } catch (err) {
    next(err);
  }
});

/**
 * Ejemplo BigQuery: resumen por periodo y tipo de poliza (GN / GI).
 */
garantiasRouter.get("/resumen", async (req, res, next) => {
  try {
    const anio = Number(req.query.anio ?? new Date().getFullYear());
    const tabla = `\`${env.BIGQUERY_PROJECT_ID}.${env.BIGQUERY_DATASET}.garantias\``;

    const rows = await query(
      `SELECT periodo, tip_ncc, COUNT(*) AS polizas, SUM(importe) AS importe
         FROM ${tabla}
        WHERE anio = @anio
        GROUP BY periodo, tip_ncc
        ORDER BY periodo`,
      { anio },
    );

    res.json({ anio, rows });
  } catch (err) {
    next(err);
  }
});
