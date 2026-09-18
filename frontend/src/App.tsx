import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { PortalProvider, usePortal } from "./portal/PortalProvider";
import RutaProtegida from "./auth/RutaProtegida";
import RutaPublica from "./auth/RutaPublica";
import LayoutPanel from "./componentes/LayoutPanel";
import { RUTAS_DEL_MENU } from "./navegacion";
import Login from "./paginas/Login";
import OlvideContrasena from "./paginas/OlvideContrasena";
import RestablecerContrasena from "./paginas/RestablecerContrasena";
import AuthCallback from "./paginas/AuthCallback";
import Inicio from "./paginas/Inicio";
import EnConstruccion from "./paginas/EnConstruccion";
import SucursalNueva from "./paginas/SucursalNueva";
import SucursalesListado from "./paginas/SucursalesListado";
import PortalNoEncontrado from "./paginas/PortalNoEncontrado";

/** Pantallas ya construidas. El resto del menú cae en el marcador. */
const PANTALLAS: Record<string, ReactNode> = {
  "/sucursales/nueva": <SucursalNueva />,
  "/sucursales": <SucursalesListado />,
};

/** Espera a saber de qué portal se trata antes de pintar nada. */
function Contenido() {
  const { cargando, noEncontrado } = usePortal();

  if (cargando) return <p className="centrado">Cargando…</p>;
  if (noEncontrado) return <PortalNoEncontrado />;

  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Sin sesión */}
          <Route element={<RutaPublica />}>
            <Route path="/login" element={<Login />} />
            <Route path="/olvide-contrasena" element={<OlvideContrasena />} />
          </Route>

          {/* Sin guardia: manejan su propio estado a partir de la URL */}
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/restablecer" element={<RestablecerContrasena />} />

          {/* Con sesión: todo vive dentro del panel */}
          <Route element={<RutaProtegida />}>
            <Route element={<LayoutPanel />}>
              <Route path="/" element={<Inicio />} />

              {/* Las pantallas del menú existen para poder navegarlas */}
              {RUTAS_DEL_MENU.map(({ ruta, etiqueta }) => (
                <Route
                  key={ruta}
                  path={ruta}
                  element={PANTALLAS[ruta] ?? <EnConstruccion titulo={etiqueta} />}
                />
              ))}
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <PortalProvider>
      <Contenido />
    </PortalProvider>
  );
}
