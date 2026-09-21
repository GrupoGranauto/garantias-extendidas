import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { apiFetch } from "../lib/api";
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
 * cruzarse: quien tenga una sucursal asignada no llega al menú de admin
 * bajo ninguna circunstancia, sin importar por qué host haya entrado.
 */
export default function GuardiaSucursal() {
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    apiFetch<Perfil>("/api/perfil")
      .then(setPerfil)
      .finally(() => setCargando(false));
  }, []);

  if (cargando) return <Cargador pantalla />;

  if (perfil?.sucursal_id) {
    return <PortalSucursalMarcador nombre={perfil.nombre} sucursal={perfil.sucursal} />;
  }

  return <Outlet />;
}
