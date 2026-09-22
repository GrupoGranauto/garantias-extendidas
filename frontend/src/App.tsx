import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { PortalProvider, usePortal } from "./portal/PortalProvider";
import RutaProtegida from "./auth/RutaProtegida";
import RutaPublica from "./auth/RutaPublica";
import GuardiaSucursal from "./auth/GuardiaSucursal";
import Cargador from "./componentes/Cargador";
import Login from "./paginas/Login";
import OlvideContrasena from "./paginas/OlvideContrasena";
import RestablecerContrasena from "./paginas/RestablecerContrasena";
import AuthCallback from "./paginas/AuthCallback";
import PortalNoEncontrado from "./paginas/PortalNoEncontrado";

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

          {/* Con sesión: el panel de plataforma y el portal de una sucursal
              son cosas distintas y nunca deben cruzarse. GuardiaSucursal
              decide cuál toca y es dueña de TODO su árbol de rutas (propio
              <Routes> interno) — por eso monta en un comodín "/*": así el
              <Routes> de aquí afuera nunca intenta (y falla en) resolver
              rutas que solo GuardiaSucursal conoce, como "/plantillas". */}
          <Route element={<RutaProtegida />}>
            <Route path="/*" element={<GuardiaSucursal />} />
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
