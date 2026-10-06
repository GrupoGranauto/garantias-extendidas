import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAccesoSucursal, requireAdminSucursal } from "../middleware/auth.js";
import {
  crearPlantillaMeta,
  eliminarPlantillaMeta,
  estadoDesdeMeta,
  listarPlantillasMeta,
  subirMediaPlantilla,
  type ComponentePlantilla,
} from "../lib/whatsapp.js";

export const adminPlantillasRouter = Router();

adminPlantillasRouter.use(requireAuth);
// Todas las rutas de este router cuelgan de /sucursales/:id/plantillas...:
// este patrón hace que Express ya tenga req.params.id disponible aquí.
// La gestión de plantillas es solo del admin; el asesor no la toca (aunque sí
// puede MANDAR plantillas desde el chat, eso vive en whatsappChat).
adminPlantillasRouter.use("/sucursales/:id/plantillas", requireAccesoSucursal, requireAdminSucursal);

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

// media_handle puede venir vacío mientras la plantilla es borrador (aún no
// se subió a Meta, o la sucursal todavía no tiene WhatsApp configurado);
// se exige de verdad recién al mandar a revisión, no al guardar.
const headerSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("texto"), texto: z.string().trim().min(1).max(60) }),
  z.object({
    tipo: z.literal("imagen"),
    media_handle: z.string().trim().default(""),
    media_url: z.string().trim().nullable().default(null),
  }),
  z.object({
    tipo: z.literal("video"),
    media_handle: z.string().trim().default(""),
    media_url: z.string().trim().nullable().default(null),
  }),
  z.object({
    tipo: z.literal("documento"),
    media_handle: z.string().trim().default(""),
    media_url: z.string().trim().nullable().default(null),
    nombre_archivo: z.string().trim().nullable().default(null),
  }),
]);

const componentesSchema = z.object({
  header: headerSchema.nullable().default(null),
  body: z.object({
    texto: z.string().trim().min(1).max(1024),
    ejemplos: z.array(z.string().trim().min(1)).default([]),
  }),
  footer: z.string().trim().min(1).max(60).nullable().default(null),
  botones: z.array(botonSchema).max(10).default([]),
});

