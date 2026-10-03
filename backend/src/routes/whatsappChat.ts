import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAccesoSucursal } from "../middleware/auth.js";
import { configPorSucursalId, enviarMensaje } from "../lib/whatsapp.js";
import { emitirEventoChat, suscribirEventosChat } from "../lib/eventosChat.js";
import { buscarContactoPorTelefono } from "../lib/entidades.js";
import { leadsDeContactos, registrarSalienteChat } from "../lib/vinculoWhatsapp.js";

/** Cuántas variables numeradas ({{1}}, {{2}}…) tiene el cuerpo de una plantilla. */
function contarVariablesBody(texto: string): number {
  const coincidencias = texto.match(/\{\{(\d+)\}\}/g) ?? [];
  const numeros = coincidencias.map((m) => Number(m.replace(/\D/g, "")));
  return numeros.length ? Math.max(...numeros) : 0;
}

export const whatsappChatRouter = Router();

whatsappChatRouter.use(requireAuth);
// Cuelga de /sucursales/:id/whatsapp/...: aquí ya hay req.params.id.
whatsappChatRouter.use("/sucursales/:id/whatsapp", requireAccesoSucursal);

/**
 * Tiempo real del chat: SSE en vez de EventSource nativo porque necesitamos
 * mandar el JWT en el header Authorization (EventSource no deja poner
 * headers). El frontend se conecta con fetch + ReadableStream, no con
 * `new EventSource(...)`.
 */
whatsappChatRouter.get("/sucursales/:id/whatsapp/eventos", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");

  const cancelar = suscribirEventosChat(req.params.id, (evento) => {
    res.write(`data: ${JSON.stringify(evento)}\n\n`);
  });

  const ping = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 25000);

  req.on("close", () => {
    clearInterval(ping);
    cancelar();
  });
});

