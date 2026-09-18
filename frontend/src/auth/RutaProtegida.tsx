import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

/** Deja pasar solo con sesión activa. Recuerda a dónde iba para volver tras el login. */
export default function RutaProtegida() {
  const { session, cargando } = useAuth();
  const location = useLocation();

  if (cargando) return <p className="centrado">Cargando…</p>;

  if (!session) {
    return <Navigate to="/login" replace state={{ destino: location.pathname }} />;
  }
  return <Outlet />;
}
