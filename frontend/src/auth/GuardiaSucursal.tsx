import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { usePortal } from "../portal/PortalProvider";
import Cargador from "../componentes/Cargador";
import PortalSucursalMarcador from "../paginas/PortalSucursalMarcador";
import LayoutPortalSucursal from "../portal/LayoutPortalSucursal";
import PlantillasListado from "../portal/PlantillasListado";
import PlantillaFormulario from "../portal/PlantillaFormulario";
import LayoutPanel from "../componentes/LayoutPanel";
import { RUTAS_DEL_MENU } from "../navegacion";
import Inicio from "../paginas/Inicio";
import EnConstruccion from "../paginas/EnConstruccion";
import SucursalNueva from "../paginas/SucursalNueva";
import SucursalesListado from "../paginas/SucursalesListado";
import SucursalEditLayout from "../paginas/SucursalEditLayout";
import SucursalGeneral from "../paginas/SucursalGeneral";
import SucursalWhatsapp from "../paginas/SucursalWhatsapp";
import SucursalBaseDatos from "../paginas/SucursalBaseDatos";
import UsuariosNuevo from "../paginas/UsuariosNuevo";
import UsuariosListado from "../paginas/UsuariosListado";
import UsuarioEditar from "../paginas/UsuarioEditar";

/** Pantallas ya construidas del panel de plataforma. El resto del menú cae en el marcador. */
const PANTALLAS: Record<string, ReactNode> = {
  "/sucursales/nueva": <SucursalNueva />,
  "/sucursales": <SucursalesListado />,
  "/usuarios/nuevo": <UsuariosNuevo />,
  "/usuarios": <UsuariosListado />,
};

type Perfil = {
  id: string;
  correo: string;
  nombre: string | null;
  rol: "admin" | "asesor";
  sucursal_id: string | null;
  activo: boolean;
  sucursal: { id: string; nombre: string; color: string; logo_url: string | null } | null;
};

/**
 * El panel de plataforma (Sucursales, Usuarios, Administración) y el portal
 * de cada sucursal son cosas completamente distintas y nunca deben
 * cruzarse — en ninguna de las dos direcciones:
 *
 *  - Quien tenga una sucursal asignada no llega al menú de admin bajo
 *    ninguna circunstancia, sin importar por qué host haya entrado.
 *  - El subdominio de una sucursal nunca muestra el panel de admin, ni
 *    siquiera si quien entró es el administrador de plataforma: es la
 *    misma app (mismo build) sirviendo cualquier host, así que sin este
 *    chequeo un admin viendo granauto.ge.autoinsights.mx vería el panel
 *    completo ahí también.
 *
 * Monta en App.tsx sobre un comodín ("/*"), así que es dueña de TODO su
 * árbol de rutas: admin y portal son dos <Routes> internas completamente
 * separadas, ninguna sabe que la otra existe.
 */
export default function GuardiaSucursal() {
  const { portal } = usePortal();
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    apiFetch<Perfil>("/api/perfil")
      .then(setPerfil)
      .finally(() => setCargando(false));
  }, []);

  if (cargando) return <Cargador pantalla />;

  // Host de una sucursal: nunca el panel de admin, sin importar quién sea.
  if (portal) {
    // La cuenta no es de esta sucursal (no debería pasar: Login/AuthCallback ya
    // rechazan esto al entrar). Defensa extra: tampoco aquí se le deja pasar.
    if (perfil?.sucursal_id !== portal.id) {
      return (
        <PortalSucursalMarcador
          nombre={perfil?.nombre ?? null}
          sucursal={{ nombre: portal.nombre, color: portal.color, logo_url: portal.logo }}
        />
      );
    }

    return (
      <Routes>
        <Route element={<LayoutPortalSucursal />}>
          <Route path="/" element={<Navigate to="/plantillas" replace />} />
          <Route path="/plantillas" element={<PlantillasListado />} />
          <Route path="/plantillas/nueva" element={<PlantillaFormulario />} />
          <Route path="/plantillas/:pid/editar" element={<PlantillaFormulario />} />
          <Route path="*" element={<Navigate to="/plantillas" replace />} />
        </Route>
      </Routes>
    );
  }

  // Host genérico, pero la cuenta pertenece a una sucursal: tampoco le
  // corresponde el panel de plataforma (y su portal real vive en su propio
  // subdominio, no aquí).
  if (perfil?.sucursal_id) {
    return <PortalSucursalMarcador nombre={perfil.nombre} sucursal={perfil.sucursal} />;
  }

  // Panel de plataforma: su propio árbol de rutas.
  return (
    <Routes>
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

        {/* Igual que sucursales: no vive en el menú, solo se llega desde el listado */}
        <Route path="/usuarios/:id/editar" element={<UsuarioEditar />} />

        {/* Las pantallas del menú existen para poder navegarlas */}
        {RUTAS_DEL_MENU.map(({ ruta, etiqueta }) => (
          <Route key={ruta} path={ruta} element={PANTALLAS[ruta] ?? <EnConstruccion titulo={etiqueta} />} />
        ))}

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
