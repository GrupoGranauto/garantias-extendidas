import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAccesoSucursal } from "../middleware/auth.js";
import { configPorSucursalId, enviarMensaje } from "../lib/whatsapp.js";
import { emitirEventoChat, suscribirEventosChat } from "../lib/eventosChat.js";

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

/** Listado de conversaciones de la sucursal, más recientes primero. */
whatsappChatRouter.get("/sucursales/:id/whatsapp/conversaciones", async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from("whatsapp_conversaciones")
      .select("id, wa_id, nombre_contacto, ultimo_mensaje_en, no_leidos, creado_en")
      .eq("sucursal_id", req.params.id)
      .order("ultimo_mensaje_en", { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err) {
    next(err);
  }
});

async function obtenerConversacion(sucursalId: string, conversacionId: string) {
  const { data, error } = await getSupabase()
    .from("whatsapp_conversaciones")
    .select("id, wa_id")
    .eq("id", conversacionId)
    .eq("sucursal_id", sucursalId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Mensajes de una conversación, orden cronológico. */
whatsappChatRouter.get("/sucursales/:id/whatsapp/conversaciones/:conversacionId/mensajes", async (req, res, next) => {
  try {
    const conversacion = await obtenerConversacion(req.params.id, req.params.conversacionId);
    if (!conversacion) {
      res.status(404).json({ error: "Conversación no encontrada." });
      return;
    }

    const { data, error } = await getSupabase()
      .from("whatsapp_mensajes")
      .select(
        "id, direccion, tipo, texto, media_url, media_mime_type, media_nombre_archivo, reaccion_emoji, estado, error_detalle, creado_en",
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
    const conversacion = await obtenerConversacion(req.params.id, req.params.conversacionId);
    if (!conversacion) {
      res.status(404).json({ error: "Conversación no encontrada." });
      return;
    }

    const config = await configPorSucursalId(req.params.id);
    if (!config) {
      res.status(400).json({ error: "Esta sucursal no tiene WhatsApp configurado." });
      return;
    }

    const enviado = await enviarMensaje(config, conversacion.wa_id, { tipo: "texto", texto: parsed.data.texto });

    const supabase = getSupabase();
    const { data: mensaje, error: errorInsert } = await supabase
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
      .select("id, direccion, tipo, texto, estado, creado_en")
      .single();
    if (errorInsert) throw new Error(errorInsert.message);

    await supabase
      .from("whatsapp_conversaciones")
      .update({ ultimo_mensaje_en: new Date().toISOString() })
      .eq("id", conversacion.id);

    emitirEventoChat(req.params.id, { tipo: "mensaje_saliente", conversacionId: conversacion.id });

    res.status(201).json(mensaje);
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
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
