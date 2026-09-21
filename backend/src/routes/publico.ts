import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { extraerSubdominio, subdominioValido } from "../lib/subdominio.js";
import { origenPermitido } from "../lib/origenes.js";
import { enviarCorreoRecuperacion } from "../lib/correo.js";

export const publicoRouter = Router();

/**
 * Marca del portal, sin sesión: la pantalla de acceso la necesita antes de
 * que nadie haya iniciado sesión.
 *
 * Devuelve solo lo que se pinta. El resto de la fila —y la existencia de las
 * demás sucursales— no sale de aquí.
 */
publicoRouter.get("/sucursal", async (req, res, next) => {
  // En producción manda el host; en desarrollo se puede forzar con ?sucursal=
  const forzado = typeof req.query.sucursal === "string" ? req.query.sucursal : null;
  const subdominio = forzado ?? extraerSubdominio(req.headers.host);

  // "panel" es la etiqueta reservada del panel genérico: mismo caso
  // que el dominio raíz, útil para probarlo en local con ?sucursal=panel
  if (!subdominio || subdominio === "panel") {
    res.json({ portal: null }); // dominio raíz: pantalla genérica
    return;
  }

  if (!subdominioValido(subdominio)) {
    res.status(400).json({ error: "Subdominio con formato inválido." });
    return;
  }

  try {
    const { data, error } = await getSupabase()
      .from("sucursales")
      .select(
        "id, subdominio, nombre, color, logo_url, logo_panel_url, imagen_acceso_url, activa, login_google, mensaje_cerrado",
      )
      .eq("subdominio", subdominio)
      .maybeSingle();

    if (error) throw new Error(error.message);

    if (!data) {
      res.status(404).json({ error: "Portal no encontrado.", subdominio });
      return;
    }

    res.json({
      portal: {
        id: data.id,
        subdominio: data.subdominio,
        nombre: data.nombre,
        color: data.color,
        logo: data.logo_url,
        logoPanel: data.logo_panel_url,
        imagenAcceso: data.imagen_acceso_url,
        activa: data.activa,
        // Si está cerrada no tiene caso ofrecer métodos de entrada
        loginGoogle: data.activa && data.login_google,
        mensajeCerrado: data.activa ? null : data.mensaje_cerrado,
      },
    });
  } catch (err) {
    next(err);
  }
});

const recuperarSchema = z.object({
  correo: z.string().email().transform((v) => v.trim().toLowerCase()),
  // El portal desde el que se pidió, para regresar ahí (cada sucursal tiene el suyo).
  origen: z.string().url(),
});

/**
 * Pide el link de recuperación de contraseña. Manda un correo propio (con
 * nuestro diseño) en vez de dejar que Supabase mande el suyo por su cuenta,
 * en inglés y sin poder personalizarlo sin plan de pago.
 *
 * Responde igual exista o no la cuenta: nunca revela qué correos están
 * dados de alta. Cualquier falla (SMTP caído, correo inexistente) se
 * absorbe aquí, no llega al cliente.
 */
publicoRouter.post("/recuperar", async (req, res, next) => {
  const parsed = recuperarSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }

  const { correo, origen } = parsed.data;

  try {
    if (!origenPermitido(origen)) {
      res.json({ ok: true });
      return;
    }

    const supabase = getSupabase();

    const { data: perfil } = await supabase.from("usuarios").select("nombre").eq("correo", correo).maybeSingle();

    const resultado = await supabase.auth.admin.generateLink({
      type: "recovery",
      email: correo,
      options: { redirectTo: `${origen}/restablecer` },
    });

    const actionLink = resultado.data?.properties?.action_link;
    if (!resultado.error && actionLink) {
      await enviarCorreoRecuperacion({ destino: correo, nombre: perfil?.nombre ?? null, actionLink });
    }
  } catch (err) {
    console.error("Error enviando correo de recuperación:", err);
  }

  res.json({ ok: true });
});
