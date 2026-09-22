import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { usePortal } from "../portal/PortalProvider";
import Cargador from "../componentes/Cargador";
import PortalSucursalMarcador from "../paginas/PortalSucursalMarcador";

type Perfil = {
  id: string;
  correo: string;
  nombre: string | null;
  rol: "admin" | "asesor";
  sucursal_id: string | null;
  activo: boolean;
  sucursal: { id: string; nombre: string; color: string; logo_url: string | null } | null;
};

/**
 * El panel de plataforma (Sucursales, Usuarios, Administración) y el portal
 * de cada sucursal son cosas completamente distintas y nunca deben
 * cruzarse — en ninguna de las dos direcciones:
 *
 *  - Quien tenga una sucursal asignada no llega al menú de admin bajo
 *    ninguna circunstancia, sin importar por qué host haya entrado.
 *  - El subdominio de una sucursal nunca muestra el panel de admin, ni
 *    siquiera si quien entró es el administrador de plataforma: es la
 *    misma app (mismo build) sirviendo cualquier host, así que sin este
 *    chequeo un admin viendo granauto.ge.autoinsights.mx vería el panel
 *    completo ahí también.
 */
export default function GuardiaSucursal() {
  const { portal } = usePortal();
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    apiFetch<Perfil>("/api/perfil")
      .then(setPerfil)
      .finally(() => setCargando(false));
  }, []);

  if (cargando) return <Cargador pantalla />;

  // Host de una sucursal: nunca el panel de admin, sin importar quién sea.
  if (portal) {
    return (
      <PortalSucursalMarcador
        nombre={perfil?.nombre ?? null}
        sucursal={{ nombre: portal.nombre, color: portal.color, logo_url: portal.logo }}
      />
    );
  }

  // Host genérico, pero la cuenta pertenece a una sucursal.
  if (perfil?.sucursal_id) {
    return <PortalSucursalMarcador nombre={perfil.nombre} sucursal={perfil.sucursal} />;
  }

  return <Outlet />;
}
