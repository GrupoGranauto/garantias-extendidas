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
  // Sin sucursal (dominio raíz) se usa la foto genérica de Auto Insights
  const fondo = portal?.imagenAcceso ?? "/fondo-login.jpg";

  return (
    <div className="auth">
      <div className="auth-halo auth-halo-marca" aria-hidden="true" />
      <div className="auth-halo auth-halo-frio" aria-hidden="true" />

      <aside className="auth-marca">
        {/* Imagen sin oscurecer; la cuadrícula es transparente y va encima */}
        {fondo && (
          <div
            className="auth-marca-foto"
            style={{ backgroundImage: `url(${fondo})` }}
            aria-hidden="true"
          />
        )}
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
