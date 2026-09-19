import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

export const adminWhatsappRouter = Router();

// Todo lo de aquí exige sesión con rol admin
adminWhatsappRouter.use(requireAuth, requireAdmin);

const configSchema = z.object({
  waba_id: z.string().trim().nullable().optional(),
  phone_number_id: z.string().trim().min(1).nullable().optional(),
  numero_telefono: z.string().trim().nullable().optional(),
  webhook_verify_token: z.string().trim().nullable().optional(),
  // Los secretos solo se mandan cuando se quieren reemplazar; si no vienen,
  // se conserva lo que ya había guardado.
  access_token: z.string().trim().min(1).optional(),
  app_secret: z.string().trim().min(1).optional(),
  activo: z.boolean().optional(),
});

/**
 * Configuración de WhatsApp de una sucursal, sin los secretos.
 * `tiene_access_token` / `tiene_app_secret` le dicen al frontend si ya hay
 * algo guardado, sin revelar el valor.
 */
adminWhatsappRouter.get("/sucursales/:id/whatsapp", async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("whatsapp_config")
      .select("id, waba_id, phone_number_id, numero_telefono, webhook_verify_token, activo, access_token, app_secret")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();

    if (error) throw new Error(error.message);

    if (!data) {
      res.json({ configurado: false });
      return;
    }

    const { access_token, app_secret, ...visible } = data;
    res.json({
      configurado: true,
      ...visible,
      tiene_access_token: Boolean(access_token),
      tiene_app_secret: Boolean(app_secret),
    });
  } catch (err) {
    next(err);
  }
});

/** Crea o actualiza la configuración. Nunca borra un secreto por omisión. */
adminWhatsappRouter.put("/sucursales/:id/whatsapp", async (req, res, next) => {
  const parsed = configSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const supabase = getSupabase();
    const sucursalId = req.params.id;

    const { data: existente } = await supabase
      .from("whatsapp_config")
      .select("id")
      .eq("sucursal_id", sucursalId)
      .maybeSingle();

    const cambios = { ...parsed.data, sucursal_id: sucursalId };

    const { error } = existente
      ? await supabase.from("whatsapp_config").update(cambios).eq("id", existente.id)
      : await supabase.from("whatsapp_config").insert(cambios);

    if (error) {
      const codigo = (error as { code?: string }).code;
      const mensaje =
        codigo === "23505" ? "Ese Phone Number ID ya está en uso por otra sucursal." : error.message;
      res.status(400).json({ error: mensaje });
      return;
    }

    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});
