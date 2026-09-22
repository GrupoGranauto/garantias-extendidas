import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import {
  configPorPhoneNumberId,
  descargarMedia,
  estadoDesdeMeta,
  firmaValida,
  type ConfigSucursal,
} from "../lib/whatsapp.js";

export const webhookWhatsappRouter = Router();

/* ============================================================
   Verificación (GET): la hace Meta una sola vez, al configurar
   el webhook en la App. No trae phone_number_id, así que se
   busca qué sucursal tiene ese verify_token exacto.
   ============================================================ */
webhookWhatsappRouter.get("/", async (req, res) => {
  const modo = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (modo !== "subscribe" || typeof token !== "string" || typeof challenge !== "string") {
    res.sendStatus(403);
    return;
  }

  try {
    const { data } = await getSupabase()
      .from("whatsapp_config")
      .select("id")
      .eq("webhook_verify_token", token)
      .maybeSingle();

    if (!data) {
      res.sendStatus(403);
      return;
    }

    // Meta exige el challenge tal cual, en texto plano
    res.status(200).type("text/plain").send(challenge);
  } catch (err) {
    console.error("Error verificando webhook de WhatsApp:", err);
    res.sendStatus(500);
  }
});

/* ============================================================
   Tipos mínimos del payload de Meta. La API trae más campos de
   los que usamos; se leen con optional chaining y lo no
   contemplado cae en tipo "sistema" sin perder el dato crudo.
   ============================================================ */

type MensajeEntrante = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  context?: { id: string };
  text?: { body: string };
  image?: { id: string; caption?: string };
  video?: { id: string; caption?: string };
  audio?: { id: string };
  document?: { id: string; filename?: string; caption?: string };
  sticker?: { id: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: unknown;
  reaction?: { message_id: string; emoji?: string };
};

type EstadoMensaje = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  errors?: { title: string; message?: string }[];
};

type ValorWebhook = {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: MensajeEntrante[];
  statuses?: EstadoMensaje[];
};

type ValorPlantilla = {
  event: string;
  message_template_id: number;
  message_template_name: string;
  message_template_language: string;
  reason?: string | null;
};

/**
 * A diferencia de "messages", este evento llega a nivel de WABA (no trae
 * phone_number_id), así que la sucursal se identifica por el id de plantilla
 * de Meta, que ya quedó guardado al mandarla a revisión.
 */
async function procesarActualizacionPlantilla(valor: ValorPlantilla, cuerpoCrudo: Buffer, firmaHeader: string | undefined) {
  const supabase = getSupabase();
  const { data: plantilla } = await supabase
    .from("whatsapp_plantillas")
    .select("id, sucursal_id")
    .eq("meta_template_id", String(valor.message_template_id))
    .maybeSingle();

  if (!plantilla) return;

  const { data: config } = await supabase
    .from("whatsapp_config")
    .select("app_secret")
    .eq("sucursal_id", plantilla.sucursal_id)
    .maybeSingle();

  if (config?.app_secret && !firmaValida(cuerpoCrudo, firmaHeader, config.app_secret)) {
    console.warn(`Firma inválida en webhook de plantilla (sucursal ${plantilla.sucursal_id})`);
    return;
  }

  await supabase
    .from("whatsapp_plantillas")
    .update({
      estado: estadoDesdeMeta(valor.event),
      motivo_rechazo: valor.reason ?? null,
      actualizado_en: new Date().toISOString(),
    })
    .eq("id", plantilla.id);
}

const MAPA_ESTADO: Record<EstadoMensaje["status"], string> = {
  sent: "enviado",
  delivered: "entregado",
  read: "leido",
  failed: "fallido",
};

/** Sube el medio a Storage propio; si falla, el mensaje se guarda igual (sin URL) en vez de perderse. */
async function intentarDescargarMedia(mediaId: string, config: ConfigSucursal) {
  try {
    return await descargarMedia(mediaId, config.access_token, config.sucursal_id);
  } catch (err) {
    console.error(`No se pudo descargar media ${mediaId} (sucursal ${config.sucursal_id}):`, err);
    return null;
  }
}

