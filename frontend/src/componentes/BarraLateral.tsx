import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { NAVEGACION, type Seccion } from "../navegacion";
import { IconoChevron } from "./Iconos";

type Props = {
  /** Colapsada: solo iconos (escritorio). */
  colapsada: boolean;
  /** Abierta como panel flotante (móvil). */
  abierta: boolean;
  onNavegar: () => void;
};

export default function BarraLateral({ colapsada, abierta, onNavegar }: Props) {
  const { pathname } = useLocation();

  // Arranca con el submenú de la sección activa desplegado
  const [desplegadas, setDesplegadas] = useState<string[]>(() =>
    NAVEGACION.flatMap((g) => g.secciones)
      .filter((s) => s.hijos?.some((h) => pathname.startsWith(h.ruta)))
      .map((s) => s.etiqueta),
  );

  function alternar(etiqueta: string) {
    setDesplegadas((previas) =>
      previas.includes(etiqueta)
        ? previas.filter((e) => e !== etiqueta)
        : [...previas, etiqueta],
    );
  }

  function seccionActiva(seccion: Seccion) {
    if (seccion.ruta === "/") return pathname === "/";
    if (seccion.ruta) return pathname.startsWith(seccion.ruta);
    return Boolean(seccion.hijos?.some((h) => pathname.startsWith(h.ruta)));
  }

  // Editar una sucursal o un usuario no vive en el menú: se llega ahí desde
  // una fila del listado, así que cuenta como "Listado", no como "Nueva/Nuevo".
  const LISTADOS_CON_EDICION: Record<string, string> = {
    "/sucursales": "/sucursales/nueva",
    "/usuarios": "/usuarios/nuevo",
  };

  function hijoActivo(ruta: string) {
    if (pathname === ruta) return true;
    const rutaNueva = LISTADOS_CON_EDICION[ruta];
    if (rutaNueva) {
      return pathname.startsWith(`${ruta}/`) && pathname !== rutaNueva;
    }
    return false;
  }

  const clases = ["lateral", colapsada && "lateral-colapsada", abierta && "lateral-abierta"]
    .filter(Boolean)
    .join(" ");

  return (
    <aside className={clases}>
      <div className="lateral-marca">
        {/* Colapsada cabe el emblema; expandida, el logotipo completo */}
        <img
          src={colapsada ? "/marca/icono-blanco.png" : "/marca/logo-blanco-compacto.png"}
          alt="Auto Insights"
          className={colapsada ? "lateral-logo lateral-logo-min" : "lateral-logo"}
          draggable={false}
        />
      </div>

      <nav className="lateral-nav">
        {NAVEGACION.map((grupo, i) => (
          <div className="lateral-grupo" key={grupo.titulo ?? i}>
            {grupo.titulo && <p className="lateral-titulo">{grupo.titulo}</p>}

            {grupo.secciones.map((seccion) => {
              const activa = seccionActiva(seccion);

              if (!seccion.hijos) {
                return (
                  <NavLink
                    key={seccion.etiqueta}
                    to={seccion.ruta!}
                    className={activa ? "lateral-item activo" : "lateral-item"}
                    onClick={onNavegar}
                    title={colapsada ? seccion.etiqueta : undefined}
                  >
                    <span className="lateral-icono">{seccion.icono}</span>
                    <span className="lateral-texto">{seccion.etiqueta}</span>
                  </NavLink>
                );
              }

              const desplegada = desplegadas.includes(seccion.etiqueta);

              return (
                <div key={seccion.etiqueta}>
                  <button
                    type="button"
                    /* La sección que contiene la pantalla actual se marca, pero
                       sin robarle protagonismo al subitem que sí está activo */
                    className={activa ? "lateral-item contiene-activo" : "lateral-item"}
                    onClick={() => alternar(seccion.etiqueta)}
                    aria-expanded={desplegada}
                    title={colapsada ? seccion.etiqueta : undefined}
                  >
                    <span className="lateral-icono">{seccion.icono}</span>
                    <span className="lateral-texto">{seccion.etiqueta}</span>
                    <span className={desplegada ? "lateral-flecha abierta" : "lateral-flecha"}>
                      <IconoChevron />
                    </span>
                  </button>

                  {desplegada && (
                    <div className="lateral-submenu">
                      {seccion.hijos.map((hijo) => (
                        <NavLink
                          key={hijo.ruta}
                          to={hijo.ruta}
                          className={hijoActivo(hijo.ruta) ? "lateral-subitem activo" : "lateral-subitem"}
                          onClick={onNavegar}
                        >
                          {hijo.etiqueta}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
