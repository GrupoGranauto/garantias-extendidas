import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, flags } from "../config/env.js";

let client: SupabaseClient | null = null;

/**
 * Cliente de Supabase con service role.
 * Ignora RLS: usar SOLO en backend, nunca mandar esta key al frontend.
 */
export function getSupabase(): SupabaseClient {
  if (!flags.supabase) {
    throw new Error(
      "Supabase no configurado. Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en backend/.env",
    );
  }
  if (!client) {
    client = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export async function pingSupabase(): Promise<{ ok: boolean; detail: string }> {
  try {
    const supabase = getSupabase();
    // listUsers exige service_role: valida url + key de verdad
    const { error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) return { ok: false, detail: error.message };
    return { ok: true, detail: "conexion establecida" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
