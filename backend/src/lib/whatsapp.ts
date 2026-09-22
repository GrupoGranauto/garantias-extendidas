import crypto from "node:crypto";
import { getSupabase } from "./supabase.js";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const BUCKET_MEDIA = "whatsapp-media";

export type ConfigSucursal = {
  sucursal_id: string;
  waba_id: string | null;
  phone_number_id: string;
  access_token: string;
  app_secret: string | null;
  webhook_verify_token: string | null;
  activo: boolean;
};

/**
 * Busca la configuración de WhatsApp por phone_number_id, que es el dato
 * que viene en cada evento del webhook y permite saber de qué sucursal es.
 */
export async function configPorPhoneNumberId(phoneNumberId: string): Promise<ConfigSucursal | null> {
  const { data, error } = await getSupabase()
    .from("whatsapp_config")
    .select("sucursal_id, waba_id, phone_number_id, access_token, app_secret, webhook_verify_token, activo")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Valida que el POST realmente venga de Meta: recalcula el HMAC-SHA256 del
 * cuerpo crudo con el app_secret y lo compara contra el header de la firma.
 *
 * Exige el cuerpo *crudo* (antes de JSON.parse) — por eso el router de
 * WhatsApp usa express.raw() en vez de express.json().
 */
export function firmaValida(cuerpoCrudo: Buffer, firmaHeader: string | undefined, appSecret: string): boolean {
  if (!firmaHeader?.startsWith("sha256=")) return false;

  const esperada = crypto.createHmac("sha256", appSecret).update(cuerpoCrudo).digest("hex");
  const recibida = firmaHeader.slice("sha256=".length);

  // Longitud pareja antes de timingSafeEqual, o revienta con un mensaje críptico
  if (esperada.length !== recibida.length) return false;

  return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(recibida));
}

/**
 * Descarga un archivo de WhatsApp y lo guarda en Storage propio.
 *
 * La URL que da Meta expira en minutos, así que hay que hacerlo de inmediato
 * al recibir el webhook, no cuando alguien abra la conversación después.
 */
export async function descargarMedia(
  mediaId: string,
  accessToken: string,
  sucursalId: string,
): Promise<{ url: string; mimeType: string; nombreArchivo: string | null }> {
  // 1. Pedir la URL temporal de descarga
  const infoRes = await fetch(`${GRAPH_API}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) {
    throw new Error(`No se pudo obtener info del media ${mediaId}: HTTP ${infoRes.status}`);
  }
  const info = (await infoRes.json()) as { url: string; mime_type: string; file_size: number };

  // 2. Descargar el archivo real desde esa URL, con el mismo token
  const archivoRes = await fetch(info.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!archivoRes.ok) {
    throw new Error(`No se pudo descargar el media ${mediaId}: HTTP ${archivoRes.status}`);
  }
  const buffer = Buffer.from(await archivoRes.arrayBuffer());

  // 3. Subirlo a Storage propio
  const extension = info.mime_type.split("/")[1]?.split(";")[0] ?? "bin";
  const ruta = `${sucursalId}/${mediaId}.${extension}`;

  const { error } = await getSupabase()
    .storage.from(BUCKET_MEDIA)
    .upload(ruta, buffer, { contentType: info.mime_type, upsert: true });

  if (error) throw new Error(`No se pudo guardar el media en Storage: ${error.message}`);

  const { data: publica } = getSupabase().storage.from(BUCKET_MEDIA).getPublicUrl(ruta);

  return { url: publica.publicUrl, mimeType: info.mime_type, nombreArchivo: null };
}

type EnvioTexto = { tipo: "texto"; texto: string };
type EnvioImagen = { tipo: "imagen"; url: string; caption?: string };
type EnvioDocumento = { tipo: "documento"; url: string; nombreArchivo: string; caption?: string };
export type EnvioMensaje = EnvioTexto | EnvioImagen | EnvioDocumento;

/**
 * Envía un mensaje saliente por WhatsApp. Fase 2 la usa desde la pantalla
 * de chat; se deja lista desde ahora para no retocar el esquema después.
 */
export async function enviarMensaje(
  config: ConfigSucursal,
  waIdDestino: string,
  envio: EnvioMensaje,
): Promise<{ id: string }> {
  const cuerpo: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: waIdDestino,
  };

  if (envio.tipo === "texto") {
    cuerpo.type = "text";
    cuerpo.text = { body: envio.texto };
  } else if (envio.tipo === "imagen") {
    cuerpo.type = "image";
    cuerpo.image = { link: envio.url, caption: envio.caption };
  } else {
    cuerpo.type = "document";
    cuerpo.document = { link: envio.url, filename: envio.nombreArchivo, caption: envio.caption };
  }

  const res = await fetch(`${GRAPH_API}/${config.phone_number_id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cuerpo),
  });

  const cuerpoRespuesta = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };

  if (!res.ok || !cuerpoRespuesta.messages?.[0]) {
    throw new Error(cuerpoRespuesta.error?.message ?? `Envío falló: HTTP ${res.status}`);
  }

  return { id: cuerpoRespuesta.messages[0].id };
}

