/**
 * El subdominio resuelve por el comodín del DNS, así que cualquier nombre
 * llega hasta aquí. Si no corresponde a una sucursal, esto es lo que se ve.
 */
export default function PortalNoEncontrado() {
  return (
    <div className="auth">
      <div className="auth-halo auth-halo-marca" aria-hidden="true" />
      <div className="auth-halo auth-halo-frio" aria-hidden="true" />

      <main className="auth-panel auth-panel-solo">
        <div className="auth-caja">
          <div className="auth-encabezado">
            <div className="auth-logo">
              <img src="/marca/logo-oscuro.png" alt="Auto Insights" draggable={false} />
            </div>
            <h1 className="auth-titulo">
              Portal <span className="acento">no encontrado</span>
            </h1>
            <p className="auth-subtitulo">
              La dirección <code>{window.location.hostname}</code> no corresponde a
              ninguna sucursal registrada.
            </p>
          </div>

          <p className="centrado">
            Revisa la dirección o comunícate con Sistemas para que den de alta el portal.
          </p>
        </div>
      </main>
    </div>
  );
}
