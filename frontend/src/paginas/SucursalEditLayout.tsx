import { useEffect, useState } from "react";
import { Link, Outlet, useOutletContext, useParams } from "react-router-dom";
import PestanasSucursal from "../componentes/PestanasSucursal";
import Alerta from "../componentes/Alerta";
import { apiFetch } from "../lib/api";

export type SucursalDetalle = {
  id: string;
  subdominio: string;
  nombre: string;
  color: string;
  activa: boolean;
  login_google: boolean;
  mensaje_cerrado: string | null;
  logo_url: string | null;
  logo_panel_url: string | null;
  imagen_acceso_url: string | null;
};

type Contexto = { sucursal: SucursalDetalle; recargar: () => void };

/** Cada pestaña (General / WhatsApp / Base de datos) lee la sucursal ya cargada de aquí. */
export function useSucursal(): Contexto {
  return useOutletContext<Contexto>();
}

/**
 * Cabecera + pestañas que NO se desmontan al cambiar de pestaña: solo el
 * <Outlet> (el contenido de cada pestaña) cambia. Así no hay parpadeo de
 * "Cargando…" tapando todo cada vez que se navega entre General/WhatsApp/BD.
 */
export default function SucursalEditLayout() {
  const { id } = useParams<{ id: string }>();
  const [sucursal, setSucursal] = useState<SucursalDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);

  function cargar() {
    if (!id) return;
    apiFetch<SucursalDetalle>(`/api/admin/sucursales/${id}`)
      .then(setSucursal)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la sucursal."));
  }

  useEffect(cargar, [id]);

  return (
    <div className="pagina-formulario">
      <nav className="migas" aria-label="Ruta">
        <Link to="/sucursales">Sucursales</Link>
        <span aria-hidden="true">/</span>
        <span>Editar</span>
      </nav>

      <header className="pagina-cabecera">
        <h1>{sucursal ? `Editar ${sucursal.nombre}` : "Editar sucursal"}</h1>
        <p>Define cómo se identifica y qué ve su personal al entrar al panel.</p>
      </header>

      {id && <PestanasSucursal id={id} />}

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {sucursal ? (
        <Outlet context={{ sucursal, recargar: cargar } satisfies Contexto} />
      ) : (
        !error && <p className="campo-ayuda" style={{ marginTop: 16 }}>Cargando…</p>
      )}
    </div>
  );
}
