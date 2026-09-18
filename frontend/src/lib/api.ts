import { getAccessToken } from "./supabase";

/**
 * fetch con el JWT de Supabase adjunto.
 * Las rutas del backend protegidas lo exigen en Authorization: Bearer <token>.
 */
export async function apiFetch<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();

  const res = await fetch(ruta, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  const cuerpo = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error((cuerpo as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return cuerpo as T;
}
