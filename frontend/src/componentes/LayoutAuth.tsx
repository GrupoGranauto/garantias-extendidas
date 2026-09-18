import type { ReactNode } from "react";
import { usePortal } from "../portal/PortalProvider";

type Props = {
  titulo: ReactNode;
  subtitulo?: ReactNode;
  /** Aviso o error. Ocupa un hueco fijo para que el formulario no salte. */
  aviso?: ReactNode;
  children: ReactNode;
};

/** Pantalla partida: marca a la izquierda, formulario a la derecha. */
export default function LayoutAuth({ titulo, subtitulo, aviso, children }: Props) {
  const { portal } = usePortal();

  // El panel oscuro siempre es de Auto Insights ("Desarrollado por");
  // el lado del formulario lleva la marca de la sucursal.
  const logoSucursal = portal?.logo ?? "/marca/logo-oscuro.png";
  const titular = portal?.nombre ?? "Panel de Administración";
  const fondo = portal?.imagenAcceso;

  return (
    <div className="auth">
      <div className="auth-halo auth-halo-marca" aria-hidden="true" />
      <div className="auth-halo auth-halo-frio" aria-hidden="true" />

      <aside className="auth-marca">
        <div
          className="auth-marca-foto"
          style={fondo ? { backgroundImage: `url(${fondo})` } : undefined}
          aria-hidden="true"
        />
        <div className="auth-marca-velo" aria-hidden="true" />
        <div className="auth-marca-rejilla" aria-hidden="true" />

        <div className="auth-marca-top">
          <span className="auth-kicker">Desarrollado por</span>
          <div className="auth-marca-caja-logo">
            <div className="auth-marca-resplandor" aria-hidden="true" />
            <img
              className="auth-marca-logo"
              src="/marca/logo-blanco.png"
              alt="Auto Insights by Grupo Gran Auto"
              draggable={false}
            />
          </div>
        </div>

        <div className="auth-marca-pie">
          <h2>{titular}</h2>
          <p>
            Plataforma centralizada de gestión y control. Administra el
            ecosistema de datos, usuarios y configuraciones de forma
            profesional.
          </p>
        </div>
      </aside>

      <main className="auth-panel">
        <div className="auth-caja">
          <div className="auth-encabezado">
            <div className="auth-logo">
              <img
                src={logoSucursal}
                alt={portal?.nombre ?? "Auto Insights by Grupo Gran Auto"}
                draggable={false}
              />
            </div>

            <h1 className="auth-titulo">{titulo}</h1>
            {subtitulo && <p className="auth-subtitulo">{subtitulo}</p>}
          </div>

          <div className="auth-aviso">{aviso}</div>

          {children}
        </div>
      </main>
    </div>
  );
}
