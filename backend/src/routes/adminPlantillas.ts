import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  crearPlantillaMeta,
  eliminarPlantillaMeta,
  estadoDesdeMeta,
  listarPlantillasMeta,
  type ComponentePlantilla,
} from "../lib/whatsapp.js";

export const adminPlantillasRouter = Router();

adminPlantillasRouter.use(requireAuth, requireAdmin);

/* ============================================================
   Forma local de los componentes: más simple que el payload de
   Meta, pensada para atarse directo al formulario. Se traduce a
   la forma de Meta solo al momento de enviar a revisión.
   ============================================================ */

const botonSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("respuesta_rapida"), texto: z.string().trim().min(1).max(25) }),
  z.object({ tipo: z.literal("url"), texto: z.string().trim().min(1).max(25), url: z.string().trim().url().max(2000) }),
  z.object({
    tipo: z.literal("telefono"),
    texto: z.string().trim().min(1).max(25),
    telefono: z.string().trim().min(1).max(20),
  }),
  z.object({ tipo: z.literal("copiar_codigo"), ejemplo: z.string().trim().min(1).max(15) }),
]);

const componentesSchema = z.object({
  header: z.object({ texto: z.string().trim().min(1).max(60) }).nullable().default(null),
  body: z.object({
    texto: z.string().trim().min(1).max(1024),
    ejemplos: z.array(z.string().trim().min(1)).default([]),
  }),
  footer: z.string().trim().min(1).max(60).nullable().default(null),
  botones: z.array(botonSchema).max(10).default([]),
});

const plantillaSchema = z.object({
  nombre_tecnico: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[a-z][a-z0-9_]*$/, "Solo minúsculas, números y guiones bajos; debe iniciar con letra."),
  idioma: z.string().trim().min(2).max(10),
  categoria: z.enum(["marketing", "utility", "authentication"]),
  componentes: componentesSchema,
});

type Componentes = z.infer<typeof componentesSchema>;

/** Guardarraíles propios antes de mandarlo a Meta: variables consecutivas y límites de botones. */
function validarComponentes(componentes: Componentes): string | null {
  const variables = componentes.body.texto.match(/\{\{\d+\}\}/g) ?? [];
  const numeros = variables.map((v) => Number(v.replace(/\D/g, ""))).sort((a, b) => a - b);
  for (let i = 0; i < numeros.length; i++) {
    if (numeros[i] !== i + 1) {
      return "Las variables del cuerpo deben ser consecutivas empezando en {{1}}, sin saltos.";
    }
  }
  if (numeros.length !== componentes.body.ejemplos.length) {
    return `El cuerpo usa ${numeros.length} variable(s); deben capturarse ${numeros.length} ejemplo(s).`;
  }

  const contar = (tipo: string) => componentes.botones.filter((b) => b.tipo === tipo).length;
  if (contar("respuesta_rapida") > 3) return "Máximo 3 botones de respuesta rápida.";
  if (contar("url") > 2) return "Máximo 2 botones de URL.";
  if (contar("telefono") > 1) return "Máximo 1 botón de llamada.";
  if (contar("copiar_codigo") > 1) return "Máximo 1 botón de copiar código.";

  return null;
}

function componentesAMeta(componentes: Componentes): ComponentePlantilla[] {
  const lista: ComponentePlantilla[] = [];

  if (componentes.header) {
    lista.push({ type: "HEADER", format: "TEXT", text: componentes.header.texto });
  }

  lista.push({
    type: "BODY",
    text: componentes.body.texto,
    ...(componentes.body.ejemplos.length ? { example: { body_text: [componentes.body.ejemplos] } } : {}),
  });

  if (componentes.footer) {
    lista.push({ type: "FOOTER", text: componentes.footer });
  }

  if (componentes.botones.length) {
    lista.push({
      type: "BUTTONS",
      buttons: componentes.botones.map((b) => {
        switch (b.tipo) {
          case "respuesta_rapida":
            return { type: "QUICK_REPLY", text: b.texto };
          case "url":
            return { type: "URL", text: b.texto, url: b.url };
          case "telefono":
            return { type: "PHONE_NUMBER", text: b.texto, phone_number: b.telefono };
          case "copiar_codigo":
            return { type: "COPY_CODE", example: b.ejemplo };
        }
      }),
    });
  }

  return lista;
}