/** Listado de conversaciones de la sucursal, más recientes primero. Por defecto solo las activas (no resueltas). */
whatsappChatRouter.get("/sucursales/:id/whatsapp/conversaciones", async (req, res, next) => {
  try {
    const resueltas = req.query.resueltas === "true";
    let consulta = getSupabase()
      .from("whatsapp_conversaciones")
      .select(
        "id, wa_id, nombre_contacto, ultimo_mensaje_en, ultimo_mensaje_tipo, ultimo_mensaje_texto, ultimo_mensaje_direccion, ultimo_mensaje_estado, ultimo_mensaje_cliente_en, no_leidos, resuelto, asignado_a, creado_en, contacto_id",
      )
      .eq("sucursal_id", req.params.id)
      .eq("resuelto", resueltas);
    // Un asesor con ejecutivo asignado solo ve sus chats (los de su ejecutivo)
    // más los sueltos sin dueño. Un admin ve todos.
    if (req.perfil && req.perfil.rol !== "admin" && req.perfil.ejecutivo_asignado) {
      consulta = consulta.or(`asignado_a.is.null,asignado_a.eq.${req.perfil.ejecutivo_asignado}`);
    }
    if (req.query.no_leidos === "true") consulta = consulta.gt("no_leidos", 0);
    const { data, error } = await consulta.order("ultimo_mensaje_en", { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    // Cada conversación trae a quién corresponde en la base cargada: nombre, campaña, etapa y ejecutivo.
    const lista = data ?? [];
    const leads = await leadsDeContactos([...new Set(lista.map((c) => c.contacto_id as string | null).filter((x): x is string => Boolean(x)))]).catch(() => new Map());
    res.json(lista.map((c) => ({ ...c, lead: (c.contacto_id && leads.get(c.contacto_id as string)) || null })));
  } catch (err) {
    next(err);
  }
});

async function obtenerConversacion(sucursalId: string, conversacionId: string) {
  const { data, error } = await getSupabase()
    .from("whatsapp_conversaciones")
    .select("id, wa_id, ultimo_mensaje_cliente_en, asignado_a")
    .eq("id", conversacionId)
    .eq("sucursal_id", sucursalId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Un asesor con ejecutivo solo puede tocar sus chats o los sueltos. Admin, todos. */
function puedeVerConversacion(
  perfil: { rol: string; ejecutivo_asignado: string | null } | undefined,
  asignadoA: string | null,
): boolean {
  if (!perfil || perfil.rol === "admin" || !perfil.ejecutivo_asignado) return true;
  return asignadoA === null || asignadoA === perfil.ejecutivo_asignado;
}

/**
 * Al contestar un chat suelto (sin dueño), el asesor lo reclama: se marca con su
 * ejecutivo y deja de verse para los demás. No pisa un chat que ya tiene dueño.
 */
async function reclamarSiSuelto(
  sucursalId: string,
  conversacion: { id: string; asignado_a: string | null },
  perfil: { rol: string; ejecutivo_asignado: string | null } | undefined,
): Promise<boolean> {
  if (!perfil || perfil.rol === "admin" || !perfil.ejecutivo_asignado) return false;
  if (conversacion.asignado_a !== null) return false;
  const { error } = await getSupabase()
    .from("whatsapp_conversaciones")
    .update({ asignado_a: perfil.ejecutivo_asignado })
    .eq("id", conversacion.id)
    .is("asignado_a", null); // condición de carrera: solo si sigue suelto
  if (error) throw new Error(error.message);
  return true;
}

const VENTANA_24H_MS = 24 * 60 * 60 * 1000;

/** true si ya no se puede mandar texto/imagen libre — pasaron 24h desde el último mensaje del cliente. */
function ventanaCerrada(ultimoMensajeClienteEn: string | null): boolean {
  if (!ultimoMensajeClienteEn) return true;
  return Date.now() - new Date(ultimoMensajeClienteEn).getTime() > VENTANA_24H_MS;
}

/** Mensajes de una conversación, orden cronológico. */
whatsappChatRouter.get("/sucursales/:id/whatsapp/conversaciones/:conversacionId/mensajes", async (req, res, next) => {
  try {
    const conversacion = await obtenerConversacion(req.params.id, req.params.conversacionId);
    if (!conversacion || !puedeVerConversacion(req.perfil, conversacion.asignado_a)) {
      res.status(404).json({ error: "Conversación no encontrada." });
      return;
    }

    const { data, error } = await getSupabase()
      .from("whatsapp_mensajes")
      .select(
        "id, wa_message_id, direccion, tipo, texto, media_url, media_mime_type, media_nombre_archivo, reaccion_emoji, reaccion_a_wa_message_id, estado, error_detalle, creado_en",
      )
      .eq("conversacion_id", req.params.conversacionId)
      .order("creado_en", { ascending: true });
    if (error) throw new Error(error.message);

    res.json(data ?? []);
  } catch (err) {
    next(err);
  }
});

const enviarSchema = z.object({ texto: z.string().trim().min(1).max(4096) });

/** Manda un mensaje de texto por WhatsApp y lo guarda como saliente. */
whatsappChatRouter.post("/sucursales/:id/whatsapp/conversaciones/:conversacionId/mensajes", async (req, res, next) => {
  const parsed = enviarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Escribe un mensaje." });
    return;
  }

  try {
    const [conversacion, config] = await Promise.all([
      obtenerConversacion(req.params.id, req.params.conversacionId),
      configPorSucursalId(req.params.id),
    ]);
    if (!conversacion || !puedeVerConversacion(req.perfil, conversacion.asignado_a)) {
      res.status(404).json({ error: "Conversación no encontrada." });
      return;
    }
    if (!config) {
      res.status(400).json({ error: "Esta sucursal no tiene WhatsApp configurado." });
      return;
    }
    if (ventanaCerrada(conversacion.ultimo_mensaje_cliente_en)) {
      res.status(400).json({ error: "Ventana de 24h cerrada: manda una plantilla, o espera a que el cliente escriba de nuevo." });
      return;
    }

    const enviado = await enviarMensaje(config, conversacion.wa_id, { tipo: "texto", texto: parsed.data.texto });

    const supabase = getSupabase();
    const [{ data: mensaje, error: errorInsert }] = await Promise.all([
      supabase
        .from("whatsapp_mensajes")
        .insert({
          conversacion_id: conversacion.id,
          sucursal_id: req.params.id,
          wa_message_id: enviado.id,
          direccion: "saliente",
          tipo: "texto",
          texto: parsed.data.texto,
          estado: "enviado",
        })
        .select("id, wa_message_id, direccion, tipo, texto, estado, creado_en")
        .single(),
      supabase
        .from("whatsapp_conversaciones")
        .update({
          ultimo_mensaje_en: new Date().toISOString(),
          ultimo_mensaje_tipo: "texto",
          ultimo_mensaje_texto: parsed.data.texto,
          ultimo_mensaje_direccion: "saliente",
          ultimo_mensaje_wa_message_id: enviado.id,
          ultimo_mensaje_estado: "enviado",
        })
        .eq("id", conversacion.id),
    ]);
    if (errorInsert) throw new Error(errorInsert.message);

    // Si era un chat suelto, contestarlo lo reclama para este asesor (realtime
    // de Supabase se encarga de quitárselo a los demás en vivo).
    await reclamarSiSuelto(req.params.id, conversacion, req.perfil);

    emitirEventoChat(req.params.id, { tipo: "mensaje_saliente", conversacionId: conversacion.id });

    // Lo que se manda desde el chat también queda en el historial de la oportunidad.

    void registrarSalienteChat(req.params.id, conversacion.id).catch(() => {});

    res.status(201).json(mensaje);
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

const enviarMediaSchema = z.object({
  nombre_archivo: z.string().trim().min(1).max(200),
  tipo_mime: z.enum(["image/jpeg", "image/png"]),
  contenido_base64: z.string().trim().min(1),
  caption: z.string().trim().max(1024).optional(),
});

/** Manda una imagen por WhatsApp (sube a Storage propio, la referencia como link) y la guarda como saliente. */
whatsappChatRouter.post("/sucursales/:id/whatsapp/conversaciones/:conversacionId/media", async (req, res, next) => {
  const parsed = enviarMediaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Archivo inválido. Usa JPG o PNG." });
    return;
  }

  try {
    const [conversacion, config] = await Promise.all([
      obtenerConversacion(req.params.id, req.params.conversacionId),
      configPorSucursalId(req.params.id),
    ]);
    if (!conversacion || !puedeVerConversacion(req.perfil, conversacion.asignado_a)) {
      res.status(404).json({ error: "Conversación no encontrada." });
      return;
    }
    if (!config) {
      res.status(400).json({ error: "Esta sucursal no tiene WhatsApp configurado." });
      return;
    }
    if (ventanaCerrada(conversacion.ultimo_mensaje_cliente_en)) {
      res.status(400).json({ error: "Ventana de 24h cerrada: manda una plantilla, o espera a que el cliente escriba de nuevo." });
      return;
    }

    const base64Puro = parsed.data.contenido_base64.replace(/^data:[^;]+;base64,/, "");
    const archivo = Buffer.from(base64Puro, "base64");

    const supabase = getSupabase();
    const extension = parsed.data.tipo_mime.split("/")[1] ?? "bin";
    const ruta = `salientes/${req.params.id}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const { error: errorSubida } = await supabase.storage
      .from("whatsapp-media")
      .upload(ruta, archivo, { contentType: parsed.data.tipo_mime, upsert: false });
    if (errorSubida) throw new Error(errorSubida.message);

    const { data: publica } = supabase.storage.from("whatsapp-media").getPublicUrl(ruta);

    const enviado = await enviarMensaje(config, conversacion.wa_id, {
      tipo: "imagen",
      url: publica.publicUrl,
      caption: parsed.data.caption,
    });

    const [{ data: mensaje, error: errorInsert }] = await Promise.all([
      supabase
        .from("whatsapp_mensajes")
        .insert({
          conversacion_id: conversacion.id,
          sucursal_id: req.params.id,
          wa_message_id: enviado.id,
          direccion: "saliente",
          tipo: "imagen",
          texto: parsed.data.caption ?? null,
          media_url: publica.publicUrl,
          media_mime_type: parsed.data.tipo_mime,
          estado: "enviado",
        })
        .select(
          "id, wa_message_id, direccion, tipo, texto, media_url, media_mime_type, media_nombre_archivo, estado, creado_en",
        )
        .single(),
      supabase
        .from("whatsapp_conversaciones")
        .update({
          ultimo_mensaje_en: new Date().toISOString(),
          ultimo_mensaje_tipo: "imagen",
          ultimo_mensaje_texto: parsed.data.caption ?? null,
          ultimo_mensaje_direccion: "saliente",
          ultimo_mensaje_wa_message_id: enviado.id,
          ultimo_mensaje_estado: "enviado",
        })
        .eq("id", conversacion.id),
    ]);
    if (errorInsert) throw new Error(errorInsert.message);

    await reclamarSiSuelto(req.params.id, conversacion, req.perfil);

    emitirEventoChat(req.params.id, { tipo: "mensaje_saliente", conversacionId: conversacion.id });

    // Lo que se manda desde el chat también queda en el historial de la oportunidad.

    void registrarSalienteChat(req.params.id, conversacion.id).catch(() => {});

    res.status(201).json(mensaje);
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

const resolverSchema = z.object({ resuelto: z.boolean() });

/** Resuelve o reabre la conversación (la saca o la mete de vuelta a la lista activa). */
whatsappChatRouter.post("/sucursales/:id/whatsapp/conversaciones/:conversacionId/resolver", async (req, res, next) => {
  const parsed = resolverSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }

  try {
    const { error } = await getSupabase()
      .from("whatsapp_conversaciones")
      .update({ resuelto: parsed.data.resuelto })
      .eq("id", req.params.conversacionId)
      .eq("sucursal_id", req.params.id);
    if (error) throw new Error(error.message);

    emitirEventoChat(req.params.id, { tipo: "estado_actualizado", conversacionId: req.params.conversacionId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Marca la conversación como leída (limpia el contador de no leídos). */
whatsappChatRouter.post("/sucursales/:id/whatsapp/conversaciones/:conversacionId/leido", async (req, res, next) => {
  try {
    const { error } = await getSupabase()
      .from("whatsapp_conversaciones")
      .update({ no_leidos: 0 })
      .eq("id", req.params.conversacionId)
      .eq("sucursal_id", req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

type ComponentesPlantilla = { header: { tipo: string; texto?: string } | null; body: { texto: string } };

/**
 * Plantillas listas para mandar con "/" desde el chat: aprobadas, con
 * encabezado de texto (o sin encabezado) — uno con imagen/video/documento
 * necesitaría ese archivo en cada envío, no lo soporta este atajo — y, si
 * tiene variables, con TODAS mapeadas a una columna de la Base de Datos.
 */
whatsappChatRouter.get("/sucursales/:id/whatsapp/plantillas-disponibles", async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { data: plantillas, error } = await supabase
      .from("whatsapp_plantillas")
      .select("id, nombre, nombre_tecnico, idioma, componentes")
      .eq("sucursal_id", req.params.id)
      .eq("estado", "aprobada");
    if (error) throw new Error(error.message);

    const ids = (plantillas ?? []).map((p) => p.id);
    const { data: variables } = ids.length
      ? await supabase.from("whatsapp_plantilla_variables").select("plantilla_id, indice").in("plantilla_id", ids)
      : { data: [] as { plantilla_id: string; indice: number }[] };

    const indicesPorPlantilla = new Map<string, Set<number>>();
    for (const v of variables ?? []) {
      if (!indicesPorPlantilla.has(v.plantilla_id)) indicesPorPlantilla.set(v.plantilla_id, new Set());
      indicesPorPlantilla.get(v.plantilla_id)!.add(v.indice);
    }

    const disponibles = (plantillas ?? [])
      .filter((p) => {
        const componentes = p.componentes as ComponentesPlantilla;
        if (componentes.header && componentes.header.tipo !== "texto") return false;
        const numVariables = contarVariablesBody(componentes.body.texto);
        if (numVariables === 0) return true;
        const indices = indicesPorPlantilla.get(p.id);
        if (!indices) return false;
        for (let i = 1; i <= numVariables; i++) if (!indices.has(i)) return false;
        return true;
      })
      .map((p) => {
        const componentes = p.componentes as ComponentesPlantilla;
        const encabezado = componentes.header?.tipo === "texto" ? componentes.header.texto ?? "" : "";
        const preview = [encabezado, componentes.body.texto].filter(Boolean).join("\n");
        return { id: p.id, nombre: p.nombre, nombre_tecnico: p.nombre_tecnico, idioma: p.idioma, preview };
      });

    res.json(disponibles);
  } catch (err) {
    next(err);
  }
});

const enviarPlantillaSchema = z.object({ plantilla_id: z.string().uuid() });

/**
 * Manda una plantilla aprobada al chat: llena sus variables automáticamente
 * buscando al contacto en la Base de Datos de la sucursal por teléfono
 * (últimos 10 dígitos). Si no hay match, o falta el dato, esa variable
 * se manda vacía — nunca bloquea el envío por eso.
 */
whatsappChatRouter.post(
  "/sucursales/:id/whatsapp/conversaciones/:conversacionId/plantilla",
  async (req, res, next) => {
    const parsed = enviarPlantillaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Datos inválidos." });
      return;
    }

    try {
      const [conversacion, config] = await Promise.all([
        obtenerConversacion(req.params.id, req.params.conversacionId),
        configPorSucursalId(req.params.id),
      ]);
      if (!conversacion || !puedeVerConversacion(req.perfil, conversacion.asignado_a)) {
        res.status(404).json({ error: "Conversación no encontrada." });
        return;
      }
      if (!config) {
        res.status(400).json({ error: "Esta sucursal no tiene WhatsApp configurado." });
        return;
      }

      const supabase = getSupabase();
      const { data: plantilla, error: errorPlantilla } = await supabase
        .from("whatsapp_plantillas")
        .select("id, nombre_tecnico, idioma, estado, componentes")
        .eq("sucursal_id", req.params.id)
        .eq("id", parsed.data.plantilla_id)
        .maybeSingle();
      if (errorPlantilla) throw new Error(errorPlantilla.message);
      if (!plantilla || plantilla.estado !== "aprobada") {
        res.status(400).json({ error: "Plantilla no disponible." });
        return;
      }

      const componentes = plantilla.componentes as ComponentesPlantilla;
      if (componentes.header && componentes.header.tipo !== "texto") {
        res.status(400).json({ error: "Esta plantilla tiene un encabezado de imagen/video/documento; no se puede mandar así." });
        return;
      }

      const numVariables = contarVariablesBody(componentes.body.texto);
      let parametros: string[] = [];
      let textoRenderizado = componentes.body.texto;

      if (numVariables > 0) {
        const { data: mapeos, error: errorMapeos } = await supabase
          .from("whatsapp_plantilla_variables")
          .select("indice, columna_tecnica")
          .eq("plantilla_id", plantilla.id);
        if (errorMapeos) throw new Error(errorMapeos.message);

        const columnasOrdenadas: (string | null)[] = Array.from({ length: numVariables }, () => null);
        for (const m of mapeos ?? []) {
          if (m.indice >= 1 && m.indice <= numVariables) columnasOrdenadas[m.indice - 1] = m.columna_tecnica;
        }
        if (columnasOrdenadas.some((c) => c === null)) {
          res.status(400).json({ error: "Esta plantilla tiene variables sin columna asignada. Configúralas en Plantillas." });
          return;
        }

        let fila: Record<string, unknown> | null = null;
        if (config.columna_telefono) {
          const [{ data: sucursal }, { data: definicion }] = await Promise.all([
            supabase.from("sucursales").select("subdominio").eq("id", req.params.id).maybeSingle(),
            supabase.from("entidad_definiciones").select("nombre_tecnico").eq("sucursal_id", req.params.id).maybeSingle(),
          ]);
          if (sucursal && definicion) {
            fila = await buscarContactoPorTelefono(
              sucursal.subdominio,
              definicion.nombre_tecnico,
              config.columna_telefono,
              columnasOrdenadas as string[],
              conversacion.wa_id,
              req.params.id,
            );
          }
        }

        parametros = columnasOrdenadas.map((columna) => {
          const valor = fila?.[columna as string];
          return valor === null || valor === undefined ? "" : String(valor);
        });

        let i = 0;
        textoRenderizado = componentes.body.texto.replace(/\{\{\d+\}\}/g, () => parametros[i++] ?? "");
      }

      const enviado = await enviarMensaje(config, conversacion.wa_id, {
        tipo: "plantilla",
        nombreTecnico: plantilla.nombre_tecnico,
        idioma: plantilla.idioma,
        parametrosBody: parametros,
      });

      const [{ data: mensaje, error: errorInsert }] = await Promise.all([
        supabase
          .from("whatsapp_mensajes")
          .insert({
            conversacion_id: conversacion.id,
            sucursal_id: req.params.id,
            wa_message_id: enviado.id,
            direccion: "saliente",
            tipo: "texto",
            texto: textoRenderizado,
            estado: "enviado",
          })
          .select("id, wa_message_id, direccion, tipo, texto, estado, creado_en")
          .single(),
        supabase
          .from("whatsapp_conversaciones")
          .update({
            ultimo_mensaje_en: new Date().toISOString(),
            ultimo_mensaje_tipo: "texto",
            ultimo_mensaje_texto: textoRenderizado,
            ultimo_mensaje_direccion: "saliente",
            ultimo_mensaje_wa_message_id: enviado.id,
            ultimo_mensaje_estado: "enviado",
          })
          .eq("id", conversacion.id),
      ]);
      if (errorInsert) throw new Error(errorInsert.message);

      await reclamarSiSuelto(req.params.id, conversacion, req.perfil);

      emitirEventoChat(req.params.id, { tipo: "mensaje_saliente", conversacionId: conversacion.id });

      // Lo que se manda desde el chat también queda en el historial de la oportunidad.

      void registrarSalienteChat(req.params.id, conversacion.id).catch(() => {});

      res.status(201).json(mensaje);
    } catch (err) {
      if (err instanceof Error) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
);