const plantillaSchema = z.object({
  nombre: z.string().trim().min(1).max(200),
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
    const h = componentes.header;
    if (h.tipo === "texto") {
      lista.push({ type: "HEADER", format: "TEXT", text: h.texto });
    } else {
      const formato = h.tipo === "imagen" ? "IMAGE" : h.tipo === "video" ? "VIDEO" : "DOCUMENT";
      lista.push({ type: "HEADER", format: formato, example: { header_handle: [h.media_handle] } });
    }
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
    .select("app_id, waba_id, access_token")
    .eq("sucursal_id", sucursalId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

const MIME_PERMITIDO: Record<"imagen" | "video" | "documento", string[]> = {
  imagen: ["image/jpeg", "image/png"],
  video: ["video/mp4"],
  documento: ["application/pdf"],
};

const subirMediaSchema = z.object({
  tipo: z.enum(["imagen", "video", "documento"]),
  nombre_archivo: z.string().trim().min(1).max(200),
  tipo_mime: z.string().trim().min(1),
  // Data URL completa (data:<mime>;base64,<...>) o el base64 pelado; se acepta cualquiera de los dos.
  contenido_base64: z.string().trim().min(1),
});

/**
 * Sube el archivo de muestra del header (imagen/video/documento) a Meta vía
 * su Resumable Upload API y también a Storage propio, para poder mostrarlo
 * en la vista previa sin depender de que el handle de Meta siga vivo.
 */
adminPlantillasRouter.post("/sucursales/:id/plantillas/subir-media", async (req, res, next) => {
  const parsed = subirMediaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten() });
    return;
  }
  if (!MIME_PERMITIDO[parsed.data.tipo].includes(parsed.data.tipo_mime)) {
    const permitidos = MIME_PERMITIDO[parsed.data.tipo].join(", ");
    res.status(400).json({ error: `Tipo de archivo no permitido para ${parsed.data.tipo}. Usa: ${permitidos}.` });
    return;
  }

  try {
    const config = await obtenerConfigWhatsapp(req.params.id);
    if (!config?.app_id || !config.access_token) {
      res.status(400).json({ error: "Esta sucursal no tiene configurado el App ID de Meta." });
      return;
    }

    const base64Puro = parsed.data.contenido_base64.replace(/^data:[^;]+;base64,/, "");
    const archivo = Buffer.from(base64Puro, "base64");

    const handle = await subirMediaPlantilla(config.app_id, config.access_token, archivo, parsed.data.tipo_mime);

    const extension = parsed.data.tipo_mime.split("/")[1] ?? "bin";
    const ruta = `plantillas/${req.params.id}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const supabase = getSupabase();
    const { error: errorSubida } = await supabase.storage
      .from("whatsapp-media")
      .upload(ruta, archivo, { contentType: parsed.data.tipo_mime, upsert: false });
    if (errorSubida) throw new Error(errorSubida.message);

    const { data: publica } = supabase.storage.from("whatsapp-media").getPublicUrl(ruta);

    res.json({ media_handle: handle, media_url: publica.publicUrl });
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/** Listado local de plantillas de la sucursal. */
adminPlantillasRouter.get("/sucursales/:id/plantillas", async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("whatsapp_plantillas")
      .select("id, nombre, nombre_tecnico, idioma, categoria, estado, motivo_rechazo, creado_en, actualizado_en")
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
        nombre: parsed.data.nombre,
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
  const parsed = plantillaSchema.partial({ nombre: true, nombre_tecnico: true }).safeParse(req.body);
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
    if (parsed.data.nombre) cambios.nombre = parsed.data.nombre;
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

/** Plantillas de muestra que Meta crea en toda cuenta de WhatsApp Business: no se importan y Meta no permite borrarlas. */
const PLANTILLAS_MUESTRA_META = new Set(["hello_world"]);

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

    // Las de muestra de Meta no se pueden borrar allá: solo se quitan del portal.
    if (plantilla.meta_template_id && !PLANTILLAS_MUESTRA_META.has(plantilla.nombre_tecnico)) {
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

    const header = parsedComponentes.data.header;
    if (header && header.tipo !== "texto" && !header.media_handle) {
      res.status(400).json({ error: "Sube el archivo del encabezado antes de enviar a revisión." });
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

/**
 * Traduce los componentes de Meta a la forma local. Sin cuerpo de texto devuelve null. Los encabezados de
 * imagen, video o documento se conservan como tales (sin archivo): esas plantillas no se pueden mandar
 * desde campañas ni desde el chat, pero quedan a la vista.
 */
function componentesDesdeMeta(
  lista: { type: string; format?: string; text?: string; example?: { body_text?: string[][] }; buttons?: Record<string, unknown>[] }[],
) {
  const cuerpo = lista.find((c) => c.type === "BODY");
  if (!cuerpo?.text) return null;
  const header = lista.find((c) => c.type === "HEADER");
  const footer = lista.find((c) => c.type === "FOOTER");
  const botones = lista.find((c) => c.type === "BUTTONS")?.buttons ?? [];

  let h: Record<string, unknown> | null = null;
  if (header) {
    if (header.format === "TEXT" && header.text) h = { tipo: "texto", texto: header.text };
    else if (header.format === "IMAGE") h = { tipo: "imagen", media_handle: "", media_url: null };
    else if (header.format === "VIDEO") h = { tipo: "video", media_handle: "", media_url: null };
    else if (header.format === "DOCUMENT") h = { tipo: "documento", media_handle: "", media_url: null, nombre_archivo: null };
  }

  const traducidos = botones.flatMap((b): Record<string, string>[] => {
    const tipo = String(b.type ?? "");
    const texto = String(b.text ?? "");
    if (tipo === "QUICK_REPLY") return [{ tipo: "respuesta_rapida", texto }];
    if (tipo === "URL") return [{ tipo: "url", texto, url: String(b.url ?? "") }];
    if (tipo === "PHONE_NUMBER") return [{ tipo: "telefono", texto, telefono: String(b.phone_number ?? "") }];
    if (tipo === "COPY_CODE") return [{ tipo: "copiar_codigo", ejemplo: String(b.example ?? "") }];
    return [];
  });

  return {
    header: h,
    body: { texto: cuerpo.text, ejemplos: cuerpo.example?.body_text?.[0] ?? [] },
    footer: footer?.text ?? null,
    botones: traducidos,
  };
}

/** Refresca el estado de las plantillas de la sucursal consultando a Meta, y trae las que solo existen allá. */
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

    let importadas = 0;
    const existentes = new Set((locales ?? []).map((l) => `${l.nombre_tecnico}__${l.idioma}`));
    // Las plantillas que ya existen en Meta pero no en la web se traen (con su estado y su contenido).
    const { data: borradores } = await supabase
      .from("whatsapp_plantillas")
      .select("nombre_tecnico, idioma")
      .eq("sucursal_id", req.params.id)
      .eq("estado", "borrador");
    for (const b of borradores ?? []) existentes.add(`${b.nombre_tecnico}__${b.idioma}`);
    for (const remota of remotas) {
      if (existentes.has(`${remota.name}__${remota.language}`)) continue;
      // La plantilla de muestra que Meta crea en toda cuenta no sirve aquí (y Meta no deja borrarla): no se trae.
      if (PLANTILLAS_MUESTRA_META.has(remota.name)) continue;
      const categoria = remota.category?.toLowerCase();
      if (categoria !== "marketing" && categoria !== "utility" && categoria !== "authentication") continue;
      const componentes = componentesDesdeMeta(remota.components ?? []);
      if (!componentes) continue; // sin cuerpo de texto no hay nada que mandar
      const { error: errorImportar } = await supabase.from("whatsapp_plantillas").insert({
        sucursal_id: req.params.id,
        nombre: remota.name,
        nombre_tecnico: remota.name,
        idioma: remota.language,
        categoria,
        componentes,
        estado: estadoDesdeMeta(remota.status),
        meta_template_id: remota.id,
      });
      if (!errorImportar) importadas++;
    }

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

    res.json({ sincronizado: true, actualizadas, importadas });
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/* ============================================================
   Mapeo de variables: qué columna de la Base de Datos de la
   sucursal llena cada {{n}} del cuerpo, para mandarla sola desde
   el chat con "/" sin armar el mensaje a mano.
   ============================================================ */

const variablesSchema = z.array(
  z.object({
    indice: z.number().int().min(1),
    columna_tecnica: z.string().trim().min(1),
  }),
);

adminPlantillasRouter.get("/sucursales/:id/plantillas/:pid/variables", async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("whatsapp_plantilla_variables")
      .select("indice, columna_tecnica")
      .eq("plantilla_id", req.params.pid)
      .order("indice");
    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err) {
    next(err);
  }
});

/** Reemplaza el mapeo completo de la plantilla (borra y vuelve a insertar). */
adminPlantillasRouter.put("/sucursales/:id/plantillas/:pid/variables", async (req, res, next) => {
  const parsed = variablesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten() });
    return;
  }

  try {
    const supabase = getSupabase();
    const { data: plantilla, error: errorPlantilla } = await supabase
      .from("whatsapp_plantillas")
      .select("id")
      .eq("sucursal_id", req.params.id)
      .eq("id", req.params.pid)
      .maybeSingle();
    if (errorPlantilla) throw new Error(errorPlantilla.message);
    if (!plantilla) {
      res.status(404).json({ error: "Plantilla no encontrada." });
      return;
    }

    const { error: errorDelete } = await supabase
      .from("whatsapp_plantilla_variables")
      .delete()
      .eq("plantilla_id", plantilla.id);
    if (errorDelete) throw new Error(errorDelete.message);

    if (parsed.data.length > 0) {
      const { error: errorInsert } = await supabase.from("whatsapp_plantilla_variables").insert(
        parsed.data.map((v) => ({ plantilla_id: plantilla.id, indice: v.indice, columna_tecnica: v.columna_tecnica })),
      );
      if (errorInsert) throw new Error(errorInsert.message);
    }

    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});
