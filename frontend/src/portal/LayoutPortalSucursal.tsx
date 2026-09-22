import type { CSSProperties } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { usePortal } from "./PortalProvider";

const PESTANAS = [{ etiqueta: "Plantillas", ruta: "/plantillas" }];

/**
 * Layout del portal de una sucursal: nada que ver con LayoutPanel (admin).
 * Menú propio, marca propia (color/logo de la sucursal), rutas propias.
 */
export default function LayoutPortalSucursal() {
  const { usuario, salir } = useAuth();
  const { portal } = usePortal();
  const estilo = portal ? ({ "--marca": portal.color } as CSSProperties) : undefined;

  return (
    <div className="portal-sucursal" style={estilo}>
      <header className="portal-topbar">
        <div className="portal-marca">
          {portal?.logo && <img src={portal.logo} alt={portal.nombre} />}
          <span>{portal?.nombre}</span>
        </div>

        <nav className="pestanas" aria-label="Secciones del portal">
          {PESTANAS.map((p) => (
            <NavLink
              key={p.ruta}
              to={p.ruta}
              className={({ isActive }) => `pestana${isActive ? " pestana-activa" : ""}`}
            >
              {p.etiqueta}
            </NavLink>
          ))}
        </nav>

        <div className="portal-usuario">
          <span>{usuario?.email}</span>
          <button type="button" className="boton-secundario-claro" onClick={salir}>
            Cerrar sesión
          </button>
        </div>
      </header>

      <main className="portal-contenido">
        <Outlet />
      </main>
    </div>
  );
}
