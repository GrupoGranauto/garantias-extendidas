import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Espera a que se establezca la sesión a partir de lo que traiga la URL.
 *
 * "/restablecer" recibe dos formatos distintos según de dónde venga el link:
 *  - "Olvidé mi contraseña" (lo inicia el propio navegador): PKCE, `?code=`.
 *    Ese canje lo hace supabase-js solo, por `detectSessionInUrl`; llamar
 *    aquí a exchangeCodeForSession() sería un segundo canje con un verifier
 *    ya consumido — el error "PKCE code verifier not found in storage".
 *  - Invitación (la genera el admin desde el backend, sin navegador de por
 *    medio): no hay PKCE posible ahí, así que Supabase manda los tokens
 *    directo en el fragmento (`#access_token=...&refresh_token=...`). El
 *    cliente está en modo PKCE y no los detecta solo: hay que leerlos del
 *    fragmento y establecer la sesión a mano.
 */
export function esperarSesion(msLimite = 10000): Promise<Session | null> {
  return new Promise((resolve) => {
    let resuelto = false;
    let sub: { subscription: { unsubscribe: () => void } } | undefined;

    const temporizador = setTimeout(() => terminar(null), msLimite);

    function terminar(sesion: Session | null) {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(temporizador);
      sub?.subscription.unsubscribe();
      resolve(sesion);
    }

    const fragmento = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = fragmento.get("access_token");
    const refreshToken = fragmento.get("refresh_token");

    if (accessToken && refreshToken) {
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ data }) => {
        terminar(data.session);
      });
      return;
    }

    sub = supabase.auth.onAuthStateChange((_evento, sesion) => {
      if (sesion) terminar(sesion);
    }).data;

    // Por si el canje ya había terminado antes de montar el componente
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) terminar(data.session);
    });
  });
}
