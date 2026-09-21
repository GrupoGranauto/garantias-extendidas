import type { CSSProperties } from "react";
import { useAuth } from "../auth/AuthProvider";

type Perfil = {
  nombre: string | null;
  sucursal: { nombre: string; color: string; logo_url: string | null } | null;
};

/**
 * Portal de sucursal, temporal: todavía no existe (será algo completamente
 * distinto al panel de administración). Mientras tanto, quien entre aquí no
 * ve ni un botón del panel de plataforma.
 */
export default function PortalSucursalMarcador({ nombre, sucursal }: Perfil) {
  const { salir } = useAuth();
  const estilo = sucursal ? ({ "--marca": sucursal.color } as CSSProperties) : undefined;

  return (
    <div className="marcador-portal" style={estilo}>
      <div className="marcador-portal-tarjeta">
        {sucursal?.logo_url && <img src={sucursal.logo_url} alt={sucursal.nombre} className="marcador-portal-logo" />}
        <h1>Hola{nombre ? `, ${nombre}` : ""}</h1>
        <p>
          El portal de <strong>{sucursal?.nombre ?? "tu sucursal"}</strong> todavía está en construcción.
          Pronto vas a poder trabajar aquí.
        </p>
        <button type="button" className="boton-secundario-claro" onClick={salir}>
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
