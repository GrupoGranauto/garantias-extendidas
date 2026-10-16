import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import {
  configPorPhoneNumberId,
  descargarMedia,
  estadoDesdeMeta,
  firmaValida,
  type ConfigSucursal,
} from "../lib/whatsapp.js";
import { emitirEventoChat } from "../lib/eventosChat.js";
import { motivoFallaWhatsApp } from "../lib/erroresMeta.js";
import { procesarAhoraNo, procesarBaja, registrarEstadoEnvio } from "../lib/campanasEnvio.js";
import { buscarVinculo, elegirConversacion, registrarEntrante, type Vinculo } from "../lib/vinculoWhatsapp.js";
import { esAhoraNo, esPeticionDeBaja, telefono10, textoEntrante } from "../lib/campanasLogica.js";
import { buscarContactoPorTelefono } from "../lib/entidades.js";
import { getPool } from "../lib/db.js";

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
  /** Botón de respuesta rápida de una plantilla. */
  button?: { text?: string; payload?: string };
  /** Botón o elemento de lista de un mensaje interactivo. */
  interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
};

type EstadoMensaje = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  errors?: { code?: number; title: string; message?: string }[];
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

/** Meta cambió la categoría de una plantilla ya registrada (por ejemplo, de Utilidad a Marketing). */
type ValorCategoria = {
  message_template_id: number;
  new_category?: string;
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

  // Sin secreto de la app no hay forma de saber que el aviso viene de Meta: se ignora.
  if (!config?.app_secret || !firmaValida(cuerpoCrudo, firmaHeader, config.app_secret)) {
    console.warn(`Webhook de plantilla sin firma válida (sucursal ${plantilla.sucursal_id}): se ignora`);
    return;
  }

  await supabase
    .from("whatsapp_plantillas")
    .update({
      estado: estadoDesdeMeta(valor.event),
      // Meta manda "NONE" cuando no hay motivo (al aprobar).
      motivo_rechazo: valor.reason && valor.reason !== "NONE" ? valor.reason : null,
      actualizado_en: new Date().toISOString(),
    })
    .eq("id", plantilla.id);
}

