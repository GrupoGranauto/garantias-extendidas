import { EventEmitter } from "node:events";

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

export function emitirEventoChat(sucursalId: string, evento: EventoChat): void {
  emisor.emit(sucursalId, evento);
}

/** Se suscribe a los eventos de una sucursal. Devuelve la función para des-suscribirse. */
export function suscribirEventosChat(sucursalId: string, callback: (evento: EventoChat) => void): () => void {
  emisor.on(sucursalId, callback);
  return () => emisor.off(sucursalId, callback);
}
