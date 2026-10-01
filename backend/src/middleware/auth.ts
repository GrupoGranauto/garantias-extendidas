import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getSupabase } from "../lib/supabase.js";
import { env } from "../config/env.js";

type UsuarioSesion = { id: string; email?: string; app_metadata?: Record<string, unknown> };

type PerfilSesion = {
  rol: string;
  sucursal_id: string | null;
  ejecutivo_asignado: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: UsuarioSesion;
      // Perfil de public.usuarios, lo adjunta requireAccesoSucursal.
      perfil?: PerfilSesion;
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
 * El proyecto firma sesiones con las JWT Signing Keys nuevas de Supabase
 * (asimétricas, ES256), no con el legacy JWT secret (HS256). createRemoteJWKSet
 * cachea la clave pública en memoria del proceso: solo la primera verificación
 * pega a la red, el resto es verificación local. Eso evita el round-trip que
 * antes hacía auth.getUser() en cada request autenticada.
 */
const JWKS = env.SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

async function verificarTokenLocal(token: string): Promise<UsuarioSesion | null> {
  if (!JWKS) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS);
    if (typeof payload.sub !== "string") return null;
    return {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      app_metadata: (payload.app_metadata as Record<string, unknown> | undefined) ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Round-trip contra Supabase Auth: sin JWKS disponible, o el verify local falló. */
async function verificarTokenRemoto(token: string): Promise<UsuarioSesion | null> {
  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email, app_metadata: data.user.app_metadata };
}

async function resolverUsuario(token: string): Promise<UsuarioSesion | null> {
  const local = await verificarTokenLocal(token);
  if (local) return local;
  return verificarTokenRemoto(token);
}

/** Exige un JWT de Supabase válido. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extraerToken(req);

  if (!token) {
    res.status(401).json({ error: "Falta el token de acceso." });
    return;
  }

  try {
    const usuario = await resolverUsuario(token);
    if (!usuario) {
      res.status(401).json({ error: "Sesión inválida o expirada." });
      return;
    }

    req.usuario = usuario;
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
    const usuario = await resolverUsuario(token);
    if (usuario) req.usuario = usuario;
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

/**
 * Exige que la cuenta pertenezca a la sucursal de `:id` en la URL (o sea
 * administrador de plataforma). No exige rol admin: dentro de su propia
 * sucursal, un asesor también necesita esto (ej. mandar plantillas de
 * WhatsApp a clientes es trabajo del día a día, no una tarea de admin).
 *
 * Sí importa para el aislamiento entre sucursales: sin este chequeo, la
 * cuenta de UNA sucursal podría leer/editar recursos de OTRA sucursal con
 * su propio token válido, solo cambiando el id en la URL.
 */
export async function requireAccesoSucursal(req: Request, res: Response, next: NextFunction) {
  if (!req.usuario) {
    res.status(401).json({ error: "Sesión requerida." });
    return;
  }

  try {
    const { data, error } = await getSupabase()
      .from("usuarios")
      .select("activo, sucursal_id, rol, ejecutivo_asignado")
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
    // sucursal_id null = administrador de plataforma: entra a cualquier sucursal.
    if (data.sucursal_id !== null && data.sucursal_id !== req.params.id) {
      res.status(403).json({ error: "No tienes acceso a esta sucursal." });
      return;
    }
    req.perfil = {
      rol: data.rol as string,
      sucursal_id: (data.sucursal_id as string | null) ?? null,
      ejecutivo_asignado: (data.ejecutivo_asignado as string | null) ?? null,
    };
    next();
  } catch (err) {
    next(err);
  }
}
