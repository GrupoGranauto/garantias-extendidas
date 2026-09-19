import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import { requireApiKeyEntidad } from "../middleware/apiKeyEntidad.js";
import { construirValores, insertarRegistro, insertarRegistrosLote, type CampoEntidad } from "../lib/entidades.js";

export const entidadesIngestaRouter = Router();

entidadesIngestaRouter.use("/:sucursalId", requireApiKeyEntidad);

const LIMITE_LOTE = 5000;

async function obtenerEntidad(sucursalId: string) {
  const supabase = getSupabase();

  const { data: sucursal, error: errorSucursal } = await supabase
    .from("sucursales")
    .select("subdominio")
    .eq("id", sucursalId)
    .maybeSingle();
  if (errorSucursal) throw new Error(errorSucursal.message);
  if (!sucursal) return null;

  const { data: definicion, error: errorDefinicion } = await supabase
    .from("entidad_definiciones")
    .select("id, nombre_tecnico")
    .eq("sucursal_id", sucursalId)
    .maybeSingle();
  if (errorDefinicion) throw new Error(errorDefinicion.message);
  if (!definicion) return null;

  const { data: campos, error: errorCampos } = await supabase
    .from("entidad_campos")
    .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen")
    .eq("entidad_id", definicion.id);
  if (errorCampos) throw new Error(errorCampos.message);

  return { subdominio: sucursal.subdominio as string, nombreTabla: definicion.nombre_tecnico as string, campos: (campos ?? []) as CampoEntidad[] };
}

/** Inserta un registro en la tabla generada de la sucursal. */
entidadesIngestaRouter.post("/:sucursalId/registros", async (req, res, next) => {
  try {
    const entidad = await obtenerEntidad(req.params.sucursalId);
    if (!entidad) {
      res.status(404).json({ error: "Esta sucursal aún no tiene una entidad definida." });
      return;
    }

    const cuerpo = (req.body ?? {}) as Record<string, unknown>;
    const resultado = construirValores(entidad.campos, cuerpo);
    if ("error" in resultado) {
      res.status(400).json({ error: resultado.error });
      return;
    }

    const id = await insertarRegistro(entidad.subdominio, entidad.nombreTabla, resultado.valores);
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

/** Inserta muchos registros en una sola transacción (hasta 5000 por llamada). */
entidadesIngestaRouter.post("/:sucursalId/registros/lote", async (req, res, next) => {
  try {
    const entidad = await obtenerEntidad(req.params.sucursalId);
    if (!entidad) {
      res.status(404).json({ error: "Esta sucursal aún no tiene una entidad definida." });
      return;
    }

    const registros = req.body;
    if (!Array.isArray(registros)) {
      res.status(400).json({ error: "El cuerpo debe ser un arreglo de registros." });
      return;
    }
    if (registros.length === 0) {
      res.status(400).json({ error: "El lote está vacío." });
      return;
    }
    if (registros.length > LIMITE_LOTE) {
      res.status(400).json({ error: `El lote admite hasta ${LIMITE_LOTE} registros por llamada.` });
      return;
    }

    const listaValores: Record<string, unknown>[] = [];
    for (let i = 0; i < registros.length; i++) {
      const resultado = construirValores(entidad.campos, (registros[i] ?? {}) as Record<string, unknown>);
      if ("error" in resultado) {
        res.status(400).json({ error: `Registro ${i}: ${resultado.error}` });
        return;
      }
      listaValores.push(resultado.valores);
    }

    const ids = await insertarRegistrosLote(entidad.subdominio, entidad.nombreTabla, listaValores);
    res.status(201).json({ total: ids.length, ids });
  } catch (err) {
    next(err);
  }
});
