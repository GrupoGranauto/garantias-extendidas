/**
 * Panel de filtrado de la tabla de una sucursal. Mismo modelo que el backend
 * (backend/src/lib/panel.ts): un arreglo ordenado de elementos.
 */
export type TipoItem = "busqueda" | "desplegable" | "kpi" | "boton";
export type OperadorFecha = "hoy" | "manana" | "semana" | "mes" | "mes_anterior";
export type OperadorItem = "contiene" | "igual" | OperadorFecha;

export type ItemPanel = {
  id: string;
  tipo: TipoItem;
  etiqueta: string;
  color: string | null;
  columna: string | null;
  operador: OperadorItem | null;
  valor: string | null;
  principal: boolean;
  multiple: boolean;
  ancho: number;
};

/** Columna tal como la necesita el panel: nombre, etiqueta y tipo. */
export type CampoPanel = { nombre_tecnico: string; nombre_visible: string; tipo: string };

export const OPERADORES_FECHA: { valor: OperadorFecha; etiqueta: string }[] = [
  { valor: "hoy", etiqueta: "Hoy" },
  { valor: "manana", etiqueta: "Mañana" },
  { valor: "semana", etiqueta: "Esta semana" },
  { valor: "mes", etiqueta: "Este mes" },
  { valor: "mes_anterior", etiqueta: "Mes anterior" },
];

export const TITULO_TIPO: Record<TipoItem, string> = {
  busqueda: "Búsqueda por texto",
  desplegable: "Filtro desplegable",
  kpi: "KPI (contador)",
  boton: "Filtro por botón",
};

export const esOperadorFecha = (op: string | null): op is OperadorFecha =>
  OPERADORES_FECHA.some((o) => o.valor === op);

export const esCampoFecha = (campo: CampoPanel | undefined) => campo?.tipo === "fecha" || campo?.tipo === "fecha_hora";

/** Secciones del panel: cada tipo de elemento vive en una. */
export type SeccionPanel = "filtros" | "insights" | "rapidos";

export const SECCION_DE: Record<TipoItem, SeccionPanel> = {
  busqueda: "filtros",
  desplegable: "filtros",
  kpi: "insights",
  boton: "rapidos",
};

export const SECCIONES: { clave: SeccionPanel; titulo: string; descripcion: string }[] = [
  { clave: "filtros", titulo: "Filtros", descripcion: "Búsqueda y segmentación" },
  { clave: "insights", titulo: "Insights", descripcion: "KPIs y contadores" },
  { clave: "rapidos", titulo: "Filtros rápidos", descripcion: "Accesos directos y pestañas" },
];

export const COLOR_KPI_POR_DEFECTO = "#111827";

export function idNuevo(): string {
  return crypto.randomUUID();
}

export function itemNuevo(tipo: TipoItem): ItemPanel {
  return {
    id: idNuevo(),
    tipo,
    etiqueta: "",
    color: tipo === "kpi" ? COLOR_KPI_POR_DEFECTO : null,
    columna: null,
    operador: null,
    valor: null,
    principal: false,
    multiple: false,
    ancho: 1,
  };
}
