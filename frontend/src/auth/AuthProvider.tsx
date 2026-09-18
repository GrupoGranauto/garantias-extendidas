import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { traducirError } from "./errores";

type Resultado = { error: string | null };

type AuthContextValue = {
  session: Session | null;
  usuario: User | null;
  cargando: boolean;
  /** true cuando el usuario llegó desde el correo de recuperación */
  enRecuperacion: boolean;
  entrar: (correo: string, password: string) => Promise<Resultado>;
  entrarConGoogle: () => Promise<Resultado>;
  enviarCorreoRecuperacion: (correo: string) => Promise<Resultado>;
  cambiarPassword: (password: string) => Promise<Resultado>;
  salir: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [cargando, setCargando] = useState(true);
  const [enRecuperacion, setEnRecuperacion] = useState(false);

  useEffect(() => {
    let vivo = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!vivo) return;
      setSession(data.session);
      setCargando(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((evento, nuevaSesion) => {
      setSession(nuevaSesion);
      setCargando(false);
      if (evento === "PASSWORD_RECOVERY") setEnRecuperacion(true);
      if (evento === "SIGNED_OUT") setEnRecuperacion(false);
    });

    return () => {
      vivo = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const entrar = useCallback(async (correo: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: correo.trim(),
      password,
    });
    return { error: error ? traducirError(error.message) : null };
  }, []);

  // No hay alta propia: si la cuenta de Google no existe en el proyecto,
  // Supabase responde "Signups not allowed" y se traduce en errores.ts
  const entrarConGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
    return { error: error ? traducirError(error.message) : null };
  }, []);

  const enviarCorreoRecuperacion = useCallback(async (correo: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(correo.trim(), {
      redirectTo: `${window.location.origin}/restablecer`,
    });
    return { error: error ? traducirError(error.message) : null };
  }, []);

  const cambiarPassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (!error) setEnRecuperacion(false);
    return { error: error ? traducirError(error.message) : null };
  }, []);

  const salir = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const valor = useMemo<AuthContextValue>(
    () => ({
      session,
      usuario: session?.user ?? null,
      cargando,
      enRecuperacion,
      entrar,
      entrarConGoogle,
      enviarCorreoRecuperacion,
      cambiarPassword,
      salir,
    }),
    [session, cargando, enRecuperacion, entrar, entrarConGoogle, enviarCorreoRecuperacion, cambiarPassword, salir],
  );

  return <AuthContext.Provider value={valor}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
