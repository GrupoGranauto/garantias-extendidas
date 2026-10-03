import { esCampoFecha, esOperadorFecha, type CampoPanel, type ItemPanel } from "../lib/panel";

/**
 * Lo que el usuario tiene puesto en el panel. Es lo único que se guarda en el
 * cliente: qué significa cada botón lo resuelve el servidor con la configuración
 * guardada, así la regla no se implementa dos veces.
 */
export type EstadoPanel = {
  /** Texto aplicado de cada caja de búsqueda (id del elemento → texto). */
  busquedas: Record<string, string>;
  /** Valores elegidos en cada desplegable (vacío = todos). */
  seleccion: Record<string, string[]>;
  /** Rango elegido en cada desplegable de fecha. */
  fechas: Record<string, { desde: string; hasta: string }>;
  /** Ids de los botones rápidos activos. */
  botones: string[];
};

/** Filtro tal como lo recibe el servidor: columna, valores y/o rango. */
export type FiltroWire = { c: string; v?: string[]; d?: string; h?: string };

/** El filtro principal es el botón que arranca activo. */
export const estadoInicial = (items: ItemPanel[]): EstadoPanel => ({
  busquedas: {},
  seleccion: {},
  fechas: {},
  botones: items.filter((i) => i.tipo === "boton" && i.principal).map((i) => i.id),
});

/** De fecha: un desplegable sobre una fecha, o un botón con fecha relativa o sobre una fecha. */
export function esDeFecha(item: ItemPanel, campos: CampoPanel[]): boolean {
  const campo = campos.find((c) => c.nombre_tecnico === item.columna);
  if (item.tipo === "desplegable") return esCampoFecha(campo);
  if (item.tipo === "boton") return esOperadorFecha(item.operador) || esCampoFecha(campo);
  return false;
}

/**
 * Prende o apaga un botón. Reglas del panel:
 *  - Solo un filtro de fecha activo a la vez: prender uno de fecha apaga los demás
 *    botones de fecha y limpia el rango de los desplegables de fecha.
 *  - Los botones de una misma columna son excluyentes: prender uno apaga los otros.
 *  - Botones de columnas distintas se suman.
 */
export function alternarBoton(estado: EstadoPanel, items: ItemPanel[], campos: CampoPanel[], id: string): EstadoPanel {
  const boton = items.find((i) => i.id === id && i.tipo === "boton");
  if (!boton) return estado;
  if (estado.botones.includes(id)) return { ...estado, botones: estado.botones.filter((x) => x !== id) };

  const otro = (x: string) => items.find((i) => i.id === x);
  if (esDeFecha(boton, campos)) {
    return {
      ...estado,
      fechas: {},
      botones: [...estado.botones.filter((x) => !(otro(x) && esDeFecha(otro(x)!, campos))), id],
    };
  }
  return { ...estado, botones: [...estado.botones.filter((x) => otro(x)?.columna !== boton.columna), id] };
}

/**
 * Aplica un rango desde/hasta a un desplegable de fecha. Siempre es un rango: un
 * fin vacío significa "el mismo día", y un fin anterior al inicio se invierte.
 * Apaga los botones de fecha (solo un filtro de fecha a la vez).
 */
export function aplicarFecha(
  estado: EstadoPanel,
  items: ItemPanel[],
  campos: CampoPanel[],
  id: string,
  desde: string,
  hasta: string,
): EstadoPanel {
  let inicio = desde;
  let fin = hasta || desde;
  if (fin < inicio) [inicio, fin] = [fin, inicio];
  const botones = estado.botones.filter((x) => {
    const item = items.find((i) => i.id === x);
    return !(item && esDeFecha(item, campos));
  });
  return { ...estado, botones, fechas: { [id]: { desde: inicio, hasta: fin } } };
}

export function limpiarFecha(estado: EstadoPanel, id: string): EstadoPanel {
  const { [id]: _quitada, ...resto } = estado.fechas;
  return { ...estado, fechas: resto };
}

export function cambiarSeleccion(estado: EstadoPanel, id: string, valores: string[]): EstadoPanel {
  const { [id]: _anterior, ...resto } = estado.seleccion;
  return { ...estado, seleccion: valores.length > 0 ? { ...resto, [id]: valores } : resto };
}

/**
 * Parámetros de consulta que salen del panel. `excluirId` omite el filtro de un
 * desplegable: para pedirle a ese mismo desplegable sus opciones sin que su propia
 * selección las reduzca a una sola.
 */
export function aParametros(
  estado: EstadoPanel,
  items: ItemPanel[],
  excluirId?: string,
): { filtros: FiltroWire[]; q: string[]; botones: string[] } {
  const filtros: FiltroWire[] = [];
  for (const item of items) {
    if (item.tipo !== "desplegable" || !item.columna || item.id === excluirId) continue;
    const fecha = estado.fechas[item.id];
    if (fecha) filtros.push({ c: item.columna, d: fecha.desde, h: fecha.hasta });
    const valores = estado.seleccion[item.id];
    if (valores && valores.length > 0) filtros.push({ c: item.columna, v: valores });
  }

  const q = items
    .filter((i) => i.tipo === "busqueda")
    .map((i) => (estado.busquedas[i.id] ?? "").trim())
    .filter((t) => t !== "");

  return { filtros, q, botones: estado.botones.filter((id) => items.some((i) => i.id === id)) };
}

/** Si hay cualquier filtro puesto, incluido el principal (para distinguir "sin resultados" de "sin registros"). */
export const hayFiltrosActivos = (estado: EstadoPanel): boolean =>
  estado.botones.length > 0 ||
  Object.values(estado.busquedas).some((t) => t.trim() !== "") ||
  Object.keys(estado.seleccion).length > 0 ||
  Object.keys(estado.fechas).length > 0;

/** Si hay algo puesto además del filtro principal de arranque. */
export function difiereDelInicio(estado: EstadoPanel, items: ItemPanel[]): boolean {
  const inicio = estadoInicial(items);
  const mismosBotones =
    estado.botones.length === inicio.botones.length && estado.botones.every((b) => inicio.botones.includes(b));
  return (
    !mismosBotones ||
    Object.values(estado.busquedas).some((t) => t.trim() !== "") ||
    Object.keys(estado.seleccion).length > 0 ||
    Object.keys(estado.fechas).length > 0
  );
}
