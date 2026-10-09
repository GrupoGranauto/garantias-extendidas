import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAccesoSucursal, requireAdminPlataforma, requireAdminSucursal } from "../middleware/auth.js";
import { getSupabase } from "../lib/supabase.js";
import { cifrarSecreto, descifrarSecreto } from "../lib/apiKeyEntidad.js";
import { crearContactosCloudTalk } from "../lib/cloudtalk.js";
import { getPool } from "../lib/db.js";

export const cloudtalkRouter = Router();

cloudtalkRouter.use(requireAuth);

const credencialesSchema = z.object({
  api_access_key_id: z.string().trim().min(1).max(255).optional(),
  api_access_key_secret: z.string().trim().min(1).max(2048).optional(),
  activo: z.boolean().optional(),
});

const altaSchema = z.object({
  contacto_ids: z.array(z.string().uuid()).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, {
    message: "No repitas IDs de contacto.",
  }),
});

cloudtalkRouter.get("/sucursales/:id/cloudtalk", requireAdminPlataforma, async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("cloudtalk_config")
      .select("activo")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ configurado: Boolean(data), activo: data?.activo ?? false });
  } catch (error) {
    next(error);
  }
});

cloudtalkRouter.put("/sucursales/:id/cloudtalk", requireAdminPlataforma, async (req, res, next) => {
  const parsed = credencialesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const supabase = getSupabase();
    const sucursalId = req.params.id;
    const { data: existente, error: errorLectura } = await supabase
      .from("cloudtalk_config")
      .select("id, api_access_key_id, api_access_key_secret_cifrado, activo")
      .eq("sucursal_id", sucursalId)
      .maybeSingle();
    if (errorLectura) throw new Error(errorLectura.message);

    const accessKeyId = parsed.data.api_access_key_id ?? existente?.api_access_key_id;
    const secretCifrado = parsed.data.api_access_key_secret
      ? cifrarSecreto(parsed.data.api_access_key_secret)
      : existente?.api_access_key_secret_cifrado;
    if (!accessKeyId || !secretCifrado) {
      res.status(400).json({ error: "Para configurar CloudTalk se requieren el API Access Key ID y el API Access Key Secret." });
      return;
    }

    const cambios = {
      sucursal_id: sucursalId,
      api_access_key_id: accessKeyId,
      api_access_key_secret_cifrado: secretCifrado,
      // Guardar credenciales activa la integración salvo que se pida lo contrario;
      // al reconfigurar se respeta el estado previo si no se envía `activo`.
      activo: parsed.data.activo ?? existente?.activo ?? true,
    };
    const { error } = existente
      ? await supabase.from("cloudtalk_config").update(cambios).eq("id", existente.id)
      : await supabase.from("cloudtalk_config").insert(cambios);
    if (error) throw new Error(error.message);

    res.json({ guardado: true });
  } catch (error) {
    next(error);
  }
});

cloudtalkRouter.post(
  "/sucursales/:id/cloudtalk/contactos",
  requireAccesoSucursal,
  requireAdminSucursal,
  async (req, res, next) => {
    const parsed = altaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
      return;
    }

    try {
      const { data: configuracion, error: errorConfig } = await getSupabase()
        .from("cloudtalk_config")
        .select("api_access_key_id, api_access_key_secret_cifrado, activo")
        .eq("sucursal_id", req.params.id)
        .maybeSingle();
      if (errorConfig) throw new Error(errorConfig.message);
      if (!configuracion || !configuracion.activo) {
        res.status(409).json({ error: "CloudTalk no está configurado o activo para esta sucursal." });
        return;
      }

      const { rows } = await getPool().query(
        `SELECT id, nombre, telefono, correo FROM crm_contactos
          WHERE sucursal_id = $1 AND id = ANY($2::uuid[])`,
        [req.params.id, parsed.data.contacto_ids],
      );
      const porId = new Map(rows.map((contacto) => [contacto.id as string, contacto]));
      const contactos = parsed.data.contacto_ids.map((id) => {
        const contacto = porId.get(id);
        return contacto
          ? { id, nombre: contacto.nombre as string | null, telefono: contacto.telefono as string | null, correo: contacto.correo as string | null }
          : null;
      });

      const noEncontrados = new Set(parsed.data.contacto_ids.filter((_, index) => contactos[index] === null));
      const existentes = contactos.filter((contacto) => contacto !== null);
      let accessKeySecret: string;
      try {
        accessKeySecret = descifrarSecreto(configuracion.api_access_key_secret_cifrado);
      } catch {
        console.error(`[cloudtalk] No se pudo descifrar la credencial configurada para la sucursal ${req.params.id}.`);
        res.status(409).json({
          error: "La credencial guardada de CloudTalk no se puede descifrar. Vuelve a guardarla desde la configuración.",
        });
        return;
      }
      const resultados = await crearContactosCloudTalk(
        { accessKeyId: configuracion.api_access_key_id, accessKeySecret },
        existentes,
      );
      const porResultado = new Map(resultados.map((resultado) => [resultado.contacto_id, resultado]));
      const detalle = parsed.data.contacto_ids.map((id) => noEncontrados.has(id)
        ? { contacto_id: id, estado: "error" as const, error: "Contacto no encontrado en esta sucursal." }
        : porResultado.get(id)!);
      const creados = detalle.filter((resultado) => resultado.estado === "creado").length;
      res.json({ total: detalle.length, creados, errores: detalle.length - creados, resultados: detalle });
    } catch (error) {
      next(error);
    }
  },
);
