import { env } from "../config/env.js";

/**
 * Publica un broadcast de Supabase Realtime en un canal. El payload es solo una
 * señal: los clientes suscritos vuelven a pedir los datos por la API (que ya
 * aplica permisos/filtros). Fire-and-forget: si falla, no rompe la petición.
 */
export function emitirBroadcast(topic: string, event: string, payload: Record<string, unknown> = {}): void {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  void fetch(`${env.SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ messages: [{ topic, event, payload }] }),
  }).catch((err) => console.error("Error en broadcast Realtime:", err));
}
