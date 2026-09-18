import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY en frontend/.env",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // PKCE: el token no viaja en el fragmento de la URL
    flowType: "pkce",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/** Token de acceso actual, para mandarlo al backend en Authorization. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