async function obtenerConfigWhatsapp(sucursalId: string) {
  const { data, error } = await getSupabase()
    .from("whatsapp_config")
    .select("waba_id, access_token")
    .eq("sucursal_id", sucursalId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Listado local de plantillas de la sucursal. */
adminPlantillasRouter.get("/sucursales/:id/plantillas", async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("whatsapp_plantillas")
      .select("id, nombre_tecnico, idioma, categoria, estado, motivo_rechazo, creado_en, actualizado_en")
      .eq("sucursal_id", req.params.id)
      .order("creado_en", { ascending: false });
    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err) {
    next(err);
  }
});

/** Detalle completo (incluye componentes, para editar). */
adminPlantillasRouter.get("/sucursales/:id/plantillas/:pid", async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("whatsapp_plantillas")
      .select("*")
      .eq("sucursal_id", req.params.id)
      .eq("id", req.params.pid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ error: "Plantilla no encontrada." });
      return;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/** Crea una plantilla en borrador (todavía no se manda a Meta). */
adminPlantillasRouter.post("/sucursales/:id/plantillas", async (req, res, next) => {
  const parsed = plantillaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten() });
    return;
  }

  const errorComponentes = validarComponentes(parsed.data.componentes);
  if (errorComponentes) {
    res.status(400).json({ error: errorComponentes });
    return;
  }

  try {
    const { data, error } = await getSupabase()
      .from("whatsapp_plantillas")
      .insert({
        sucursal_id: req.params.id,
        nombre_tecnico: parsed.data.nombre_tecnico,
        idioma: parsed.data.idioma,
        categoria: parsed.data.categoria,
        componentes: parsed.data.componentes,
      })
      .select("id")
      .single();

    if (error) {
      const codigo = (error as { code?: string }).code;
      const mensaje = codigo === "23505" ? "Ya existe una plantilla con ese nombre e idioma." : error.message;
      res.status(400).json({ error: mensaje });
      return;
    }

    res.status(201).json({ id: data.id });
  } catch (err) {
    next(err);
  }
});

/** Edita una plantilla que aún no fue aprobada (borrador o rechazada). */
adminPlantillasRouter.patch("/sucursales/:id/plantillas/:pid", async (req, res, next) => {
  const parsed = plantillaSchema.partial({ nombre_tecnico: true }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten() });
    return;
  }
  if (parsed.data.componentes) {
    const errorComponentes = validarComponentes(parsed.data.componentes);
    if (errorComponentes) {
      res.status(400).json({ error: errorComponentes });
      return;
    }
  }

  try {
    const supabase = getSupabase();
    const { data: existente, error: errorExistente } = await supabase
      .from("whatsapp_plantillas")
      .select("id, estado")
      .eq("sucursal_id", req.params.id)
      .eq("id", req.params.pid)
      .maybeSingle();
    if (errorExistente) throw new Error(errorExistente.message);
    if (!existente) {
      res.status(404).json({ error: "Plantilla no encontrada." });
      return;
    }
    if (existente.estado !== "borrador" && existente.estado !== "rechazada") {
      res.status(400).json({ error: "Solo se puede editar una plantilla en borrador o rechazada." });
      return;
    }

    const cambios: Record<string, unknown> = { actualizado_en: new Date().toISOString() };
    if (parsed.data.idioma) cambios.idioma = parsed.data.idioma;
    if (parsed.data.categoria) cambios.categoria = parsed.data.categoria;
    if (parsed.data.componentes) cambios.componentes = parsed.data.componentes;

    const { error } = await supabase.from("whatsapp_plantillas").update(cambios).eq("id", existente.id);
    if (error) throw new Error(error.message);

    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});