async function obtenerOCrearConversacion(sucursalId: string, waId: string, nombreContacto?: string) {
  const supabase = getSupabase();

  const { data: existente } = await supabase
    .from("whatsapp_conversaciones")
    .select("id, no_leidos")
    .eq("sucursal_id", sucursalId)
    .eq("wa_id", waId)
    .maybeSingle();

  if (existente) {
    const cambios: Record<string, unknown> = {
      ultimo_mensaje_en: new Date().toISOString(),
      no_leidos: existente.no_leidos + 1,
    };
    if (nombreContacto) cambios.nombre_contacto = nombreContacto;

    await supabase.from("whatsapp_conversaciones").update(cambios).eq("id", existente.id);
    return existente.id as string;
  }

  const { data: creada, error } = await supabase
    .from("whatsapp_conversaciones")
    .insert({
      sucursal_id: sucursalId,
      wa_id: waId,
      nombre_contacto: nombreContacto ?? null,
      ultimo_mensaje_en: new Date().toISOString(),
      no_leidos: 1,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return creada.id as string;
}

async function procesarMensajeEntrante(msg: MensajeEntrante, config: ConfigSucursal, nombreContacto?: string) {
  const conversacionId = await obtenerOCrearConversacion(config.sucursal_id, msg.from, nombreContacto);

  const fila: Record<string, unknown> = {
    conversacion_id: conversacionId,
    sucursal_id: config.sucursal_id,
    wa_message_id: msg.id,
    direccion: "entrante",
    responde_a_wa_message_id: msg.context?.id ?? null,
  };

  switch (msg.type) {
    case "text":
      fila.tipo = "texto";
      fila.texto = msg.text?.body ?? "";
      break;

    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const mediaId = msg[msg.type]?.id;
      fila.tipo = msg.type === "image" ? "imagen" : msg.type === "document" ? "documento" : msg.type;
      if ("caption" in (msg[msg.type] ?? {})) {
        fila.texto = (msg[msg.type] as { caption?: string }).caption ?? null;
      }
      if (msg.type === "document") {
        fila.media_nombre_archivo = msg.document?.filename ?? null;
      }
      if (mediaId) {
        const media = await intentarDescargarMedia(mediaId, config);
        if (media) {
          fila.media_url = media.url;
          fila.media_mime_type = media.mimeType;
        }
      }
      break;
    }

    case "location":
      fila.tipo = "ubicacion";
      fila.latitud = msg.location?.latitude ?? null;
      fila.longitud = msg.location?.longitude ?? null;
      fila.texto = msg.location?.name ?? msg.location?.address ?? null;
      break;

    case "contacts":
      fila.tipo = "contacto";
      fila.texto = JSON.stringify(msg.contacts ?? null);
      break;

    case "reaction":
      fila.tipo = "reaccion";
      fila.reaccion_emoji = msg.reaction?.emoji ?? null;
      fila.reaccion_a_wa_message_id = msg.reaction?.message_id ?? null;
      break;

    default:
      // Tipos que Meta agregue después (botones, interactivos, pedidos…):
      // no se pierden, quedan como JSON crudo para revisar manualmente.
      fila.tipo = "sistema";
      fila.texto = JSON.stringify(msg);
  }

  const { error } = await getSupabase().from("whatsapp_mensajes").insert(fila);
  if (error) throw new Error(error.message);
}

async function procesarActualizacionEstado(estado: EstadoMensaje) {
  const cambios: Record<string, unknown> = { estado: MAPA_ESTADO[estado.status] };
  if (estado.status === "failed" && estado.errors?.[0]) {
    cambios.error_detalle = estado.errors[0].message ?? estado.errors[0].title;
  }

  // No hay fila que actualizar si el mensaje no es nuestro (ajeno a esta sucursal)
  // o si el estado llegó antes que el insert del mensaje saliente; se ignora en silencio.
  await getSupabase().from("whatsapp_mensajes").update(cambios).eq("wa_message_id", estado.id);
}

/* ============================================================
   Recepción (POST): un evento por mensaje, reacción o cambio
   de estado. Requiere el cuerpo *crudo* para validar la firma
   — por eso el router se monta con express.raw(), no express.json().
   ============================================================ */
webhookWhatsappRouter.post("/", async (req, res) => {
  const cuerpoCrudo = req.body as Buffer;
  const firmaHeader = req.header("x-hub-signature-256");

  let payload: { entry?: { changes?: { field?: string; value?: ValorWebhook | ValorPlantilla }[] }[] };
  try {
    payload = JSON.parse(cuerpoCrudo.toString("utf-8"));
  } catch {
    res.sendStatus(400);
    return;
  }

  const cambios = (payload.entry ?? []).flatMap((entry) => entry.changes ?? []);

  try {
    for (const cambio of cambios) {
      if (cambio.field === "message_template_status_update") {
        await procesarActualizacionPlantilla(cambio.value as ValorPlantilla, cuerpoCrudo, firmaHeader);
        continue;
      }

      // Evento de mensajes (o campo ausente, forma legacy): sí requiere
      // phone_number_id para saber a qué sucursal pertenece.
      const value = cambio.value as ValorWebhook | undefined;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!value || !phoneNumberId) continue;

      const config = await configPorPhoneNumberId(phoneNumberId);
      if (!config) {
        console.warn(`Webhook de WhatsApp para un phone_number_id no configurado: ${phoneNumberId}`);
        continue;
      }

      if (config.app_secret && !firmaValida(cuerpoCrudo, firmaHeader, config.app_secret)) {
        console.warn(`Firma inválida en webhook de WhatsApp (sucursal ${config.sucursal_id})`);
        continue;
      }

      const nombresPorWaId = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name] as const),
      );

      for (const msg of value.messages ?? []) {
        await procesarMensajeEntrante(msg, config, nombresPorWaId.get(msg.from));
      }

      for (const estado of value.statuses ?? []) {
        await procesarActualizacionEstado(estado);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    // 200 igual: si el bug es nuestro, que no dispare una tormenta de
    // reintentos de Meta. El error ya quedó en logs para revisar.
    console.error("Error procesando webhook de WhatsApp:", err);
    res.sendStatus(200);
  }
});
