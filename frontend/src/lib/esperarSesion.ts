import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Espera a que el SDK termine de canjear el `?code=` de la URL.
 *
 * El canje lo hace supabase-js solo, por `detectSessionInUrl`. Llamar aquí a
 * exchangeCodeForSession() sería un segundo canje con un verifier ya consumido:
 * eso es el error "PKCE code verifier not found in storage".
 */
export function esperarSesion(msLimite = 10000): Promise<Session | null> {
  return new Promise((resolve) => {
    let resuelto = false;

    const terminar = (sesion: Session | null) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(temporizador);
      sub.subscription.unsubscribe();
      resolve(sesion);
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evento, sesion) => {
      if (sesion) terminar(sesion);
    });

    // Por si el canje ya había terminado antes de montar el componente
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) terminar(data.session);
    });

    const temporizador = setTimeout(() => terminar(null), msLimite);
  });
}
