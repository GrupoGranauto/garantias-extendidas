import type { ReactNode } from "react";
import {
  IconoInicio,
  IconoGrupos,
  IconoUsuarios,
  IconoAdministradores,
  IconoMensaje,
  IconoAutomatizaciones,
  IconoEquipo,
  IconoReportes,
  IconoBaseDatos,
  IconoTareas,
  IconoChat,
} from "./componentes/Iconos";

export type Enlace = { etiqueta: string; ruta: string };

export type Seccion = {
  etiqueta: string;
  icono: ReactNode;
  /** Sin hijos es un enlace directo; con hijos despliega submenú. */
  ruta?: string;
  hijos?: Enlace[];
};

export type Grupo = { titulo?: string; secciones: Seccion[] };

/** Estructura del menú lateral. Las pantallas aún son marcadores de posición. */
export const NAVEGACION: Grupo[] = [
  {
    secciones: [
      { etiqueta: "Inicio", icono: <IconoInicio />, ruta: "/" },
      {
        etiqueta: "Sucursales",
        icono: <IconoGrupos />,
        hijos: [
          { etiqueta: "Nueva", ruta: "/sucursales/nueva" },
          { etiqueta: "Listado", ruta: "/sucursales" },
        ],
      },
      {
        etiqueta: "Usuarios",
        icono: <IconoUsuarios />,
        hijos: [
          { etiqueta: "Nuevo", ruta: "/usuarios/nuevo" },
          { etiqueta: "Listado", ruta: "/usuarios" },
        ],
      },
    ],
  },
  {
    titulo: "Configuración",
    secciones: [
      {
        etiqueta: "Administración",
        icono: <IconoAdministradores />,
        hijos: [
          { etiqueta: "Invitaciones", ruta: "/admin/invitaciones" },
          { etiqueta: "Conexiones", ruta: "/admin/conexiones" },
        ],
      },
    ],
  },
];

/** Menú del portal de una sucursal: nada que ver con NAVEGACION (esa es del panel de plataforma). */
export const NAVEGACION_PORTAL: Grupo[] = [
  {
    secciones: [
      { etiqueta: "Inicio", icono: <IconoInicio />, ruta: "/" },
      { etiqueta: "Chat", icono: <IconoChat />, ruta: "/chat" },
      { etiqueta: "Base de Datos", icono: <IconoBaseDatos />, ruta: "/base-datos" },
      { etiqueta: "Tareas", icono: <IconoTareas />, ruta: "/tareas" },
      { etiqueta: "Reportes", icono: <IconoReportes />, ruta: "/reportes" },
      { etiqueta: "Automatizaciones", icono: <IconoAutomatizaciones />, ruta: "/automatizaciones" },
      { etiqueta: "Equipo", icono: <IconoEquipo />, ruta: "/equipo" },
      { etiqueta: "Plantillas", icono: <IconoMensaje />, ruta: "/plantillas" },
    ],
  },
];

/** Todas las rutas del menú, para registrar los marcadores de posición. */
export const RUTAS_DEL_MENU: Enlace[] = NAVEGACION.flatMap((g) =>
  g.secciones.flatMap((s) =>
    s.hijos ? s.hijos : s.ruta && s.ruta !== "/" ? [{ etiqueta: s.etiqueta, ruta: s.ruta }] : [],
  ),
);
