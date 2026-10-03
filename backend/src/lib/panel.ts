import { z } from "zod";
import type { CampoEntidad, FiltroColumna } from "./entidades.js";

/**
 * Panel de filtrado de la tabla de una sucursal: un arreglo ordenado de
 * elementos que se dibujan según su tipo.
 *   - busqueda:    caja de texto libre que busca en todas las columnas visibles.
 *   - desplegable: lista de valores de una columna (simple o múltiple); en una
 *                  columna de fecha es un rango desde/hasta.
 *   - kpi:         tarjeta que cuenta filas (el total, o donde una columna cumple
 *                  una condición). Cuenta dentro de los filtros activos.
 *   - boton:       filtro rápido con la misma condición que un KPI; se prende y
 *                  se apaga. Solo uno puede ser el filtro principal (arranca activo).
 */
export const TIPOS_ITEM = ["busqueda", "desplegable", "kpi", "boton"] as const;
export type TipoItem = (typeof TIPOS_ITEM)[number];

export const OPERADORES_FECHA = ["hoy", "manana", "semana", "mes", "mes_anterior"] as const;
export type OperadorFecha = (typeof OPERADORES_FECHA)[number];

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

const MAX_ITEMS = 40;

export const itemPanelSchema = z.object({
  id: z.string().trim().min(1).max(64),
  tipo: z.enum(TIPOS_ITEM),
  etiqueta: z.string().trim().min(1, "Todos los elementos necesitan una etiqueta.").max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Color hexadecimal de 6 dígitos.")
    .nullable()
    .default(null),
  columna: z.string().trim().min(1).nullable().default(null),
  operador: z.enum(["contiene", "igual", ...OPERADORES_FECHA]).nullable().default(null),
  valor: z.string().trim().max(200).nullable().default(null),
  principal: z.boolean().default(false),
  multiple: z.boolean().default(false),
  ancho: z.number().int().min(1).max(4).default(1),
});

export const panelSchema = z.object({ items: z.array(itemPanelSchema).max(MAX_ITEMS) });

const esFecha = (c: CampoEntidad) => c.tipo === "fecha" || c.tipo === "fecha_hora";

/** Valida el panel completo contra las columnas visibles. Devuelve el texto del error, o null. */
export function validarPanel(items: ItemPanel[], campos: CampoEntidad[]): string | null {
  const porNombre = new Map(campos.map((c) => [c.nombre_tecnico, c]));
  const ids = new Set<string>();
  let principales = 0;

  for (const item of items) {
    if (ids.has(item.id)) return "Hay elementos con el mismo identificador.";
    ids.add(item.id);

    if (item.principal) {
      if (item.tipo !== "boton") return `Solo un botón puede ser el filtro principal ('${item.etiqueta}' no lo es).`;
      principales++;
    }

    if (item.tipo === "busqueda") continue;

    const esKpiTotal = item.tipo === "kpi" && item.columna === null;
    if (esKpiTotal) continue;

    if (!item.columna) return `'${item.etiqueta}': elige una columna.`;
    const campo = porNombre.get(item.columna);
    if (!campo) return `'${item.etiqueta}': la columna '${item.columna}' no existe o está oculta.`;

    if (item.tipo === "desplegable") {
      if (item.multiple && esFecha(campo)) return `'${item.etiqueta}': una fecha no admite selección múltiple.`;
      continue;
    }

    // kpi (con columna) y boton: necesitan operador, y valor cuando compara.
    if (!item.operador) return `'${item.etiqueta}': elige una condición.`;
    const relativo = (OPERADORES_FECHA as readonly string[]).includes(item.operador);
    if (relativo && !esFecha(campo)) {
      return `'${item.etiqueta}': '${campo.nombre_visible}' no es una fecha, no admite "${item.operador}".`;
    }
    if (!relativo && !item.valor) return `'${item.etiqueta}': escribe el valor a comparar.`;
  }

  if (principales > 1) return "Solo puede haber un filtro principal.";
  return null;
}

/** Lee el JSON guardado sin confiar en él: lo que no cumpla el esquema se descarta. */
export function leerPanelGuardado(crudo: unknown): ItemPanel[] {
  const parsed = panelSchema.safeParse({ items: Array.isArray(crudo) ? crudo : [] });
  return parsed.success ? (parsed.data.items as ItemPanel[]) : [];
}

/**
 * Los botones activos llegan como lista de ids; aquí se convierten en filtros con
 * la configuración guardada, para que la regla de cada botón viva en un solo lugar
 * (el cliente nunca la reimplementa). Un id desconocido, o de una columna que ya no
 * está disponible, se ignora.
 */
export function filtrosDeBotones(ids: string[], items: ItemPanel[], campos: CampoEntidad[]): FiltroColumna[] {
  const porNombre = new Map(campos.map((c) => [c.nombre_tecnico, c]));
  const filtros: FiltroColumna[] = [];
  for (const id of ids) {
    const item = items.find((i) => i.id === id && i.tipo === "boton");
    const campo = item?.columna ? porNombre.get(item.columna) : undefined;
    const filtro = item && campo ? filtroDeItem(item, campo) : null;
    if (filtro) filtros.push(filtro);
  }
  return filtros;
}

/**
 * Traduce la condición de un KPI o botón al filtro que entiende la consulta.
 * En una columna Sí/No: "Sí" es solo verdadero; "No" incluye también lo que nunca
 * se llenó (un registro sin tocar es tan "no" como uno marcado No); "No asignado"
 * es solo lo vacío.
 */
export function filtroDeItem(item: ItemPanel, campo: CampoEntidad): FiltroColumna | null {
  if (!item.columna || !item.operador) return null;
  const columna = item.columna;

  if ((OPERADORES_FECHA as readonly string[]).includes(item.operador)) {
    return { columna, relativo: item.operador as OperadorFecha };
  }
  const valor = (item.valor ?? "").trim();
  if (item.operador === "contiene") return { columna, contiene: valor };

  if (campo.tipo === "booleano") {
    const v = valor.toLowerCase();
    if (v === "no asignado") return { columna, vacio: true };
    if (v === "sí" || v === "si" || v === "true") return { columna, valores: ["true"] };
    if (v === "no" || v === "false") return { columna, valores: ["false"], incluirVacio: true };
  }
  return { columna, valores: [valor] };
}
