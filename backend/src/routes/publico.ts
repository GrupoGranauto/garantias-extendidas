import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import { extraerSubdominio, subdominioValido } from "../lib/subdominio.js";

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

  // "autoinsights" es la etiqueta reservada del panel genérico: mismo caso
  // que el dominio raíz, útil para probarlo en local con ?sucursal=autoinsights
  if (!subdominio || subdominio === "autoinsights") {
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
