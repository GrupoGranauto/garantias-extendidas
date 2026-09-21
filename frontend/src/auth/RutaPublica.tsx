import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import Cargador from "../componentes/Cargador";

/** Login, registro, etc. Con sesión activa no tiene sentido mostrarlas. */
export default function RutaPublica() {
  const { session, cargando, enRecuperacion } = useAuth();

  if (cargando) return <Cargador pantalla />;

  // En recuperación hay sesión temporal, pero debe quedarse a cambiar la contraseña
  if (session && !enRecuperacion) return <Navigate to="/" replace />;

  return <Outlet />;
}
