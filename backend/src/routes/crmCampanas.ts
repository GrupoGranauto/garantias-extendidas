import { Router } from "express";
import { z } from "zod";
import { getPool } from "../lib/db.js";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import { configPorSucursalId } from "../lib/whatsapp.js";
import { aMinutos } from "../lib/campanasLogica.js";
import {
  configurarConsentimientoAutomatico,
  guardarCampana,
  leerCampanas,
  leerConsentimientoAutomatico,
  registroEnvios,
  vistaPrevia,
} from "../lib/campanasEnvio.js";

/**
 * Configuración de los envíos automáticos por campaña (solo el admin de la sucursal): plantilla, día y
 * hora de cada mensaje, condiciones, ventana de envío, tope diario y descanso entre campañas.
 */
export const crmCampanasRouter = Router();

crmCampanasRouter.use(requireAuth);
crmCampanasRouter.use("/sucursales/:id/crm/campanas", requireAccesoSucursal, requireAdminSucursal);
crmCampanasRouter.use("/sucursales/:id/crm/envios", requireAccesoSucursal, requireAdminSucursal);
crmCampanasRouter.use("/sucursales/:id/crm/consentimiento-automatico", requireAccesoSucursal, requireAdminSucursal);

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida (usa HH:MM).");

const pasoSchema = z.object({
  id: z.string().uuid().optional(),
  plantilla_id: z.string().uuid().nullable(),
  dias_despues: z.number().int().min(0).max(365),
  hora: hora.nullable(),
  vigencia_dias: z.number().int().min(0).max(60),
  solo_sin_respuesta: z.boolean(),
  solo_sin_contacto: z.boolean(),
  etapas: z.array(z.string().trim().min(1).max(80)).max(10),
});

const campanaSchema = z
  .object({
    activa: z.boolean(),
    modo: z.enum(["simulacion", "real"]),
    dias_semana: z
      .array(z.number().int().min(1).max(7))
      .min(1, "Elige al menos un día de envío.")
      .transform((d) => [...new Set(d)].sort()),
    hora_inicio: hora,
    hora_fin: hora,
    max_por_dia: z.number().int().min(1).max(5000),
    dias_entre_mensajes: z.number().int().min(0).max(365),
    pasos: z.array(pasoSchema).max(6, "Una campaña admite hasta 6 mensajes."),
  })
  .superRefine((c, ctx) => {
    if (aMinutos(c.hora_fin) <= aMinutos(c.hora_inicio)) {
      ctx.addIssue({ code: "custom", message: "La hora final debe ser posterior a la inicial." });
    }
    if (c.activa && c.pasos.length === 0) {
      ctx.addIssue({ code: "custom", message: "Para encender la campaña agrega al menos un mensaje." });
    }
    if (c.activa && c.pasos.some((p) => !p.plantilla_id)) {
      ctx.addIssue({ code: "custom", message: "Todos los mensajes necesitan una plantilla." });
    }
  });

