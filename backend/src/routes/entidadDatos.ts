import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAccesoSucursal } from "../middleware/auth.js";
import { listarRegistros, type CampoEntidad } from "../lib/entidades.js";

export const entidadDatosRouter = Router();

entidadDatosRouter.use(requireAuth);
// Cuelga de /sucursales/:id/entidad/registros: aquí ya hay req.params.id.
entidadDatosRouter.use("/sucursales/:id/entidad/registros", requireAccesoSucursal);

const LIMITE_MAXIMO = 200;

/**
 * Lectura de los datos de la entidad de la sucursal, para su propio portal.
 * A diferencia de /admin/sucursales/:id/entidad (solo administrador de
 * plataforma, define la estructura), esto lo puede ver cualquiera de la
 * sucursal — es su información, no la de otra.
 */
entidadDatosRouter.get("/sucursales/:id/entidad/registros", async (req, res, next) => {
  try {
    const supabase = getSupabase();

    const { data: sucursal, error: errorSucursal } = await supabase
      .from("sucursales")
      .select("subdominio")
      .eq("id", req.params.id)
      .maybeSingle();
    if (errorSucursal) throw new Error(errorSucursal.message);
    if (!sucursal) {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }

    const { data: definicion, error: errorDefinicion } = await supabase
      .from("entidad_definiciones")
      .select("id, nombre_tecnico, nombre_visible")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (errorDefinicion) throw new Error(errorDefinicion.message);

    if (!definicion) {
      res.json({ configurado: false });
      return;
    }

    const { data: camposFilas, error: errorCampos } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen, posicion")
      .eq("entidad_id", definicion.id)
      .order("posicion");
    if (errorCampos) throw new Error(errorCampos.message);

    const campos = (camposFilas ?? []) as CampoEntidad[];

    const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), LIMITE_MAXIMO);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const desplazamiento = (pagina - 1) * limite;

    const { filas, total } = await listarRegistros(sucursal.subdominio, definicion.nombre_tecnico, campos, limite, desplazamiento);

    res.json({
      configurado: true,
      nombre_visible: definicion.nombre_visible,
      campos,
      filas,
      total,
      pagina,
      limite,
    });
  } catch (err) {
    next(err);
  }
});
