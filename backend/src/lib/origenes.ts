import { env } from "../config/env.js";

const origenesFijos = env.CORS_ORIGIN.split(",").map((o) => o.trim());

/**
 * ¿Este origen puede hablar con la API? Cada sucursal vive en su propio
 * subdominio, así que además de la lista fija de desarrollo se permite
 * cualquier <algo>.DOMINIO_BASE. Se usa tanto para CORS como para validar a
 * qué host mandar de vuelta a alguien (ej. el link de recuperación).
 */
export function origenPermitido(origen: string): boolean {
  if (origenesFijos.includes(origen)) return true;

  try {
    const { protocol, hostname } = new URL(origen);
    if (protocol !== "https:") return false;

    const host = hostname.toLowerCase();
    const base = env.DOMINIO_BASE.toLowerCase();

    if (host === base) return true;
    if (!host.endsWith(`.${base}`)) return false;

    // Solo un nivel de subdominio: "a.b.autoinsights.mx" no pasa
    return !host.slice(0, -(base.length + 1)).includes(".");
  } catch {
    return false;
  }
}