/** Cuántas variables {{n}} usa cada plantilla y cuántas tiene ligadas a una columna de la base. */
async function conVariables(
  plantillas: { id: string; nombre: string | null; nombre_tecnico: string; estado: string; componentes: unknown }[],
) {
  const ids = plantillas.map((p) => p.id);
  const { rows } = ids.length
    ? await getPool().query(`SELECT plantilla_id, count(*)::int AS n FROM whatsapp_plantilla_variables WHERE plantilla_id = ANY($1::uuid[]) GROUP BY 1`, [ids])
    : { rows: [] as { plantilla_id: string; n: number }[] };
  const mapeadas = new Map(rows.map((r) => [r.plantilla_id as string, r.n as number]));
  return plantillas.map((p) => {
    const texto = ((p.componentes as { body?: { texto?: string } } | null)?.body?.texto ?? "") as string;
    const variables = new Set([...texto.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
    return { id: p.id, nombre: p.nombre, nombre_tecnico: p.nombre_tecnico, estado: p.estado, variables, mapeadas: mapeadas.get(p.id) ?? 0 };
  });
}

const nombreCampana = z.string().regex(/^[A-Za-z0-9_]{1,30}$/);

crmCampanasRouter.get("/sucursales/:id/crm/campanas", async (req, res, next) => {
  try {
    const campanas = await leerCampanas(req.params.id);
    const { data: plantillasCrudas, error } = await getSupabase()
      .from("whatsapp_plantillas")
      .select("id, nombre, nombre_tecnico, estado, componentes")
      .eq("sucursal_id", req.params.id)
      .order("nombre");
    if (error) throw new Error(error.message);
    const plantillas = await conVariables(plantillasCrudas ?? []);
    const { rows: etapas } = await getPool().query(
      `SELECT nombre FROM crm_etapas WHERE sucursal_id = $1 AND activa AND tipo = 'abierta' ORDER BY orden`,
      [req.params.id],
    );
    const whatsapp = await configPorSucursalId(req.params.id).catch(() => null);

    res.json({
      campanas,
      plantillas,
      consentimiento: await leerConsentimientoAutomatico(req.params.id),
      etapas: etapas.map((e) => e.nombre as string),
      whatsapp_listo: Boolean(whatsapp && whatsapp.activo),
      // Si el servidor no tiene encendido el motor de envíos, nada sale aunque la campaña esté activa.
      motor_encendido: process.env.CRM_ENVIOS === "on",
    });
  } catch (err) {
    next(err);
  }
});

crmCampanasRouter.put("/sucursales/:id/crm/campanas/:campana", async (req, res, next) => {
  const nombre = nombreCampana.safeParse(req.params.campana);
  const parsed = campanaSchema.safeParse(req.body);
  if (!nombre.success || !parsed.success) {
    res.status(400).json({ error: parsed.success ? "Campaña inválida." : (parsed.error.issues[0]?.message ?? "Datos inválidos.") });
    return;
  }
  try {
    if (parsed.data.activa) {
      const ids = [...new Set(parsed.data.pasos.map((p) => p.plantilla_id).filter((x): x is string => Boolean(x)))];
      const { data: crudas } = await getSupabase().from("whatsapp_plantillas").select("id, nombre, nombre_tecnico, estado, componentes").eq("sucursal_id", req.params.id).in("id", ids);
      const faltan = (await conVariables(crudas ?? [])).filter((x) => x.mapeadas < x.variables);
      if (faltan.length > 0) {
        res.status(400).json({
          error: `La plantilla «${faltan[0].nombre ?? faltan[0].nombre_tecnico}» usa ${faltan[0].variables} variable(s) y solo tiene ${faltan[0].mapeadas} ligada(s) a datos de la base. Liga sus variables en Plantillas antes de encender la campaña.`,
        });
        return;
      }
    }
    const r = await guardarCampana(req.params.id, nombre.data, parsed.data);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});

crmCampanasRouter.get("/sucursales/:id/crm/campanas/:campana/vista-previa", async (req, res, next) => {
  const nombre = nombreCampana.safeParse(req.params.campana);
  if (!nombre.success) {
    res.status(400).json({ error: "Campaña inválida." });
    return;
  }
  try {
    const r = await vistaPrevia(req.params.id, nombre.data);
    if (!r) {
      res.status(404).json({ error: "La campaña no existe." });
      return;
    }
    res.json(r);
  } catch (err) {
    next(err);
  }
});

crmCampanasRouter.get("/sucursales/:id/crm/envios", async (req, res, next) => {
  try {
    const campana = nombreCampana.safeParse(req.query.campana);
    res.json(await registroEnvios(req.params.id, campana.success ? campana.data : null));
  } catch (err) {
    next(err);
  }
});

/** Enciende o apaga el consentimiento por contrato de venta (solo el admin de la sucursal; queda registrado quién y cuándo). */
const consentimientoSchema = z.discriminatedUnion("activo", [
  z.object({
    activo: z.literal(true),
    fuente: z.string().trim().min(3, "Indica la fuente (por ejemplo, Contrato de venta).").max(80),
    confirmo: z.literal(true, { errorMap: () => ({ message: "Debes confirmar que el contrato de venta incluye la autorización del cliente." }) }),
  }),
  z.object({ activo: z.literal(false), retirar_registrado: z.boolean().default(false) }),
]);

crmCampanasRouter.put("/sucursales/:id/crm/consentimiento-automatico", async (req, res, next) => {
  const parsed = consentimientoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." });
    return;
  }
  try {
    const actual = await leerConsentimientoAutomatico(req.params.id);
    const r = await configurarConsentimientoAutomatico({
      sucursalId: req.params.id,
      activo: parsed.data.activo,
      fuente: parsed.data.activo ? parsed.data.fuente : (actual.fuente ?? "Contrato de venta"),
      usuarioId: req.usuario?.id ?? null,
      retirarRegistrado: parsed.data.activo ? false : parsed.data.retirar_registrado,
    });
    res.json({ ok: true, contactos: r.contactos });
  } catch (err) {
    next(err);
  }
});
