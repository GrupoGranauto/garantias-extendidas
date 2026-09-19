import { env } from "../config/env.js";

/**
 * Saca el subdominio del host.
 *
 *   granauto-ge.autoinsights.mx  -> "granauto-ge"
 *   autoinsights.mx              -> null  (dominio raiz)
 *   www.autoinsights.mx          -> null
 *   localhost:5173               -> null  (en desarrollo se usa ?sucursal=)
 */
// Etiqueta reservada para el panel genérico (sin marca de sucursal), ej.
// panel.ge.autoinsights.mx. Ninguna sucursal puede llamarse así.
const ETIQUETA_PANEL_GENERICO = "panel";

export function extraerSubdominio(host: string | undefined): string | null {
  if (!host) return null;

  const limpio = host.split(":")[0].trim().toLowerCase();
  const base = env.DOMINIO_BASE.toLowerCase();

  if (limpio === base || limpio === `www.${base}`) return null;
  if (!limpio.endsWith(`.${base}`)) return null;

  const etiqueta = limpio.slice(0, -(base.length + 1));

  // Solo un nivel: "a.b.autoinsights.mx" no es una sucursal
  if (!etiqueta || etiqueta.includes(".")) return null;
  if (etiqueta === ETIQUETA_PANEL_GENERICO) return null;

  return etiqueta;
}

/** Valida la forma del slug antes de tocar la base. */
export function subdominioValido(valor: string): boolean {
  if (valor === ETIQUETA_PANEL_GENERICO) return false;
  return /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/.test(valor);
}