/** Borra la plantilla: primero en Meta (si ya se envió), luego localmente. */
adminPlantillasRouter.delete("/sucursales/:id/plantillas/:pid", async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { data: plantilla, error } = await supabase
      .from("whatsapp_plantillas")
      .select("id, nombre_tecnico, meta_template_id")
      .eq("sucursal_id", req.params.id)
      .eq("id", req.params.pid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!plantilla) {
      res.json({ eliminado: true });
      return;
    }

    if (plantilla.meta_template_id) {
      const config = await obtenerConfigWhatsapp(req.params.id);
      if (config?.waba_id) {
        await eliminarPlantillaMeta(config.waba_id, config.access_token, plantilla.nombre_tecnico);
      }
    }

    const { error: errorDelete } = await supabase.from("whatsapp_plantillas").delete().eq("id", plantilla.id);
    if (errorDelete) throw new Error(errorDelete.message);

    res.json({ eliminado: true });
  } catch (err) {
    next(err);
  }
});

/** Manda la plantilla a revisión de Meta. */
adminPlantillasRouter.post("/sucursales/:id/plantillas/:pid/enviar", async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { data: plantilla, error } = await supabase
      .from("whatsapp_plantillas")
      .select("*")
      .eq("sucursal_id", req.params.id)
      .eq("id", req.params.pid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!plantilla) {
      res.status(404).json({ error: "Plantilla no encontrada." });
      return;
    }
    if (plantilla.estado !== "borrador" && plantilla.estado !== "rechazada") {
      res.status(400).json({ error: "Esta plantilla ya está en revisión o aprobada." });
      return;
    }

    const config = await obtenerConfigWhatsapp(req.params.id);
    if (!config?.waba_id || !config.access_token) {
      res.status(400).json({ error: "Esta sucursal no tiene configurado WhatsApp (WABA ID / Access Token)." });
      return;
    }

    const parsedComponentes = componentesSchema.safeParse(plantilla.componentes);
    if (!parsedComponentes.success) {
      res.status(400).json({ error: "La plantilla guardada tiene datos corruptos; vuelve a editarla." });
      return;
    }

    const resultado = await crearPlantillaMeta(config.waba_id, config.access_token, {
      name: plantilla.nombre_tecnico,
      language: plantilla.idioma,
      category: plantilla.categoria.toUpperCase(),
      components: componentesAMeta(parsedComponentes.data),
    });

    const nuevoEstado = estadoDesdeMeta(resultado.status);
    const { error: errorUpdate } = await supabase
      .from("whatsapp_plantillas")
      .update({
        meta_template_id: resultado.id,
        estado: nuevoEstado,
        motivo_rechazo: null,
        actualizado_en: new Date().toISOString(),
      })
      .eq("id", plantilla.id);
    if (errorUpdate) throw new Error(errorUpdate.message);

    res.json({ enviado: true, estado: nuevoEstado });
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/** Refresca el estado de todas las plantillas de la sucursal consultando a Meta directamente. */
adminPlantillasRouter.post("/sucursales/:id/plantillas/sync", async (req, res, next) => {
  try {
    const config = await obtenerConfigWhatsapp(req.params.id);
    if (!config?.waba_id || !config.access_token) {
      res.status(400).json({ error: "Esta sucursal no tiene configurado WhatsApp." });
      return;
    }

    const remotas = await listarPlantillasMeta(config.waba_id, config.access_token);
    const porNombreIdioma = new Map(remotas.map((r) => [`${r.name}__${r.language}`, r]));

    const supabase = getSupabase();
    const { data: locales, error } = await supabase
      .from("whatsapp_plantillas")
      .select("id, nombre_tecnico, idioma, estado")
      .eq("sucursal_id", req.params.id)
      .neq("estado", "borrador");
    if (error) throw new Error(error.message);

    let actualizadas = 0;
    for (const local of locales ?? []) {
      const remota = porNombreIdioma.get(`${local.nombre_tecnico}__${local.idioma}`);
      if (!remota) continue;
      const nuevoEstado = estadoDesdeMeta(remota.status);
      if (nuevoEstado === local.estado) continue;
      await supabase
        .from("whatsapp_plantillas")
        .update({ meta_template_id: remota.id, estado: nuevoEstado, actualizado_en: new Date().toISOString() })
        .eq("id", local.id);
      actualizadas++;
    }

    res.json({ sincronizado: true, actualizadas });
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
