import { useEffect, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import BarraLateral from "./BarraLateral";
import { IconoMenu, IconoChevron, IconoSalir } from "./Iconos";

const CLAVE_COLAPSADA = "panel.lateral.colapsada";

function leerColapsada(): boolean {
  try {
    return localStorage.getItem(CLAVE_COLAPSADA) === "1";
  } catch {
    return false; // modo privado o almacenamiento bloqueado
  }
}

export default function LayoutPanel() {
  const { usuario, salir } = useAuth();

  const [colapsada, setColapsada] = useState(leerColapsada);
  const [abiertaMovil, setAbiertaMovil] = useState(false);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(CLAVE_COLAPSADA, colapsada ? "1" : "0");
    } catch {
      // sin persistencia; no afecta el funcionamiento
    }
  }, [colapsada]);

  // Cerrar el menú de usuario al hacer clic fuera o con Escape
  useEffect(() => {
    if (!menuAbierto) return;

    function alClic(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuAbierto(false);
    }
    function alTeclear(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuAbierto(false);
    }

    document.addEventListener("mousedown", alClic);
    document.addEventListener("keydown", alTeclear);
    return () => {
      document.removeEventListener("mousedown", alClic);
      document.removeEventListener("keydown", alTeclear);
    };
  }, [menuAbierto]);

  const nombre = usuario?.user_metadata?.full_name ?? usuario?.email?.split("@")[0] ?? "Usuario";
  const inicial = nombre.charAt(0).toUpperCase();

  return (
    <div className={colapsada ? "panel panel-colapsado" : "panel"}>
      <BarraLateral
        colapsada={colapsada}
        abierta={abiertaMovil}
        onNavegar={() => setAbiertaMovil(false)}
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

          <div className="panel-usuario" ref={menuRef}>
            <button
              type="button"
              className="panel-usuario-boton"
              onClick={() => setMenuAbierto((v) => !v)}
              aria-expanded={menuAbierto}
            >
              <span className="panel-avatar">{inicial}</span>
              <span className="panel-nombre">{nombre}</span>
              <IconoChevron className="panel-usuario-flecha" />
            </button>

            {menuAbierto && (
              <div className="panel-menu" role="menu">
                <div className="panel-menu-cabecera">
                  <strong>{nombre}</strong>
                  <span>{usuario?.email}</span>
                </div>
                <button type="button" className="panel-menu-item" onClick={salir} role="menuitem">
                  <IconoSalir />
                  Cerrar sesión
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="panel-contenido">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
