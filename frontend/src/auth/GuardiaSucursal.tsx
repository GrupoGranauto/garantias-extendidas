import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { usePortal } from "../portal/PortalProvider";
import Cargador from "../componentes/Cargador";
import PortalSucursalMarcador from "../paginas/PortalSucursalMarcador";
import LayoutPanel from "../componentes/LayoutPanel";
import { NAVEGACION_PORTAL, RUTAS_DEL_MENU } from "../navegacion";
import Inicio from "../paginas/Inicio";
import EnConstruccion from "../paginas/EnConstruccion";
import SucursalEditLayout from "../paginas/SucursalEditLayout";

/* Cada pantalla se descarga solo cuando se entra a ella: el primer arranque pesa mucho menos. */
const PANTALLAS_PORTAL = {
  plantillas: () => import("../portal/PlantillasListado"),
  plantilla: () => import("../portal/PlantillaFormulario"),
  baseDatos: () => import("../portal/BaseDatos"),
  chat: () => import("../portal/Chat"),
  tareas: () => import("../portal/Tareas"),
  inicio: () => import("../portal/InicioPortal"),
  automatizaciones: () => import("../portal/Automatizaciones"),
  reportes: () => import("../portal/Reportes"),
  equipo: () => import("../portal/Equipo"),
};
const PlantillasListado = lazy(PANTALLAS_PORTAL.plantillas);
const PlantillaFormulario = lazy(PANTALLAS_PORTAL.plantilla);
const BaseDatos = lazy(PANTALLAS_PORTAL.baseDatos);
const Chat = lazy(PANTALLAS_PORTAL.chat);
const Tareas = lazy(PANTALLAS_PORTAL.tareas);
const InicioPortal = lazy(PANTALLAS_PORTAL.inicio);
const Automatizaciones = lazy(PANTALLAS_PORTAL.automatizaciones);
const Reportes = lazy(PANTALLAS_PORTAL.reportes);
const Equipo = lazy(PANTALLAS_PORTAL.equipo);

/**
 * Ya dentro del portal, las demás pantallas se descargan en segundo plano. Sin esto, al entrar por primera vez a una
 * pantalla la anterior se queda congelada unos segundos (el cambio de ruta espera a que llegue el código).
 */
let portalPrecargado = false;
function precargarPortal() {
  if (portalPrecargado) return;
  portalPrecargado = true;
  setTimeout(() => {
    for (const cargar of Object.values(PANTALLAS_PORTAL)) cargar().catch(() => {});
  }, 1500);
}
const SucursalNueva = lazy(() => import("../paginas/SucursalNueva"));
const SucursalesListado = lazy(() => import("../paginas/SucursalesListado"));
const SucursalGeneral = lazy(() => import("../paginas/SucursalGeneral"));
const SucursalWhatsapp = lazy(() => import("../paginas/SucursalWhatsapp"));
const SucursalBaseDatos = lazy(() => import("../paginas/SucursalBaseDatos"));
const SucursalCamposEditables = lazy(() => import("../paginas/SucursalCamposEditables"));
const SucursalPanel = lazy(() => import("../paginas/SucursalPanel"));
const UsuariosNuevo = lazy(() => import("../paginas/UsuariosNuevo"));
const UsuariosListado = lazy(() => import("../paginas/UsuariosListado"));
const UsuarioEditar = lazy(() => import("../paginas/UsuarioEditar"));

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
  puesto: string | null;
  foto_url: string | null;
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

  useEffect(() => {
    if (portal && perfil?.sucursal_id === portal.id) precargarPortal();
  }, [portal, perfil]);

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

    // La pestaña de Plantillas solo la maneja el admin. El asesor ve y usa todo
    // lo demás (incluido mandar plantillas desde el chat), pero no la gestión.
    const esAdmin = perfil?.rol === "admin";
    const navPortal = esAdmin
      ? NAVEGACION_PORTAL
      : NAVEGACION_PORTAL.map((g) => ({
          ...g,
          secciones: g.secciones.filter((s) => s.ruta !== "/plantillas" && s.ruta !== "/automatizaciones" && s.ruta !== "/equipo"),
        }));

    return (
      <Suspense fallback={<Cargador pantalla />}>
      <Routes>
        <Route
          element={
            <LayoutPanel
              grupos={navPortal}
              logo={portal.logoPanel ?? portal.logo}
              logoAlt={portal.nombre}
              perfil={perfil}
            />
          }
        >
          <Route path="/" element={<InicioPortal />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/base-datos" element={<BaseDatos />} />
          <Route path="/tareas" element={<Tareas />} />
          <Route path="/reportes" element={<Reportes />} />
          {esAdmin && <Route path="/equipo" element={<Equipo />} />}
          {esAdmin && <Route path="/automatizaciones" element={<Automatizaciones />} />}
          {esAdmin && <Route path="/plantillas" element={<PlantillasListado />} />}
          {esAdmin && <Route path="/plantillas/nueva" element={<PlantillaFormulario />} />}
          {esAdmin && <Route path="/plantillas/:pid/editar" element={<PlantillaFormulario />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      </Suspense>
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
    <Suspense fallback={<Cargador pantalla />}>
    <Routes>
      <Route element={<LayoutPanel perfil={perfil} />}>
        <Route path="/" element={<Inicio />} />

        {/* Ruta dinámica: no vive en el menú, solo se llega por el botón Editar.
            El layout carga la sucursal una sola vez; cambiar de pestaña
            solo reemplaza el <Outlet>, no la cabecera. */}
        <Route path="/sucursales/:id" element={<SucursalEditLayout />}>
          <Route path="editar" element={<SucursalGeneral />} />
          <Route path="whatsapp" element={<SucursalWhatsapp />} />
          <Route path="base-datos" element={<SucursalBaseDatos />} />
          <Route path="campos" element={<SucursalCamposEditables />} />
          <Route path="panel" element={<SucursalPanel />} />
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
    </Suspense>
  );
}
