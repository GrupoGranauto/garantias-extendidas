import { EventEmitter } from "node:events";
import { env } from "../config/env.js";

/**
 * Pub/sub en memoria del proceso, para el SSE del chat de WhatsApp: el
 * webhook publica, las conexiones SSE abiertas escuchan. Solo funciona si
 * webhook y SSE corren en la MISMA instancia — cierto hoy (un solo servicio
 * en Railway). Si algún día hay más de una instancia, esto deja de avisar
 * entre instancias y hace falta un pub/sub real (Redis, etc.).
 */
const emisor = new EventEmitter();
emisor.setMaxListeners(0);

export type EventoChat =
  | { tipo: "mensaje_entrante"; conversacionId: string }
  | { tipo: "mensaje_saliente"; conversacionId: string }
  | { tipo: "estado_actualizado"; conversacionId: string };

/**
 * Además del SSE en memoria, publica un broadcast por Supabase Realtime en el
 * canal `chat:<sucursal>`. Esto hace que el aviso llegue a todos los navegadores
 * conectados aunque haya varias instancias, y es lo que mantiene la lista en
 * vivo (ej. al reclamar un chat suelto, le desaparece a los demás al instante).
 * El payload no lleva datos del chat: solo una señal para que el cliente
 * vuelva a pedir la lista por la API (que ya filtra por ejecutivo).
 */
function emitirBroadcastSupabase(sucursalId: string, evento: EventoChat): void {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  void fetch(`${env.SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      messages: [{ topic: `chat:${sucursalId}`, event: "refresh", payload: { tipo: evento.tipo } }],
    }),
  }).catch((err) => console.error("Error en broadcast Realtime:", err));
}

export function emitirEventoChat(sucursalId: string, evento: EventoChat): void {
  emisor.emit(sucursalId, evento);
  emitirBroadcastSupabase(sucursalId, evento);
}

/** Se suscribe a los eventos de una sucursal. Devuelve la función para des-suscribirse. */
export function suscribirEventosChat(sucursalId: string, callback: (evento: EventoChat) => void): () => void {
  emisor.on(sucursalId, callback);
  return () => emisor.off(sucursalId, callback);
}
