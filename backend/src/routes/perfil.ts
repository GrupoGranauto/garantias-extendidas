import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const perfilRouter = Router();

/**
 * El propio usuario, sin exigir rol admin: el panel lo usa para decidir qué
 * mostrar apenas hay sesión (panel de plataforma vs. portal de sucursal).
 * Nunca revela nada de otra cuenta: siempre es la fila del token.
 */
perfilRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("usuarios")
      .select("id, correo, nombre, puesto, foto_url, rol, sucursal_id, activo")
      .eq("id", req.usuario!.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ error: "Perfil no encontrado." });
      return;
    }

    let sucursal: { id: string; nombre: string; color: string; logo_url: string | null } | null = null;
    if (data.sucursal_id) {
      const { data: fila } = await getSupabase()
        .from("sucursales")
        .select("id, nombre, color, logo_url")
        .eq("id", data.sucursal_id)
        .maybeSingle();
      sucursal = fila ?? null;
    }

    res.json({ ...data, sucursal });
  } catch (err) {
    next(err);
  }
});
