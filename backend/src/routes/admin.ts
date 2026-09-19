import dns from "node:dns/promises";
import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { subdominioValido } from "../lib/subdominio.js";

export const adminRouter = Router();

// Todo lo de aqui exige sesión con rol admin
adminRouter.use(requireAuth, requireAdmin);

const altaSchema = z.object({
  correo: z.string().email().transform((v) => v.trim().toLowerCase()),
  nombre: z.string().trim().min(1).optional(),
  rol: z.enum(["admin", "gestor", "consulta"]).default("consulta"),
  /** Sin contraseña se envía invitación por correo y el usuario la define. */
  password: z.string().min(8).optional(),
  /** Null = administrador de plataforma (entra por el dominio raíz). */
  sucursal_id: z.string().uuid().nullable().default(null),
});

/** Lista de usuarios con su rol. */
adminRouter.get("/usuarios", async (_req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("usuarios")
      .select("id, correo, nombre, rol, activo, creado_en")
      .order("creado_en");

    if (error) throw new Error(error.message);
    res.json({ total: data?.length ?? 0, usuarios: data });
  } catch (err) {
    next(err);
  }
});

/** Invitaciones emitidas que aún nadie usó. */
adminRouter.get("/invitaciones", async (_req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("invitaciones")
      .select("correo, rol, nombre, creada_en, usada_en")
      .is("usada_en", null)
      .order("creada_en");

    if (error) throw new Error(error.message);
    res.json({ total: data?.length ?? 0, invitaciones: data });
  } catch (err) {
    next(err);
  }
});

/**
 * Alta de usuario. Único camino que existe: la base rechaza cualquier
 * insert en auth.users sin invitación vigente (trigger exigir_invitacion_al_crear).
 */
adminRouter.post("/usuarios", async (req, res, next) => {
  const parsed = altaSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten().fieldErrors });
    return;
  }

  const { correo, nombre, rol, password, sucursal_id } = parsed.data;
  const supabase = getSupabase();

  try {
    // 1. La invitación debe existir antes de tocar auth.users
    const { error: errorInvitacion } = await supabase.from("invitaciones").upsert(
      {
        correo,
        rol,
        nombre: nombre ?? null,
        sucursal_id,
        invitado_por: req.usuario!.id,
        usada_en: null,
      },
      { onConflict: "correo" },
    );

    if (errorInvitacion) throw new Error(errorInvitacion.message);

    // 2. Con contraseña queda listo para entrar; sin ella, recibe correo de invitación
    const resultado = password
      ? await supabase.auth.admin.createUser({
          email: correo,
          password,
          email_confirm: true,
          user_metadata: {
            rol,
            ...(nombre ? { full_name: nombre } : {}),
            ...(sucursal_id ? { sucursal_id } : {}),
          },
        })
      : await supabase.auth.admin.inviteUserByEmail(correo, {
          redirectTo: `${env.CORS_ORIGIN.split(",")[0].trim()}/restablecer`,
          data: {
            rol,
            ...(nombre ? { full_name: nombre } : {}),
            ...(sucursal_id ? { sucursal_id } : {}),
          },
        });

    if (resultado.error) {
      // Si falló el alta, la invitación no debe quedar consumida ni suelta
      await supabase.from("invitaciones").delete().eq("correo", correo);
      res.status(400).json({ error: resultado.error.message });
      return;
    }

    res.status(201).json({
      id: resultado.data.user?.id,
      correo,
      rol,
      metodo: password ? "contraseña definida por el administrador" : "invitación enviada por correo",
    });
  } catch (err) {
    next(err);
  }
});

