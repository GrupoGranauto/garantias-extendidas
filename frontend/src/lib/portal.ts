export type Portal = {
  id: string;
  subdominio: string;
  nombre: string;
  color: string;
  logo: string | null;
  logoPanel: string | null;
  imagenAcceso: string | null;
  activa: boolean;
  loginGoogle: boolean;
  mensajeCerrado: string | null;
};

/**
 * En producción el portal sale del host: granauto-ge.autoinsights.mx
 * En desarrollo (localhost) se fuerza con ?sucursal=granauto-ge, y la
 * elección se recuerda para no tener que repetirla en cada navegación.
 */
const CLAVE_DEV = "portal.sucursal.dev";

export function subdominioDeDesarrollo(): string | null {
  const { hostname, search } = window.location;
  const esLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (!esLocal) return null;

  const pedido = new URLSearchParams(search).get("sucursal");

  try {
    if (pedido) {
      localStorage.setItem(CLAVE_DEV, pedido);
      return pedido;
    }
    return localStorage.getItem(CLAVE_DEV);
  } catch {
    return pedido; // almacenamiento bloqueado
  }
}

/** Pide la marca del portal. `null` = dominio raíz, sin personalizar. */
export async function cargarPortal(): Promise<Portal | null> {
  const dev = subdominioDeDesarrollo();
  const ruta = dev
    ? `/api/publico/sucursal?sucursal=${encodeURIComponent(dev)}`
    : "/api/publico/sucursal";

  const res = await fetch(ruta);

  if (res.status === 404) {
    throw new Error("PORTAL_NO_ENCONTRADO");
  }
  if (!res.ok) {
    throw new Error("No se pudo cargar la configuración del portal.");
  }

  const cuerpo = (await res.json()) as { portal: Portal | null };
  return cuerpo.portal;
}
