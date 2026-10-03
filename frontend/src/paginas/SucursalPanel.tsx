import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoChevron, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import {
  COLOR_KPI_POR_DEFECTO,
  OPERADORES_FECHA,
  SECCIONES,
  SECCION_DE,
  TITULO_TIPO,
  esCampoFecha,
  esOperadorFecha,
  itemNuevo,
  type CampoPanel,
  type ItemPanel,
  type OperadorItem,
  type SeccionPanel,
  type TipoItem,
} from "../lib/panel";
import PanelFiltros from "../portal/PanelFiltros";
import { estadoInicial } from "../portal/estadoPanel";
import { useSucursal } from "./SucursalEditLayout";

const TIPOS: TipoItem[] = ["busqueda", "desplegable", "kpi", "boton"];

function operadoresPara(campo: CampoPanel | undefined): { valor: OperadorItem; etiqueta: string }[] {
  const base: { valor: OperadorItem; etiqueta: string }[] = [
    { valor: "contiene", etiqueta: "Contiene" },
    { valor: "igual", etiqueta: "Es igual a" },
  ];
  return esCampoFecha(campo) ? [...base, ...OPERADORES_FECHA] : base;
}

/** Resumen de una línea de lo que hace un elemento. */
function resumen(item: ItemPanel, campos: CampoPanel[]): string {
  const campo = campos.find((c) => c.nombre_tecnico === item.columna);
  const nombre = campo?.nombre_visible ?? item.columna ?? "columna no disponible";
  if (item.tipo === "busqueda") return "Búsqueda libre en todas las columnas";
  if (item.tipo === "kpi" && !item.columna) return "Conteo total de registros";
  if (item.tipo === "desplegable") {
    return esCampoFecha(campo) ? `Rango de fechas de ${nombre}` : `Lista desplegable de ${nombre}${item.multiple ? " (varias opciones)" : ""}`;
  }
  const op = [...operadoresPara(campo)].find((o) => o.valor === item.operador)?.etiqueta ?? item.operador ?? "";
  return esOperadorFecha(item.operador) ? `${nombre}: ${op.toLowerCase()}` : `${nombre} ${op.toLowerCase()} "${item.valor ?? ""}"`;
}

