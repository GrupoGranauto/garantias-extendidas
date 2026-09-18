import type { ReactNode } from "react";
import {
  IconoInicio,
  IconoGrupos,
  IconoUsuarios,
  IconoAdministradores,
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

/** Todas las rutas del menú, para registrar los marcadores de posición. */
export const RUTAS_DEL_MENU: Enlace[] = NAVEGACION.flatMap((g) =>
  g.secciones.flatMap((s) =>
    s.hijos ? s.hijos : s.ruta && s.ruta !== "/" ? [{ etiqueta: s.etiqueta, ruta: s.ruta }] : [],
  ),
);
