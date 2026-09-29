import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import type { Grupo } from "../navegacion";
import BarraLateral, { type PerfilLateral } from "./BarraLateral";
import { IconoMenu } from "./Iconos";

const CLAVE_COLAPSADA = "panel.lateral.colapsada";

function leerColapsada(): boolean {
  try {
    return localStorage.getItem(CLAVE_COLAPSADA) === "1";
  } catch {
    return false; // modo privado o almacenamiento bloqueado
  }
}

type Props = { grupos?: Grupo[]; logo?: string | null; logoAlt?: string; perfil?: PerfilLateral | null };

/**
 * Mismo layout para el panel de plataforma y el portal de sucursal: cambia
 * el menú (`grupos`) y, si se pasa, la marca (`logo`) — el portal usa el
 * logo que la sucursal configuró para su panel, no el de Auto Insights.
 */
export default function LayoutPanel({ grupos, logo, logoAlt, perfil }: Props) {
  const { salir } = useAuth();

  const [colapsada, setColapsada] = useState(leerColapsada);
  const [abiertaMovil, setAbiertaMovil] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(CLAVE_COLAPSADA, colapsada ? "1" : "0");
    } catch {
      // sin persistencia; no afecta el funcionamiento
    }
  }, [colapsada]);

  return (
    <div className={colapsada ? "panel panel-colapsado" : "panel"}>
      <BarraLateral
        colapsada={colapsada}
        abierta={abiertaMovil}
        onNavegar={() => setAbiertaMovil(false)}
        grupos={grupos}
        perfil={perfil}
        onSalir={salir}
        {...(logo ? { logoExpandido: logo, logoAlt } : {})}
      />

      {abiertaMovil && (
        <div className="panel-velo" onClick={() => setAbiertaMovil(false)} aria-hidden="true" />
      )}

      <div className="panel-cuerpo">
        <header className="panel-topbar">
          <button
            type="button"
            className="boton-icono"
            onClick={() => setColapsada((v) => !v)}
            aria-label={colapsada ? "Expandir menú" : "Colapsar menú"}
          >
            <IconoMenu />
          </button>

          <button
            type="button"
            className="boton-icono solo-movil"
            onClick={() => setAbiertaMovil(true)}
            aria-label="Abrir menú"
          >
            <IconoMenu />
          </button>
        </header>

        <main className="panel-contenido">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
