import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAccesoSucursal } from "../middleware/auth.js";
import {
  listarRegistros,
  construirValoresEdicion,
  actualizarRegistro,
  leerColumnaDeFila,
  type CampoEntidad,
} from "../lib/entidades.js";

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
      .select("id, nombre_tecnico, nombre_visible, columna_ejecutivo")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (errorDefinicion) throw new Error(errorDefinicion.message);

    if (!definicion) {
      res.json({ configurado: false });
      return;
    }

    const { data: camposFilas, error: errorCampos } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen, posicion, visible, editor_tipo, opciones")
      .eq("entidad_id", definicion.id)
      .order("posicion");
    if (errorCampos) throw new Error(errorCampos.message);

    // El portal de la sucursal solo ve las columnas marcadas como visibles.
    const campos = ((camposFilas ?? []) as CampoEntidad[]).filter((c) => c.visible !== false);

    const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), LIMITE_MAXIMO);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const desplazamiento = (pagina - 1) * limite;

    // Un asesor con ejecutivo asignado solo ve los leads de su ejecutivo; admin, todos.
    const filtro =
      req.perfil &&
      req.perfil.rol !== "admin" &&
      req.perfil.ejecutivo_asignado &&
      definicion.columna_ejecutivo
        ? { columna: definicion.columna_ejecutivo as string, valor: req.perfil.ejecutivo_asignado }
        : undefined;

    const { filas, total } = await listarRegistros(
      sucursal.subdominio,
      definicion.nombre_tecnico,
      campos,
      limite,
      desplazamiento,
      filtro,
    );

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

/**
 * Edita una fila: solo los campos 'back' (los que captura la app). Un asesor con
 * ejecutivo asignado solo puede editar filas de su ejecutivo; el admin, todas.
 */
entidadDatosRouter.patch("/sucursales/:id/entidad/registros/:rowId", async (req, res, next) => {
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

    const { data: definicion, error: errorDef } = await supabase
      .from("entidad_definiciones")
      .select("id, nombre_tecnico, columna_ejecutivo")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (errorDef) throw new Error(errorDef.message);
    if (!definicion) {
      res.status(404).json({ error: "Esta sucursal no tiene una entidad definida." });
      return;
    }

    const { data: camposFilas, error: errorCampos } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen, editor_tipo, opciones")
      .eq("entidad_id", definicion.id);
    if (errorCampos) throw new Error(errorCampos.message);
    const campos = (camposFilas ?? []) as CampoEntidad[];

    const resultado = construirValoresEdicion(campos, (req.body ?? {}) as Record<string, unknown>);
    if ("error" in resultado) {
      res.status(400).json({ error: resultado.error });
      return;
    }

    // Permiso por ejecutivo: el asesor solo edita filas de su ejecutivo.
    if (
      req.perfil &&
      req.perfil.rol !== "admin" &&
      req.perfil.ejecutivo_asignado &&
      definicion.columna_ejecutivo
    ) {
      const dueño = await leerColumnaDeFila(
        sucursal.subdominio,
        definicion.nombre_tecnico,
        req.params.rowId,
        definicion.columna_ejecutivo as string,
      );
      if (dueño === undefined) {
        res.status(404).json({ error: "Registro no encontrado." });
        return;
      }
      if (dueño !== req.perfil.ejecutivo_asignado) {
        res.status(403).json({ error: "No puedes editar un registro de otro ejecutivo." });
        return;
      }
    }

    const ok = await actualizarRegistro(
      sucursal.subdominio,
      definicion.nombre_tecnico,
      req.params.rowId,
      resultado.valores,
    );
    if (!ok) {
      res.status(404).json({ error: "Registro no encontrado." });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