/* ============================================================
   Plantillas (message_templates): se registran contra la WABA,
   Meta las revisa y las aprueba/rechaza de forma asíncrona.
   ============================================================ */

export type ComponenteHeader =
  | { type: "HEADER"; format: "TEXT"; text: string }
  | { type: "HEADER"; format: "IMAGE" | "VIDEO" | "DOCUMENT"; example: { header_handle: string[] } };

export type ComponenteBody = {
  type: "BODY";
  text: string;
  example?: { body_text: string[][] };
};

export type ComponenteFooter = { type: "FOOTER"; text: string };

export type BotonPlantilla =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string }
  | { type: "COPY_CODE"; example: string };

export type ComponenteButtons = { type: "BUTTONS"; buttons: BotonPlantilla[] };

export type ComponentePlantilla = ComponenteHeader | ComponenteBody | ComponenteFooter | ComponenteButtons;

type RespuestaErrorMeta = { error?: { message: string; error_user_msg?: string } };

function mensajeErrorMeta(cuerpo: RespuestaErrorMeta, status: number): string {
  return cuerpo.error?.error_user_msg ?? cuerpo.error?.message ?? `HTTP ${status}`;
}

/** Da de alta la plantilla en Meta. Devuelve el id que asigna Meta y el estado inicial. */
export async function crearPlantillaMeta(
  wabaId: string,
  accessToken: string,
  plantilla: { name: string; language: string; category: string; components: ComponentePlantilla[] },
): Promise<{ id: string; status: string }> {
  const res = await fetch(`${GRAPH_API}/${wabaId}/message_templates`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(plantilla),
  });

  const cuerpo = (await res.json()) as RespuestaErrorMeta & { id?: string; status?: string };

  if (!res.ok || !cuerpo.id) {
    throw new Error(mensajeErrorMeta(cuerpo, res.status));
  }

  return { id: cuerpo.id, status: cuerpo.status ?? "PENDING" };
}

/** Consulta el estado real de todas las plantillas de la WABA (para sincronizar). */
export async function listarPlantillasMeta(
  wabaId: string,
  accessToken: string,
): Promise<{ id: string; name: string; language: string; status: string; category: string }[]> {
  const resultados: { id: string; name: string; language: string; status: string; category: string }[] = [];
  let url: string | null =
    `${GRAPH_API}/${wabaId}/message_templates?fields=id,name,language,status,category&limit=200`;

  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const cuerpo = (await res.json()) as RespuestaErrorMeta & {
      data?: { id: string; name: string; language: string; status: string; category: string }[];
      paging?: { next?: string };
    };

    if (!res.ok) throw new Error(mensajeErrorMeta(cuerpo, res.status));

    resultados.push(...(cuerpo.data ?? []));
    url = cuerpo.paging?.next ?? null;
  }

  return resultados;
}

/** Mapea el status de Meta al estado local. Lo no reconocido se deja como "pendiente" para revisar a mano. */
export function estadoDesdeMeta(status: string): string {
  switch (status.toUpperCase()) {
    case "APPROVED":
      return "aprobada";
    case "REJECTED":
      return "rechazada";
    case "PAUSED":
      return "pausada";
    case "DISABLED":
      return "deshabilitada";
    case "PENDING":
    case "PENDING_DELETION":
    case "IN_APPEAL":
      return "pendiente";
    default:
      return "pendiente";
  }
}

/** Elimina la plantilla en Meta por nombre (borra todos los idiomas de ese nombre). */
export async function eliminarPlantillaMeta(wabaId: string, accessToken: string, nombre: string): Promise<void> {
  const res = await fetch(
    `${GRAPH_API}/${wabaId}/message_templates?name=${encodeURIComponent(nombre)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
  );

  const cuerpo = (await res.json()) as RespuestaErrorMeta & { success?: boolean };

  // "no encontrada" no debe tumbar el borrado local: ya no existe en Meta, que es lo que se quería.
  if (!res.ok && !/does not exist/i.test(cuerpo.error?.message ?? "")) {
    throw new Error(mensajeErrorMeta(cuerpo, res.status));
  }
}