/** Baja lógica: conserva el historial y le quita el acceso. */
adminRouter.patch("/usuarios/:id/activo", async (req, res, next) => {
  try {
    const activo = z.boolean().parse(req.body?.activo);

    if (req.params.id === req.usuario!.id && !activo) {
      res.status(400).json({ error: "No puedes desactivar tu propia cuenta." });
      return;
    }

    const { data, error } = await getSupabase()
      .from("usuarios")
      .update({ activo })
      .eq("id", req.params.id)
      .select("id, correo, activo")
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   Sucursales: cada una es un portal en su propio subdominio
   ============================================================ */

const sucursalSchema = z.object({
  nombre: z.string().trim().min(2),
  subdominio: z
    .string()
    .trim()
    .toLowerCase()
    .refine(subdominioValido, "Solo minúsculas, números y guiones (3 a 32 caracteres)."),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Color hexadecimal de 6 dígitos.")
    .default("#493f91"),
  activa: z.boolean().default(true),
  login_google: z.boolean().default(true),
  mensaje_cerrado: z.string().trim().nullable().default(null),
  logo_url: z.string().url().nullable().default(null),
  logo_panel_url: z.string().url().nullable().default(null),
  imagen_acceso_url: z.string().url().nullable().default(null),
});

// Edicion: el subdominio no se toca (ya tiene DNS y certificado emitidos
// para el), y "activa" tiene su propio endpoint dedicado abajo.
const sucursalEdicionSchema = sucursalSchema.omit({ subdominio: true, activa: true }).partial();

adminRouter.get("/sucursales", async (_req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("sucursales")
      .select("id, subdominio, nombre, color, logo_url, activa, login_google, creado_en")
      .order("nombre");

    if (error) throw new Error(error.message);
    res.json({ total: data?.length ?? 0, sucursales: data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/sucursales/:id", async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("sucursales")
      .select(
        "id, subdominio, nombre, color, logo_url, logo_panel_url, imagen_acceso_url, activa, login_google, mensaje_cerrado",
      )
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/sucursales", async (req, res, next) => {
  const parsed = sucursalSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const { data, error } = await getSupabase()
      .from("sucursales")
      .insert(parsed.data)
      .select("id, subdominio, nombre")
      .single();

    if (error) {
      // 23505 = unique_violation, 23514 = check_violation (slug reservado o mal formado)
      const codigo = (error as { code?: string }).code;
      const mensaje =
        codigo === "23505"
          ? "Ese subdominio ya está ocupado."
          : codigo === "23514"
            ? "Ese subdominio no está permitido."
            : error.message;
      res.status(400).json({ error: mensaje });
      return;
    }

    res.status(201).json({
      ...data,
      url: `https://${data.subdominio}.${env.DOMINIO_BASE}`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Diagnóstico del portal: ¿el subdominio ya resuelve y responde?
 *
 * Con DNS comodín no hay que crear un registro por sucursal, pero sí conviene
 * confirmar que el comodín está puesto y que Railway ya sirve ese host.
 */
adminRouter.get("/sucursales/:subdominio/diagnostico", async (req, res, next) => {
  const { subdominio } = req.params;

  if (!subdominioValido(subdominio)) {
    res.status(400).json({ error: "Subdominio con formato inválido." });
    return;
  }

  const host = `${subdominio}.${env.DOMINIO_BASE}`;

  try {
    const { data } = await getSupabase()
      .from("sucursales")
      .select("id")
      .eq("subdominio", subdominio)
      .maybeSingle();

    // ---- DNS ----
    let dnsResuelve = false;
    let apuntaA: string[] = [];
    let detalleDns = "";

    try {
      apuntaA = await dns.resolveCname(host);
      dnsResuelve = true;
    } catch {
      try {
        const direcciones = await dns.lookup(host, { all: true });
        apuntaA = direcciones.map((d) => d.address);
        dnsResuelve = apuntaA.length > 0;
      } catch (err) {
        detalleDns = err instanceof Error ? err.message : "sin resolver";
      }
    }

    // ---- HTTPS ----
    let responde = false;
    let detalleHttp = "";

    if (dnsResuelve) {
      try {
        const corte = AbortSignal.timeout(6000);
        const r = await fetch(`https://${host}/api/health`, { signal: corte });
        responde = r.ok;
        if (!r.ok) detalleHttp = `HTTP ${r.status}`;
      } catch (err) {
        detalleHttp = err instanceof Error ? err.message : "sin respuesta";
      }
    }

    res.json({
      host,
      registradaEnLaBase: Boolean(data),
      dns: { resuelve: dnsResuelve, apuntaA, detalle: detalleDns || undefined },
      https: { responde, detalle: detalleHttp || undefined },
      listo: Boolean(data) && dnsResuelve && responde,
    });
  } catch (err) {
    next(err);
  }
});

/** Activar o desactivar una sucursal. No borra nada, solo bloquea el acceso. */
adminRouter.patch("/sucursales/:id/activa", async (req, res, next) => {
  try {
    const activa = z.boolean().parse(req.body?.activa);

    const { data, error } = await getSupabase()
      .from("sucursales")
      .update({ activa })
      .eq("id", req.params.id)
      .select("id, subdominio, activa")
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch("/sucursales/:id", async (req, res, next) => {
  const parsed = sucursalEdicionSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const { data, error } = await getSupabase()
      .from("sucursales")
      .update(parsed.data)
      .eq("id", req.params.id)
      .select(
        "id, subdominio, nombre, color, logo_url, logo_panel_url, imagen_acceso_url, activa, login_google, mensaje_cerrado",
      )
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    next(err);
  }
});
