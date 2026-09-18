import type { NextFunction, Request, Response } from "express";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: User;
    }
  }
}

function extraerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Exige un JWT de Supabase válido.
 * El token lo firma Supabase; aquí solo se valida contra el servidor de auth.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extraerToken(req);

  if (!token) {
    res.status(401).json({ error: "Falta el token de acceso." });
    return;
  }

  try {
    const { data, error } = await getSupabase().auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ error: "Sesión inválida o expirada." });
      return;
    }

    req.usuario = data.user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Adjunta el usuario si hay token válido, pero no bloquea si no lo hay. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extraerToken(req);
  if (!token) return next();

  try {
    const { data } = await getSupabase().auth.getUser(token);
    if (data.user) req.usuario = data.user;
  } catch {
    // token basura: sigue como anónimo
  }
  next();
}

/** Exige que el usuario tenga rol 'admin' en public.usuarios. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.usuario) {
    res.status(401).json({ error: "Sesión requerida." });
    return;
  }

  try {
    const { data, error } = await getSupabase()
      .from("usuarios")
      .select("rol, activo")
      .eq("id", req.usuario.id)
      .single();

    if (error || !data) {
      res.status(403).json({ error: "Perfil no encontrado." });
      return;
    }
    if (!data.activo) {
      res.status(403).json({ error: "Cuenta desactivada." });
      return;
    }
    if (data.rol !== "admin") {
      res.status(403).json({ error: "Requiere rol de administrador." });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
