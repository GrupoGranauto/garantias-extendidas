import type { NextFunction, Request, Response } from "express";
import { getSupabase } from "../lib/supabase.js";
import { hashDeApiKey } from "../lib/apiKeyEntidad.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sucursalIdEntidad?: string;
    }
  }
}

/**
 * Autentica las rutas de ingesta de datos con la API key propia de la
 * sucursal (header X-Api-Key), no con el JWT de un usuario. La key nunca se
 * guarda en texto plano: se compara por su hash.
 */
export async function requireApiKeyEntidad(req: Request, res: Response, next: NextFunction) {
  const presentada = req.header("x-api-key")?.trim();

  if (!presentada) {
    res.status(401).json({ error: "Falta el header X-Api-Key." });
    return;
  }

  try {
    const { data, error } = await getSupabase()
      .from("entidad_api_keys")
      .select("sucursal_id")
      .eq("key_hash", hashDeApiKey(presentada))
      .maybeSingle();

    if (error) throw new Error(error.message);

    if (!data) {
      res.status(401).json({ error: "La API key no es válida." });
      return;
    }

    // Defensa en profundidad: una key nunca debe escribir en una sucursal
    // distinta a la nombrada en la ruta, aunque el id no sea secreto.
    if (data.sucursal_id !== req.params.sucursalId) {
      res.status(403).json({ error: "La API key no pertenece a esta sucursal." });
      return;
    }

    req.sucursalIdEntidad = data.sucursal_id;
    next();
  } catch (err) {
    next(err);
  }
}
