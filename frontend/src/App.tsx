import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { PortalProvider, usePortal } from "./portal/PortalProvider";
import RutaProtegida from "./auth/RutaProtegida";
import RutaPublica from "./auth/RutaPublica";
import LayoutPanel from "./componentes/LayoutPanel";
import Cargador from "./componentes/Cargador";
import { RUTAS_DEL_MENU } from "./navegacion";
import Login from "./paginas/Login";
import OlvideContrasena from "./paginas/OlvideContrasena";
import RestablecerContrasena from "./paginas/RestablecerContrasena";
import AuthCallback from "./paginas/AuthCallback";
import Inicio from "./paginas/Inicio";
import EnConstruccion from "./paginas/EnConstruccion";
import SucursalNueva from "./paginas/SucursalNueva";
import SucursalesListado from "./paginas/SucursalesListado";
import SucursalEditLayout from "./paginas/SucursalEditLayout";
import SucursalGeneral from "./paginas/SucursalGeneral";
import SucursalWhatsapp from "./paginas/SucursalWhatsapp";
import SucursalBaseDatos from "./paginas/SucursalBaseDatos";
import UsuariosNuevo from "./paginas/UsuariosNuevo";
import UsuariosListado from "./paginas/UsuariosListado";
import PortalNoEncontrado from "./paginas/PortalNoEncontrado";

/** Pantallas ya construidas. El resto del menú cae en el marcador. */
const PANTALLAS: Record<string, ReactNode> = {
  "/sucursales/nueva": <SucursalNueva />,
  "/sucursales": <SucursalesListado />,
  "/usuarios/nuevo": <UsuariosNuevo />,
  "/usuarios": <UsuariosListado />,
};

/** Espera a saber de qué portal se trata antes de pintar nada. */
function Contenido() {
  const { cargando, noEncontrado } = usePortal();

  if (cargando) return <Cargador pantalla />;
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

              {/* Ruta dinámica: no vive en el menú, solo se llega por el botón Editar.
                  El layout carga la sucursal una sola vez; cambiar de pestaña
                  solo reemplaza el <Outlet>, no la cabecera. */}
              <Route path="/sucursales/:id" element={<SucursalEditLayout />}>
                <Route path="editar" element={<SucursalGeneral />} />
                <Route path="whatsapp" element={<SucursalWhatsapp />} />
                <Route path="base-datos" element={<SucursalBaseDatos />} />
              </Route>

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
