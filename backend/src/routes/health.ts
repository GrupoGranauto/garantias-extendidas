import { Router } from "express";
import { flags } from "../config/env.js";
import { pingSupabase } from "../lib/supabase.js";
import { pingBigQuery } from "../lib/bigquery.js";
import { requireAuth } from "../middleware/auth.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    configurado: flags,
  });
});

// Prueba real de conexion contra ambos servicios
healthRouter.get("/conexiones", async (_req, res) => {
  const [supabase, bigquery] = await Promise.all([
    flags.supabase ? pingSupabase() : Promise.resolve({ ok: false, detail: "sin configurar" }),
    flags.bigquery ? pingBigQuery() : Promise.resolve({ ok: false, detail: "sin configurar" }),
  ]);
  res.json({ supabase, bigquery });
});

// Comprueba que el JWT que manda el frontend es valido
healthRouter.get("/yo", requireAuth, (req, res) => {
  res.json({
    id: req.usuario!.id,
    email: req.usuario!.email,
    proveedor: req.usuario!.app_metadata?.provider,
  });
});
