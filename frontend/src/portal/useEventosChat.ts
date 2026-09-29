import { useEffect, useRef } from "react";
import { getAccessToken } from "../lib/supabase";

export type EventoChat =
  | { tipo: "mensaje_entrante"; conversacionId: string }
  | { tipo: "mensaje_saliente"; conversacionId: string }
  | { tipo: "estado_actualizado"; conversacionId: string };

/**
 * Tiempo real del chat vía SSE. No usa `EventSource` nativo porque necesita
 * mandar el JWT en Authorization (EventSource no permite headers) — en vez
 * de eso, lee el stream a mano con fetch + ReadableStream, reconectando solo
 * si la conexión se cae.
 */
export function useEventosChat(sucursalId: string, onEvento: (evento: EventoChat) => void) {
  const callbackRef = useRef(onEvento);
  callbackRef.current = onEvento;

  useEffect(() => {
    let activo = true;
    let controlador: AbortController | null = null;
    let reintentoTimer: ReturnType<typeof setTimeout> | null = null;

    async function conectar() {
      controlador = new AbortController();
      try {
        const token = await getAccessToken();
        const res = await fetch(`/api/admin/sucursales/${sucursalId}/whatsapp/eventos`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controlador.signal,
        });
        if (!res.ok || !res.body) throw new Error("No se pudo conectar al stream de eventos.");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (activo) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const bloques = buffer.split("\n\n");
          buffer = bloques.pop() ?? "";

          for (const bloque of bloques) {
            const lineaDatos = bloque.split("\n").find((l) => l.startsWith("data:"));
            if (!lineaDatos) continue;
            try {
              const evento = JSON.parse(lineaDatos.slice(5).trim()) as Partial<EventoChat>;
              if (evento.tipo) callbackRef.current(evento as EventoChat);
            } catch {
              // bloque sin datos útiles (connected/ping): se ignora
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
      }
      if (activo) reintentoTimer = setTimeout(conectar, 3000);
    }

    void conectar();

    return () => {
      activo = false;
      controlador?.abort();
      if (reintentoTimer) clearTimeout(reintentoTimer);
    };
  }, [sucursalId]);
}