export default function SucursalPanel() {
  const { sucursal } = useSucursal();

  const [cargando, setCargando] = useState(true);
  const [configurado, setConfigurado] = useState(true);
  const [items, setItems] = useState<ItemPanel[]>([]);
  const [campos, setCampos] = useState<CampoPanel[]>([]);
  const [editando, setEditando] = useState<ItemPanel | null>(null);
  const [esNuevo, setEsNuevo] = useState(false);
  const [errorEditor, setErrorEditor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [sucio, setSucio] = useState(false);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    apiFetch<{ configurado: boolean; items: ItemPanel[]; campos: CampoPanel[] }>(
      `/api/admin/sucursales/${sucursal.id}/entidad/panel`,
    )
      .then((r) => {
        setConfigurado(r.configurado);
        setItems(r.items);
        setCampos(r.campos);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el panel."))
      .finally(() => setCargando(false));
  }, [sucursal.id]);

  function cambiar(siguientes: ItemPanel[]) {
    setItems(siguientes);
    setSucio(true);
    setGuardado(false);
  }

  function abrirNuevo(tipo: TipoItem) {
    setEditando(itemNuevo(tipo));
    setEsNuevo(true);
    setErrorEditor(null);
  }

  function abrirEdicion(item: ItemPanel) {
    setEditando({ ...item });
    setEsNuevo(false);
    setErrorEditor(null);
  }

  function actualizarEditor(cambios: Partial<ItemPanel>) {
    setEditando((prev) => (prev ? { ...prev, ...cambios } : prev));
  }

  /** Cambiar de tipo conserva etiqueta y ancho y limpia lo que ya no aplica. */
  function cambiarTipo(tipo: TipoItem) {
    setEditando((prev) =>
      prev ? { ...itemNuevo(tipo), id: prev.id, etiqueta: prev.etiqueta, ancho: prev.ancho } : prev,
    );
  }

  /** Al cambiar de columna se ajusta la condición a las que admite y se limpia el valor si ya no cabe. */
  function cambiarColumna(columna: string) {
    const campo = campos.find((c) => c.nombre_tecnico === columna);
    setEditando((prev) => {
      if (!prev) return prev;
      const validos = operadoresPara(campo).map((o) => o.valor);
      const operador = prev.operador && validos.includes(prev.operador) ? prev.operador : (validos[0] ?? null);
      const multiple = esCampoFecha(campo) ? false : prev.multiple;
      return { ...prev, columna, operador: prev.tipo === "desplegable" ? null : operador, multiple, valor: null };
    });
  }

  function aceptarEditor() {
    if (!editando) return;
    const e = editando;
    if (!e.etiqueta.trim()) return setErrorEditor("Escribe una etiqueta.");
    if (e.tipo !== "busqueda" && !(e.tipo === "kpi" && e.columna === null) && !e.columna) {
      return setErrorEditor("Elige una columna.");
    }
    if ((e.tipo === "kpi" || e.tipo === "boton") && e.columna) {
      if (!e.operador) return setErrorEditor("Elige una condición.");
      if (!esOperadorFecha(e.operador) && !(e.valor ?? "").trim()) return setErrorEditor("Escribe el valor a comparar.");
    }

    const limpio: ItemPanel = { ...e, etiqueta: e.etiqueta.trim(), valor: e.valor?.trim() || null };
    // Solo puede haber un filtro principal: marcar uno desmarca el anterior.
    const base = limpio.principal ? items.map((i) => (i.id === limpio.id ? i : { ...i, principal: false })) : items;
    cambiar(esNuevo ? [...base, limpio] : base.map((i) => (i.id === limpio.id ? limpio : i)));
    setEditando(null);
  }

  /** Mueve un elemento arriba o abajo dentro de su misma sección. */
  function mover(id: string, direccion: -1 | 1) {
    const indice = items.findIndex((i) => i.id === id);
    const seccion = SECCION_DE[items[indice].tipo];
    let destino = indice + direccion;
    while (destino >= 0 && destino < items.length && SECCION_DE[items[destino].tipo] !== seccion) destino += direccion;
    if (destino < 0 || destino >= items.length) return;
    const copia = [...items];
    [copia[indice], copia[destino]] = [copia[destino], copia[indice]];
    cambiar(copia);
  }

  function quitar(id: string) {
    cambiar(items.filter((i) => i.id !== id));
  }

  async function guardar() {
    setError(null);
    setEnviando(true);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursal.id}/entidad/panel`, {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
      setSucio(false);
      setGuardado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el panel.");
    } finally {
      setEnviando(false);
    }
  }

  if (cargando) return <Cargador />;

  const campoEditor = campos.find((c) => c.nombre_tecnico === editando?.columna);
  const operadoresEditor = operadoresPara(campoEditor);
  const tieneCondicion = editando && (editando.tipo === "boton" || (editando.tipo === "kpi" && editando.columna !== null));

  return (
    <>
      <p className="pestana-descripcion">
        Arma el panel que ve el personal sobre la tabla: cajas de búsqueda y desplegables, tarjetas con contadores y botones de
        filtro rápido. Los contadores cuentan dentro de los filtros que el usuario tenga puestos.
      </p>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}
      {guardado && !sucio && (
        <div className="aviso-formulario">
          <Alerta tipo="ok">Panel guardado.</Alerta>
        </div>
      )}

      {!configurado && (
        <div className="marcador">
          <strong>Primero define la entidad</strong>
          <span>Crea la tabla en la pestaña «Base de datos» para poder armar su panel.</span>
        </div>
      )}

      {configurado && (
        <>
          {SECCIONES.map((seccion) => {
            const delaSeccion = items.filter((i) => SECCION_DE[i.tipo] === (seccion.clave as SeccionPanel));
            return (
              <section className="seccion" key={seccion.clave}>
                <div className="seccion-info">
                  <h2>{seccion.titulo}</h2>
                  <p>{seccion.descripcion}</p>
                </div>
                <div className="seccion-campos">
                  {delaSeccion.length === 0 && <p className="campo-ayuda">Sin elementos en este bloque.</p>}
                  {delaSeccion.map((item, i) => {
                    const campo = campos.find((c) => c.nombre_tecnico === item.columna);
                    const huerfano = item.columna !== null && !campo;
                    return (
                      <div className="pb-fila" key={item.id}>
                        <div className="pb-mover">
                          <button type="button" className="boton-tenue" disabled={i === 0} onClick={() => mover(item.id, -1)} aria-label="Subir">
                            <IconoChevron className="pb-subir" />
                          </button>
                          <button
                            type="button"
                            className="boton-tenue"
                            disabled={i === delaSeccion.length - 1}
                            onClick={() => mover(item.id, 1)}
                            aria-label="Bajar"
                          >
                            <IconoChevron />
                          </button>
                        </div>
                        <div className="pb-datos">
                          <strong>{item.etiqueta}</strong>
                          <span className={huerfano ? "pb-alerta" : undefined}>
                            {huerfano ? `La columna «${item.columna}» ya no está disponible` : resumen(item, campos)}
                          </span>
                        </div>
                        <div className="pb-insignias">
                          <span className="pb-tipo">{TITULO_TIPO[item.tipo]}</span>
                          {item.principal && <span className="pb-insignia">Principal</span>}
                          {item.ancho > 1 && <span className="pb-insignia">Ancho {item.ancho}</span>}
                        </div>
                        <div className="pb-acciones">
                          <button type="button" className="boton-tenue" onClick={() => abrirEdicion(item)}>
                            Editar
                          </button>
                          <button type="button" className="boton-tenue boton-peligro" onClick={() => quitar(item.id)} aria-label="Quitar">
                            <IconoXMarca className="icono-inline" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {/* ---------- Editor de un elemento ---------- */}
          {editando ? (
            <section className="seccion pb-editor">
              <div className="seccion-info">
                <h2>{esNuevo ? "Nuevo elemento" : "Editar elemento"}</h2>
                <p>{TITULO_TIPO[editando.tipo]}</p>
              </div>
              <div className="seccion-campos">
                {errorEditor && <Alerta tipo="error">{errorEditor}</Alerta>}

                <div className="pareja-campos">
                  <div className="campo-formulario">
                    <label htmlFor="pb-tipo">Tipo</label>
                    <select id="pb-tipo" value={editando.tipo} disabled={!esNuevo} onChange={(e) => cambiarTipo(e.target.value as TipoItem)}>
                      {TIPOS.map((t) => (
                        <option key={t} value={t}>
                          {TITULO_TIPO[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="campo-formulario">
                    <label htmlFor="pb-etiqueta">
                      Etiqueta <span className="obligatorio">*</span>
                    </label>
                    <input
                      id="pb-etiqueta"
                      type="text"
                      value={editando.etiqueta}
                      maxLength={60}
                      onChange={(e) => actualizarEditor({ etiqueta: e.target.value })}
                      placeholder="Texto que verán los usuarios"
                    />
                  </div>
                </div>

                {editando.tipo === "kpi" && (
                  <div className="campo-formulario">
                    <label htmlFor="pb-regla">Regla del KPI</label>
                    <select
                      id="pb-regla"
                      value={editando.columna === null ? "total" : "condicion"}
                      onChange={(e) =>
                        e.target.value === "total"
                          ? actualizarEditor({ columna: null, operador: null, valor: null })
                          : actualizarEditor({ columna: campos[0]?.nombre_tecnico ?? null, operador: "contiene", valor: null })
                      }
                    >
                      <option value="total">Total de registros</option>
                      <option value="condicion">Contar donde una columna cumpla una condición</option>
                    </select>
                  </div>
                )}

                {editando.tipo !== "busqueda" && !(editando.tipo === "kpi" && editando.columna === null) && (
                  <div className="campo-formulario">
                    <label htmlFor="pb-columna">Columna</label>
                    <select id="pb-columna" value={editando.columna ?? ""} onChange={(e) => cambiarColumna(e.target.value)}>
                      <option value="" disabled>
                        Elige una columna
                      </option>
                      {campos.map((c) => (
                        <option key={c.nombre_tecnico} value={c.nombre_tecnico}>
                          {c.nombre_visible}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {editando.tipo === "desplegable" && editando.columna && (
                  <label className="campo-check-inline">
                    <input
                      type="checkbox"
                      checked={editando.multiple}
                      disabled={esCampoFecha(campoEditor)}
                      onChange={(e) => actualizarEditor({ multiple: e.target.checked })}
                    />
                    Permitir seleccionar varios valores
                    {esCampoFecha(campoEditor) && <span className="campo-ayuda"> — una fecha siempre es un rango desde/hasta</span>}
                  </label>
                )}

                {tieneCondicion && editando.columna && (
                  <div className="pareja-campos">
                    <div className="campo-formulario">
                      <label htmlFor="pb-operador">Condición</label>
                      <select
                        id="pb-operador"
                        value={editando.operador ?? ""}
                        onChange={(e) => actualizarEditor({ operador: e.target.value as OperadorItem, valor: null })}
                      >
                        {operadoresEditor.map((o) => (
                          <option key={o.valor} value={o.valor}>
                            {o.etiqueta}
                          </option>
                        ))}
                      </select>
                    </div>
                    {!esOperadorFecha(editando.operador) && (
                      <div className="campo-formulario">
                        <label htmlFor="pb-valor">Valor</label>
                        {campoEditor?.tipo === "booleano" && editando.operador === "igual" ? (
                          <select id="pb-valor" value={editando.valor ?? ""} onChange={(e) => actualizarEditor({ valor: e.target.value })}>
                            <option value="" disabled>
                              Elige…
                            </option>
                            <option value="Sí">Sí</option>
                            <option value="No">No</option>
                            <option value="No asignado">No asignado</option>
                          </select>
                        ) : (
                          <input id="pb-valor" type="text" value={editando.valor ?? ""} onChange={(e) => actualizarEditor({ valor: e.target.value })} />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {editando.tipo === "kpi" && (
                  <div className="campo-formulario">
                    <label htmlFor="pb-color">Color de la tarjeta</label>
                    <input
                      id="pb-color"
                      type="color"
                      value={editando.color ?? COLOR_KPI_POR_DEFECTO}
                      onChange={(e) => actualizarEditor({ color: e.target.value })}
                      style={{ width: 56, height: 36, padding: 2 }}
                    />
                  </div>
                )}

                {editando.tipo === "boton" && (
                  <label className="campo-check-inline">
                    <input type="checkbox" checked={editando.principal} onChange={(e) => actualizarEditor({ principal: e.target.checked })} />
                    Filtro principal: arranca activo y «Limpiar todo» lo restaura (solo uno)
                  </label>
                )}

                <div className="campo-formulario">
                  <label htmlFor="pb-ancho">Ancho (columnas de la cuadrícula)</label>
                  <select id="pb-ancho" value={editando.ancho} onChange={(e) => actualizarEditor({ ancho: Number(e.target.value) })}>
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="pagina-acciones">
                  <button type="button" className="boton-secundario-claro" onClick={() => setEditando(null)}>
                    Cancelar
                  </button>
                  <button type="button" className="boton-guardar" onClick={aceptarEditor}>
                    {esNuevo ? "Agregar" : "Aceptar"}
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <section className="seccion">
              <div className="seccion-info">
                <h2>Agregar elemento</h2>
                <p>Elige qué quieres sumar al panel.</p>
              </div>
              <div className="seccion-campos">
                <div className="pb-agregar">
                  {TIPOS.map((t) => (
                    <button key={t} type="button" className="boton-tenue" onClick={() => abrirNuevo(t)}>
                      + {TITULO_TIPO[t]}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* ---------- Vista previa ---------- */}
          <section className="seccion">
            <div className="seccion-info">
              <h2>Vista previa</h2>
              <p>Así se ve el panel. Los controles no responden aquí.</p>
            </div>
            <div className="seccion-campos">
              {items.length === 0 ? (
                <p className="campo-ayuda">Agrega elementos para ver cómo queda.</p>
              ) : (
                <PanelFiltros
                  items={items}
                  campos={campos}
                  estado={estadoInicial(items)}
                  escritos={{}}
                  kpis={{}}
                  visibilidad={{ filtros: true, insights: true, rapidos: true }}
                  soloVista
                  onEscribir={() => {}}
                  onSeleccion={() => {}}
                  onAplicarFecha={() => {}}
                  onLimpiarFecha={() => {}}
                  onBoton={() => {}}
                  cargarValores={async () => []}
                />
              )}
            </div>
          </section>

          <footer className="barra-acciones">
            <p>{sucio ? "Hay cambios sin guardar." : ""}</p>
            <div className="pagina-acciones">
              <button type="button" className="boton-guardar" disabled={enviando || !sucio} onClick={guardar}>
                {enviando ? "Guardando…" : "Guardar panel"}
              </button>
            </div>
          </footer>
        </>
      )}
    </>
  );
}