/** Igual que el cambio de estado: llega a nivel de WABA y se identifica por el id de plantilla de Meta. */
async function procesarCambioCategoria(valor: ValorCategoria, cuerpoCrudo: Buffer, firmaHeader: string | undefined) {
  const categoria = valor.new_category?.toLowerCase();
  if (categoria !== "marketing" && categoria !== "utility" && categoria !== "authentication") return;

  const supabase = getSupabase();
  const { data: plantilla } = await supabase
    .from("whatsapp_plantillas")
    .select("id, sucursal_id")
    .eq("meta_template_id", String(valor.message_template_id))
    .maybeSingle();
  if (!plantilla) return;

  const { data: config } = await supabase.from("whatsapp_config").select("app_secret").eq("sucursal_id", plantilla.sucursal_id).maybeSingle();
  if (!config?.app_secret || !firmaValida(cuerpoCrudo, firmaHeader, config.app_secret)) {
    console.warn(`Webhook de categoría de plantilla sin firma válida (sucursal ${plantilla.sucursal_id}): se ignora`);
    return;
  }

  await supabase.from("whatsapp_plantillas").update({ categoria, actualizado_en: new Date().toISOString() }).eq("id", plantilla.id);
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

const ETIQUETAS_TIPO: Record<string, string> = {
  imagen: "Foto",
  video: "Video",
  audio: "Audio",
  documento: "Documento",
  sticker: "Sticker",
  ubicacion: "Ubicación",
  contacto: "Contacto",
};

/** Descripción corta del mensaje al que se reaccionó, como en WhatsApp ("hola", "Sticker", "Foto"…). */
async function descripcionMensajePorWaId(waMessageId: string): Promise<string | null> {
  const { data } = await getSupabase()
    .from("whatsapp_mensajes")
    .select("tipo, texto")
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  if (!data) return null;
  if (data.tipo === "texto") return (data.texto ?? "").slice(0, 40);
  return ETIQUETAS_TIPO[data.tipo] ?? data.tipo;
}

/**
 * Si el teléfono del cliente cruza con un lead de la Base de Datos, devuelve el
 * ejecutivo dueño de ese lead; si no hay match (o no está configurada la columna
 * de ejecutivo/teléfono), null. Sirve para asignar la conversación al dueño.
 */
async function resolverEjecutivoDeLead(config: ConfigSucursal, waId: string): Promise<string | null> {
  if (!config.columna_telefono) return null;
  const supabase = getSupabase();
  const [{ data: sucursal }, { data: definicion }] = await Promise.all([
    supabase.from("sucursales").select("subdominio").eq("id", config.sucursal_id).maybeSingle(),
    supabase
      .from("entidad_definiciones")
      .select("nombre_tecnico, columna_ejecutivo")
      .eq("sucursal_id", config.sucursal_id)
      .maybeSingle(),
  ]);
  if (!sucursal || !definicion || !definicion.columna_ejecutivo) return null;

  const fila = await buscarContactoPorTelefono(
    sucursal.subdominio,
    definicion.nombre_tecnico,
    config.columna_telefono,
    [definicion.columna_ejecutivo],
    waId,
    config.sucursal_id,
  );
  const valor = fila?.[definicion.columna_ejecutivo];
  return valor === null || valor === undefined || valor === "" ? null : String(valor);
}

/** Conversación de la sucursal que corresponde al wa_id: exacta o con los mismos últimos 10 dígitos (elegirConversacion). */
async function buscarConversacion(sucursalId: string, waId: string) {
  const { rows } = await getPool().query(
    `SELECT id, wa_id, ultimo_mensaje_en FROM whatsapp_conversaciones
      WHERE sucursal_id = $1 AND (wa_id = $2 OR ($3::text IS NOT NULL AND right(regexp_replace(wa_id, '\\D', '', 'g'), 10) = $3))`,
    [sucursalId, waId, telefono10(waId)],
  );
  return elegirConversacion(rows as { id: string; wa_id: string; ultimo_mensaje_en: Date | null }[], waId);
}

async function obtenerOCrearConversacion(
  sucursalId: string,
  waId: string,
  nombreContacto: string | undefined,
  waMessageId: string,
  tipoPreview: string,
  textoPreview: string | null,
  asignadoA: string | null,
  contactoId: string | null,
) {
  const pool = getPool();

  let existente = await buscarConversacion(sucursalId, waId);
  if (!existente) {
    // Dueño inicial: el ejecutivo del lead si el teléfono cruza; si no, queda
    // suelto (null) y lo verán todos los asesores hasta que alguien conteste.
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_conversaciones (sucursal_id, wa_id, nombre_contacto, ultimo_mensaje_en, ultimo_mensaje_cliente_en, no_leidos,
              ultimo_mensaje_tipo, ultimo_mensaje_texto, ultimo_mensaje_direccion, ultimo_mensaje_wa_message_id, asignado_a, contacto_id)
       VALUES ($1, $2, $3, now(), now(), 1, $4, $5, 'entrante', $6, $7, $8)
       ON CONFLICT (sucursal_id, wa_id) DO NOTHING RETURNING id`,
      [sucursalId, waId, nombreContacto || null, tipoPreview, textoPreview, waMessageId, asignadoA, contactoId],
    );
    if (rows[0]) return rows[0].id as string;
    // Otro mensaje de la misma persona la creó al mismo tiempo: se usa esa.
    existente = await buscarConversacion(sucursalId, waId);
    if (!existente) throw new Error("No se pudo crear la conversación de WhatsApp.");
  }

  // Si la conversación aún no estaba ligada a la base o no tenía dueño, ahora sí.
  await pool.query(
    `UPDATE whatsapp_conversaciones
        SET ultimo_mensaje_en = now(), ultimo_mensaje_cliente_en = now(), no_leidos = no_leidos + 1,
            ultimo_mensaje_tipo = $2, ultimo_mensaje_texto = $3, ultimo_mensaje_direccion = 'entrante',
            ultimo_mensaje_wa_message_id = $4, ultimo_mensaje_estado = NULL,
            nombre_contacto = coalesce($5, nombre_contacto), contacto_id = coalesce(contacto_id, $6),
            asignado_a = coalesce(asignado_a, $7)
      WHERE id = $1`,
    [existente.id, tipoPreview, textoPreview, waMessageId, nombreContacto || null, contactoId, asignadoA],
  );

  // La encontró con otro formato (la creó el masivo como 52 + 10 dígitos): se queda con el wa_id que manda Meta. Si en ese
  // instante otra conversación ya tiene ese wa_id, se conserva el anterior; el chat sigue funcionando con cualquiera.
  if (existente.wa_id !== waId) {
    await pool
      .query(
        `UPDATE whatsapp_conversaciones SET wa_id = $2
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM whatsapp_conversaciones x WHERE x.sucursal_id = $3 AND x.wa_id = $2)`,
        [existente.id, waId, sucursalId],
      )
      .catch(() => console.error("[whatsapp] no se pudo actualizar el número de una conversación"));
  }
  return existente.id;
}

/** «BAJA», «STOP»… y «Ahora no». Cada uno falla por separado y nunca depende de que se pueda guardar el chat. */
async function atenderBajaOAhoraNo(msg: MensajeEntrante, config: ConfigSucursal) {
  const escrito = textoEntrante(msg);
  const tel = telefono10(msg.from);
  if (escrito === null || !tel) return;
  if (esPeticionDeBaja(escrito)) {
    // El contacto pidió no recibir más. Se respeta de inmediato y para siempre, esté o no en la base.
    try {
      await procesarBaja(config.sucursal_id, tel, msg.id);
    } catch {
      console.error("[campanas] no se pudo registrar una baja");
    }
  } else if (esAhoraNo(escrito)) {
    // «Ahora no»: no es baja. Se pausa solo la campaña que le escribió; la siguiente campaña lo vuelve a contactar.
    try {
      await procesarAhoraNo(config.sucursal_id, tel);
    } catch {
      console.error("[campanas] no se pudo registrar un «Ahora no»");
    }
  }
}

async function procesarMensajeEntrante(msg: MensajeEntrante, config: ConfigSucursal, nombreContacto?: string) {
  // Meta puede volver a mandar el mismo evento: si el mensaje ya está guardado, ya se atendió (incluida su baja).
  const yaGuardado = await getPool()
    .query(`SELECT 1 FROM whatsapp_mensajes WHERE wa_message_id = $1`, [msg.id])
    .then((r) => (r.rowCount ?? 0) > 0)
    .catch(() => false);
  if (yaGuardado) return;

  const fila: Record<string, unknown> = {
    sucursal_id: config.sucursal_id,
    wa_message_id: msg.id,
    direccion: "entrante",
    responde_a_wa_message_id: msg.context?.id ?? null,
  };

  switch (msg.type) {
    case "text":
    case "button":
    case "interactive":
      // Un botón elegido se ve y se trata como texto (lo que dice el botón).
      fila.tipo = "texto";
      fila.texto = textoEntrante(msg) ?? "";
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

    case "reaction": {
      fila.tipo = "reaccion";
      const emoji = msg.reaction?.emoji ?? null;
      fila.reaccion_emoji = emoji;
      fila.reaccion_a_wa_message_id = msg.reaction?.message_id ?? null;
      if (emoji && msg.reaction?.message_id) {
        const objetivo = await descripcionMensajePorWaId(msg.reaction.message_id);
        fila.texto = objetivo ? `Reaccionó con ${emoji} a "${objetivo}"` : `Reaccionó con ${emoji}`;
      }
      break;
    }

    default:
      // Tipos que Meta agregue después (botones, interactivos, pedidos…):
      // no se pierden, quedan como JSON crudo para revisar manualmente.
      fila.tipo = "sistema";
      fila.texto = JSON.stringify(msg);
  }

  // La baja y el «Ahora no» van antes que todo lo demás: si después falla el chat o el vínculo con la base, no se pierden.
  await atenderBajaOAhoraNo(msg, config);

  // Primero se busca a la persona en la base cargada en la web (por teléfono); la columna configurada a mano
  // queda solo como respaldo para sucursales que aún no usan el CRM.
  const vinculo: Vinculo | null = await buscarVinculo(config.sucursal_id, msg.from).catch(() => null);
  const ejecutivoDeLead = vinculo?.ejecutivo ?? (await resolverEjecutivoDeLead(config, msg.from));
  const conversacionId = await obtenerOCrearConversacion(
    config.sucursal_id,
    msg.from,
    nombreContacto,
    msg.id,
    fila.tipo as string,
    (fila.texto as string | null | undefined) ?? null,
    ejecutivoDeLead,
    vinculo?.contacto_id ?? null,
  );
  fila.conversacion_id = conversacionId;

  const { error } = await getSupabase().from("whatsapp_mensajes").insert(fila);
  if (error) throw new Error(error.message);

  // Lo que escribió el cliente queda en el historial de su oportunidad y cae en la cola «por clasificar» (salvo una baja:
  // registrarEntrante no abre la cola a quien la pidió, y la baja ya quedó registrada arriba).
  if (vinculo) {
    try {
      await registrarEntrante(config.sucursal_id, vinculo, fila.tipo === "texto" ? String(fila.texto ?? "") : `(${String(fila.tipo)})`);
    } catch {
      console.error("[whatsapp] no se pudo registrar el mensaje en el historial");
    }
  }

  emitirEventoChat(config.sucursal_id, { tipo: "mensaje_entrante", conversacionId });
}

async function procesarActualizacionEstado(estado: EstadoMensaje) {
  const cambios: Record<string, unknown> = { estado: MAPA_ESTADO[estado.status] };
  const falla = estado.status === "failed" && estado.errors?.[0] ? estado.errors[0] : null;
  const motivo = falla ? motivoFallaWhatsApp(falla.code, falla.message ?? falla.title) : null;
  if (motivo) cambios.error_detalle = motivo;

  // Si el mensaje era de una campaña, su envío también pasa a entregado / leído / fallido.
  try {
    await registrarEstadoEnvio(
      estado.id,
      MAPA_ESTADO[estado.status] as "enviado" | "entregado" | "leido" | "fallido",
      motivo,
      falla?.code ?? null,
    );
  } catch {
    console.error("[campanas] no se pudo actualizar el estado del envío");
  }

  // No hay fila que actualizar si el mensaje no es nuestro (ajeno a esta sucursal)
  // o si el estado llegó antes que el insert del mensaje saliente; se ignora en silencio.
  const { data } = await getSupabase()
    .from("whatsapp_mensajes")
    .update(cambios)
    .eq("wa_message_id", estado.id)
    .select("conversacion_id, sucursal_id")
    .maybeSingle();

  if (data) {
    // Solo si este mensaje sigue siendo el último de la conversación: si ya
    // se mandó otro después, ese estado atrasado no debe pisar el preview.
    await getSupabase()
      .from("whatsapp_conversaciones")
      .update({ ultimo_mensaje_estado: MAPA_ESTADO[estado.status] })
      .eq("id", data.conversacion_id)
      .eq("ultimo_mensaje_wa_message_id", estado.id);

    emitirEventoChat(data.sucursal_id, { tipo: "estado_actualizado", conversacionId: data.conversacion_id });
  }
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
      if (cambio.field === "template_category_update") {
        await procesarCambioCategoria(cambio.value as unknown as ValorCategoria, cuerpoCrudo, firmaHeader);
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

      // Sin secreto de la app cualquiera podría inyectar mensajes o forzar bajas: sin firma válida no se procesa nada.
      if (!config.app_secret || !firmaValida(cuerpoCrudo, firmaHeader, config.app_secret)) {
        console.warn(`Webhook de WhatsApp sin firma válida (sucursal ${config.sucursal_id}): se ignora`);
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
