import { useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";

/**
 * Tiempo real del chat vía Supabase Realtime (broadcast). El backend publica un
 * evento "refresh" en el canal `chat:<sucursal>` cada vez que algo cambia (mensaje
 * nuevo, estado, o una reasignación de dueño). El cliente no recibe datos del chat
 * en el payload: solo la señal para volver a pedir la lista por la API, que ya
 * filtra por ejecutivo. Así, al reclamar un chat suelto, le desaparece en vivo a
 * los demás asesores.
 */
export function useRealtimeChat(sucursalId: string, onRefresh: () => void) {
  const callbackRef = useRef(onRefresh);
  callbackRef.current = onRefresh;

  useEffect(() => {
    const canal = supabase
      .channel(`chat:${sucursalId}`)
      .on("broadcast", { event: "refresh" }, () => callbackRef.current())
      .subscribe();

    return () => {
      void supabase.removeChannel(canal);
    };
  }, [sucursalId]);
}
