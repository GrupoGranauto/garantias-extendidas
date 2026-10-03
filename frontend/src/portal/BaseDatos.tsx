import { useEffect, useRef, useState, type CSSProperties } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import Flotante from "../componentes/Flotante";
import { IconoBuscar, IconoChevron, IconoFiltro, IconoVistaEmbudo, IconoVistaTabla, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { SECCIONES, type CampoPanel, type ItemPanel } from "../lib/panel";
import { supabase } from "../lib/supabase";
import Embudo from "./Embudo";
import PanelFiltros, { type ValorKpi, type Visibilidad } from "./PanelFiltros";
import {
  alternarBoton,
  aParametros,
  aplicarFecha,
  cambiarSeleccion,
  estadoInicial,
  hayFiltrosActivos,
  limpiarFecha,
  type EstadoPanel,
} from "./estadoPanel";
import { usePortal } from "./PortalProvider";

type Tipo = "texto" | "entero" | "decimal" | "booleano" | "fecha" | "fecha_hora" | "uuid";
type Origen = "api" | "back";
type Opcion = { valor: string; color: string };

/** Filtro activo sobre una columna: valores exactos (varios = OR) y/o rango de fechas. */
type FiltroUI = { columna: string; valores: string[]; desde: string; hasta: string };
type Orden = { columna: string; dir: "asc" | "desc" };

const LIMITE = 200;

type CampoServidor = {
  nombre_tecnico: string;
  nombre_visible: string;
  tipo: Tipo;
  posicion: number;
  origen: Origen;
  editor_tipo: "texto" | "lista";
  opciones: Opcion[] | null;
};

type Fila = Record<string, unknown>;

type Respuesta =
  | { configurado: false }
  | {
      configurado: true;
      nombre_visible: string;
      /** La sucursal tiene embudo (modelo CRM): se ofrece la vista de tablero. */
      embudo?: boolean;
      campos: CampoServidor[];
      filas: Fila[];
      total: number;
      /** Valor de cada KPI del panel, calculado en el servidor dentro de los filtros activos. */
      kpis?: { id: string; valor: number | null; error?: string }[];
      pagina: number;
      limite: number;
    };

const VISIBILIDAD_INICIAL: Visibilidad = { filtros: true, insights: true, rapidos: true };

function leerVisibilidad(sucursalId: string): Visibilidad {
  try {
    const crudo = localStorage.getItem(`portal.panel.visibilidad.${sucursalId}`);
    return crudo ? { ...VISIBILIDAD_INICIAL, ...(JSON.parse(crudo) as Partial<Visibilidad>) } : VISIBILIDAD_INICIAL;
  } catch {
    return VISIBILIDAD_INICIAL;
  }
}

function formatearValor(valor: unknown, tipo: Tipo): string {
  if (valor === null || valor === undefined || valor === "") return "—";
  if (tipo === "booleano") return valor ? "Sí" : "No";
  if (tipo === "fecha") {
    const s = String(valor);
    // Puede venir como 'YYYY-MM-DD' o como ISO completo (según la columna).
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00") : new Date(s);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
  }
  if (tipo === "fecha_hora") {
    const d = new Date(String(valor));
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }
  return String(valor);
}

/** 'YYYY-MM-DD' para <input type="date">, desde una fecha o datetime. */
function aValorFecha(valor: unknown): string {
  if (!valor) return "";
  return String(valor).slice(0, 10);
}

const HOY = new Date().toISOString().slice(0, 10);

function Chip({ texto, color }: { texto: string; color: string }) {
  return (
    <span className="etiqueta-chip" style={{ "--chip": color } as CSSProperties}>
      {texto}
    </span>
  );
}

/** Desplegable de etiquetas: cada opción muestra su propio color; el menú va en
 *  position:fixed para que no lo corte el scroll de la tabla. */
function SelectEtiqueta({
  valor,
  opciones,
  onChange,
}: {
  valor: string;
  opciones: Opcion[];
  onChange: (v: string) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const alClic = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setAbierto(false);
    };
    // Cerrar al hacer scroll FUERA del menú (scroll de la página/tabla), pero
    // no cuando el scroll ocurre dentro del propio menú.
    const alScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setAbierto(false);
    };
    const cerrar = () => setAbierto(false);
    document.addEventListener("mousedown", alClic);
    window.addEventListener("scroll", alScroll, true);
    window.addEventListener("resize", cerrar);
    return () => {
      document.removeEventListener("mousedown", alClic);
      window.removeEventListener("scroll", alScroll, true);
      window.removeEventListener("resize", cerrar);
    };
  }, [abierto]);

  function alternar() {
    if (abierto) {
      setAbierto(false);
      return;
    }
    const r = btnRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 190) });
    setAbierto(true);
  }

  const sel = opciones.find((o) => o.valor === valor);
  return (
    <>
      <button ref={btnRef} type="button" className="etq-select" onClick={alternar}>
        {sel ? <Chip texto={sel.valor} color={sel.color} /> : <span className="etq-select-vacio">—</span>}
        <IconoChevron className="etq-select-flecha" />
      </button>
      {abierto && pos && (
        <div ref={menuRef} className="etq-menu" style={{ top: pos.top, left: pos.left, minWidth: pos.width }}>
          {opciones.map((o) => (
            <button
              key={o.valor}
              type="button"
              className="etq-menu-op"
              onClick={() => {
                onChange(o.valor);
                setAbierto(false);
              }}
            >
              <Chip texto={o.valor} color={o.color} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Texto a mostrar para un valor crudo de filtro (los booleanos llegan como 'true'/'false'). */
function valorVisible(valor: string, campo: CampoServidor): string {
  if (campo.tipo === "booleano") return valor === "true" ? "Sí" : "No";
  return valor;
}

function fechaCorta(valor: string): string {
  if (!valor) return "…";
  const d = new Date(valor + "T00:00:00");
  return Number.isNaN(d.getTime()) ? valor : d.toLocaleDateString();
}

function resumenFiltro(campo: CampoServidor, f: FiltroUI): string {
  if (f.desde || f.hasta) return `${fechaCorta(f.desde)} – ${fechaCorta(f.hasta)}`;
  if (f.valores.length === 1) return valorVisible(f.valores[0], campo);
  return `${f.valores.length} valores`;
}

/** Panel flotante para crear o editar un filtro: primero la columna, luego sus valores o un rango de fechas. */
function PanelFiltro({
  sucursalId,
  campos,
  inicial,
  yaFiltradas,
  onAplicar,
  onCerrar,
}: {
  sucursalId: string;
  campos: CampoServidor[];
  inicial: FiltroUI | null;
  yaFiltradas: string[];
  onAplicar: (f: FiltroUI) => void;
  onCerrar: () => void;
}) {
  const [columna, setColumna] = useState<string | null>(inicial?.columna ?? null);
  const [valores, setValores] = useState<string[] | null>(null);
  const [errorValores, setErrorValores] = useState(false);
  const [sel, setSel] = useState<string[]>(inicial?.valores ?? []);
  const [desde, setDesde] = useState(inicial?.desde ?? "");
  const [hasta, setHasta] = useState(inicial?.hasta ?? "");
  const [buscar, setBuscar] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const campo = campos.find((c) => c.nombre_tecnico === columna) ?? null;
  const esFecha = campo?.tipo === "fecha" || campo?.tipo === "fecha_hora";

  useEffect(() => {
    const alClic = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onCerrar();
    };
    document.addEventListener("mousedown", alClic);
    return () => document.removeEventListener("mousedown", alClic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!campo || esFecha) return;
    setErrorValores(false);
    if (campo.tipo === "booleano") {
      setValores(["true", "false"]);
      return;
    }
    setValores(null);
    apiFetch<{ valores: string[] }>(
      `/api/admin/sucursales/${sucursalId}/entidad/registros/valores?columna=${encodeURIComponent(campo.nombre_tecnico)}`,
    )
      .then((r) => setValores(r.valores))
      .catch(() => setErrorValores(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columna]);

  const visibles = (valores ?? []).filter((v) =>
    valorVisible(v, campo!).toLowerCase().includes(buscar.trim().toLowerCase()),
  );
  const puedeAplicar = esFecha ? Boolean(desde || hasta) : sel.length > 0;

  function alternar(v: string) {
    setSel((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  }

  return (
    <div ref={panelRef} className="filtro-panel">
      {!campo ? (
        <>
          <div className="filtro-titulo">Filtrar por</div>
          <div className="filtro-lista">
            {campos
              .filter((c) => !yaFiltradas.includes(c.nombre_tecnico))
              .map((c) => (
                <button key={c.nombre_tecnico} type="button" className="filtro-op" onClick={() => setColumna(c.nombre_tecnico)}>
                  {c.nombre_visible}
                </button>
              ))}
          </div>
        </>
      ) : (
        <>
          <div className="filtro-titulo">
            {!inicial && (
              <button
                type="button"
                className="filtro-volver"
                aria-label="Cambiar de columna"
                onClick={() => {
                  setColumna(null);
                  setSel([]);
                  setDesde("");
                  setHasta("");
                  setBuscar("");
                }}
              >
                <IconoChevron />
              </button>
            )}
            {campo.nombre_visible}
          </div>

          {esFecha ? (
            <div className="filtro-fechas">
              <label>
                Desde
                <input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} />
              </label>
              <label>
                Hasta
                <input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} />
              </label>
            </div>
          ) : (
            <>
              <input
                type="text"
                className="filtro-buscar"
                placeholder="Buscar valor…"
                value={buscar}
                onChange={(e) => setBuscar(e.target.value)}
              />
              <div className="filtro-lista">
                {valores === null && !errorValores && <div className="filtro-vacio">Cargando…</div>}
                {errorValores && <div className="filtro-vacio">No se pudieron cargar los valores.</div>}
                {valores !== null && visibles.length === 0 && <div className="filtro-vacio">Sin coincidencias.</div>}
                {visibles.map((v) => {
                  const color = campo.editor_tipo === "lista" ? (campo.opciones ?? []).find((o) => o.valor === v)?.color : undefined;
                  return (
                    <label key={v} className="filtro-check">
                      <input type="checkbox" checked={sel.includes(v)} onChange={() => alternar(v)} />
                      {color ? <Chip texto={v} color={color} /> : <span>{valorVisible(v, campo)}</span>}
                    </label>
                  );
                })}
              </div>
              {valores !== null && valores.length >= 200 && (
                <div className="filtro-nota">Se muestran 200 valores. Para más, usa la búsqueda de la tabla.</div>
              )}
            </>
          )}

          <div className="filtro-acciones">
            <button type="button" className="boton-secundario-claro" onClick={onCerrar}>
              Cancelar
            </button>
            <button
              type="button"
              className="boton-guardar"
              disabled={!puedeAplicar}
              onClick={() =>
                onAplicar({
                  columna: campo.nombre_tecnico,
                  valores: esFecha ? [] : sel,
                  desde: esFecha ? desde : "",
                  hasta: esFecha ? hasta : "",
                })
              }
            >
              Aplicar
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Los datos de la entidad de la sucursal. Los campos que captura la app son editables. */
export default function BaseDatos() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Borradores de texto mientras se escribe (se confirman al salir/Enter).
  const [borradores, setBorradores] = useState<Record<string, string>>({});
  // Notificación flotante (abajo a la izquierda) de guardado / error.
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const avisoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function mostrarAviso(tipo: "ok" | "error", texto: string) {
    setAviso({ tipo, texto });
    if (avisoTimer.current) clearTimeout(avisoTimer.current);
    avisoTimer.current = setTimeout(() => setAviso(null), tipo === "ok" ? 2200 : 4000);
  }

  // Búsqueda, filtros y orden: viven en el servidor (la tabla pagina de 200 en 200).
  const [busqueda, setBusqueda] = useState("");
  const [busquedaAplicada, setBusquedaAplicada] = useState("");
  const [filtros, setFiltros] = useState<FiltroUI[]>([]);
  const [orden, setOrden] = useState<Orden | null>(null);
  const [cargando, setCargando] = useState(false);
  const [panel, setPanel] = useState<{ abierto: boolean; editar: FiltroUI | null }>({ abierto: false, editar: null });
  // Descarta respuestas atrasadas si el usuario cambia de filtro antes de que llegue la anterior.
  const solicitud = useRef(0);

  // ---- Panel de filtrado configurable (búsquedas, desplegables, KPIs y botones rápidos) ----
  // null = todavía no se sabe si la sucursal tiene panel; la primera carga espera a saberlo
  // para que el filtro principal ya esté puesto y no se pida la tabla dos veces.
  const [itemsPanel, setItemsPanel] = useState<ItemPanel[] | null>(null);
  const [estadoP, setEstadoP] = useState<EstadoPanel>(() => estadoInicial([]));
  const [escritos, setEscritos] = useState<Record<string, string>>({});
  const [visibilidad, setVisibilidad] = useState<Visibilidad>(() => leerVisibilidad(sucursalId));
  const [menuVisibilidad, setMenuVisibilidad] = useState(false);
  const visibilidadRef = useRef<HTMLButtonElement>(null);

  // Vista: tabla o embudo (tablero por etapas). Se recuerda por sucursal.
  const [vista, setVista] = useState<"tabla" | "embudo">(() => {
    try {
      return localStorage.getItem(`portal.vista.${sucursalId}`) === "embudo" ? "embudo" : "tabla";
    } catch {
      return "tabla";
    }
  });
  const [refrescos, setRefrescos] = useState(0);
  function elegirVista(v: "tabla" | "embudo") {
    setVista(v);
    try {
      localStorage.setItem(`portal.vista.${sucursalId}`, v);
    } catch {
      // sin persistencia; no afecta el funcionamiento
    }
  }

  const hayPanel = (itemsPanel?.length ?? 0) > 0;
  const campos: CampoPanel[] = datos?.configurado ? datos.campos : [];

  function cargarPanel() {
    apiFetch<{ items: ItemPanel[] }>(`/api/admin/sucursales/${sucursalId}/entidad/registros/panel`)
      .then(({ items }) => {
        setItemsPanel(items);
        setEstadoP(estadoInicial(items));
        setEscritos({});
        setPagina(1);
      })
      .catch(() => {
        // Sin panel no se bloquea la tabla: cae a la barra de filtros genérica.
        setItemsPanel([]);
      });
  }

  useEffect(cargarPanel, [sucursalId]);

  /** Parámetros de consulta comunes a la tabla y a las opciones de cada desplegable. */
  function parametrosFiltro(excluirId?: string): URLSearchParams {
    const p = new URLSearchParams();
    const delPanel = aParametros(estadoP, itemsPanel ?? [], excluirId);
    const genericos = filtros.map((f) => ({
      c: f.columna,
      ...(f.valores.length ? { v: f.valores } : {}),
      ...(f.desde ? { d: f.desde } : {}),
      ...(f.hasta ? { h: f.hasta } : {}),
    }));
    const todos = [...genericos, ...delPanel.filtros];
    if (todos.length > 0) p.set("filtros", JSON.stringify(todos));
    for (const q of [busquedaAplicada, ...delPanel.q]) if (q) p.append("q", q);
    if (delPanel.botones.length > 0) p.set("botones", delPanel.botones.join(","));
    return p;
  }

  function cargar() {
    if (itemsPanel === null) return; // espera a conocer el panel
    const id = ++solicitud.current;
    setCargando(true);
    const p = parametrosFiltro();
    p.set("pagina", String(pagina));
    // En el embudo la tabla no se dibuja: solo hacen falta el total y los KPIs.
    p.set("limite", String(vista === "embudo" ? 1 : LIMITE));
    if (orden) {
      p.set("orden", orden.columna);
      p.set("dir", orden.dir);
    }
    apiFetch<Respuesta>(`/api/admin/sucursales/${sucursalId}/entidad/registros?${p.toString()}`)
      .then((d) => {
        if (id !== solicitud.current) return;
        setDatos(d);
        setError(null);
      })
      .catch((err) => {
        if (id !== solicitud.current) return;
        setError(err instanceof Error ? err.message : "No se pudo cargar la información.");
      })
      .finally(() => {
        if (id === solicitud.current) setCargando(false);
      });
  }

  useEffect(cargar, [sucursalId, pagina, busquedaAplicada, filtros, orden, estadoP, itemsPanel, vista]);

  // Búsquedas del panel con retardo: se aplican cuando el usuario deja de escribir.
  useEffect(() => {
    const t = setTimeout(() => {
      setEstadoP((prev) => {
        const mismas =
          Object.keys({ ...prev.busquedas, ...escritos }).every((k) => (prev.busquedas[k] ?? "") === (escritos[k] ?? "")) ;
        return mismas ? prev : { ...prev, busquedas: { ...escritos } };
      });
      setPagina(1);
    }, 350);
    return () => clearTimeout(t);
  }, [escritos]);

  useEffect(() => {
    try {
      localStorage.setItem(`portal.panel.visibilidad.${sucursalId}`, JSON.stringify(visibilidad));
    } catch {
      // sin persistencia; no afecta el funcionamiento
    }
  }, [visibilidad, sucursalId]);

  // Búsqueda con retardo: espera a que el usuario deje de escribir.
  useEffect(() => {
    const t = setTimeout(() => {
      const limpio = busqueda.trim();
      if (limpio !== busquedaAplicada) {
        setBusquedaAplicada(limpio);
        setPagina(1);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda]);

  // Tiempo real: si otra persona edita la tabla, se refresca en vivo con los mismos filtros.
  const cargarRef = useRef(cargar);
  cargarRef.current = cargar;
  const cargarPanelRef = useRef(cargarPanel);
  cargarPanelRef.current = cargarPanel;
  useEffect(() => {
    const canal = supabase
      .channel(`datos:${sucursalId}`)
      .on("broadcast", { event: "refresh" }, () => {
        cargarRef.current();
        setRefrescos((n) => n + 1);
      })
      // El admin cambió la configuración del panel: se recarga sin refrescar la página.
      .on("broadcast", { event: "panel" }, () => cargarPanelRef.current())
      .subscribe();
    return () => {
      void supabase.removeChannel(canal);
    };
  }, [sucursalId]);

  function aplicarFiltro(f: FiltroUI) {
    setFiltros((prev) => [...prev.filter((x) => x.columna !== f.columna), f]);
    setPagina(1);
    setPanel({ abierto: false, editar: null });
  }

  function quitarFiltro(columna: string) {
    setFiltros((prev) => prev.filter((x) => x.columna !== columna));
    setPagina(1);
  }

  /** Quita filtros, búsqueda y orden, y deja el panel como al abrirlo: solo con el filtro principal. */
  function limpiarTodo() {
    setFiltros([]);
    setOrden(null);
    setBusqueda("");
    setBusquedaAplicada("");
    setEstadoP(estadoInicial(itemsPanel ?? []));
    setEscritos({});
    setPagina(1);
  }

  // ---- Acciones del panel ----
  const itemsActuales = itemsPanel ?? [];

  function alPulsarBoton(id: string) {
    setEstadoP((prev) => alternarBoton(prev, itemsActuales, campos, id));
    setPagina(1);
  }
  function alElegir(id: string, valores: string[]) {
    setEstadoP((prev) => cambiarSeleccion(prev, id, valores));
    setPagina(1);
  }
  function alAplicarFecha(id: string, desde: string, hasta: string) {
    setEstadoP((prev) => aplicarFecha(prev, itemsActuales, campos, id, desde, hasta));
    setPagina(1);
  }
  function alLimpiarFecha(id: string) {
    setEstadoP((prev) => limpiarFecha(prev, id));
    setPagina(1);
  }

  /** Opciones de un desplegable: lo que dejan pasar los demás filtros (no el suyo). */
  async function cargarValores(item: ItemPanel): Promise<string[]> {
    const p = parametrosFiltro(item.id);
    p.set("columna", item.columna ?? "");
    const r = await apiFetch<{ valores: string[] }>(
      `/api/admin/sucursales/${sucursalId}/entidad/registros/valores?${p.toString()}`,
    );
    return r.valores;
  }

  const kpis: Record<string, ValorKpi> = Object.fromEntries(
    (datos?.configurado ? (datos.kpis ?? []) : []).map((k) => [k.id, { valor: k.valor, error: k.error }]),
  );

  /** Orden por columna: ascendente, luego descendente, luego sin orden. */
  function alternarOrden(columna: string) {
    setOrden((prev) =>
      !prev || prev.columna !== columna
        ? { columna, dir: "asc" }
        : prev.dir === "asc"
          ? { columna, dir: "desc" }
          : null,
    );
    setPagina(1);
  }

  const hayCriterios =
    filtros.length > 0 || busquedaAplicada !== "" || orden !== null || (hayPanel && hayFiltrosActivos(estadoP));

  const clave = (rowId: string, campo: string) => `${rowId}::${campo}`;

  /** Guarda un solo campo al instante (estilo hoja de cálculo). Optimista. */
  async function guardarCampo(rowId: string, campo: string, valor: string, valorPrevio: string) {
    if (valor === valorPrevio) return;
    // Optimista: refleja ya en la tabla y avisa al instante.
    setDatos((prev) => {
      if (!prev || !prev.configurado) return prev;
      return { ...prev, filas: prev.filas.map((f) => (String(f.id) === rowId ? { ...f, [campo]: valor } : f)) };
    });
    mostrarAviso("ok", "Cambio guardado");
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/entidad/registros/${rowId}`, {
        method: "PATCH",
        body: JSON.stringify({ [campo]: valor }),
      });
    } catch (err) {
      // Revertir si falla.
      setDatos((prev) => {
        if (!prev || !prev.configurado) return prev;
        return { ...prev, filas: prev.filas.map((f) => (String(f.id) === rowId ? { ...f, [campo]: valorPrevio } : f)) };
      });
      mostrarAviso("error", err instanceof Error ? err.message : "Error de red: no se guardó el cambio.");
    }
  }

  function valorOriginal(fila: Fila, campo: CampoServidor): string {
    const original = fila[campo.nombre_tecnico];
    if (campo.tipo === "fecha") return aValorFecha(original);
    return original === null || original === undefined ? "" : String(original);
  }

  function celdaEditable(fila: Fila, campo: CampoServidor) {
    const id = String(fila.id);
    const original = valorOriginal(fila, campo);

    if (campo.tipo === "fecha") {
      return (
        <input
          type="date"
          className="celda-editar"
          value={original}
          min="2000-01-01"
          max={HOY}
          onChange={(e) => guardarCampo(id, campo.nombre_tecnico, e.target.value, original)}
        />
      );
    }
    if (campo.tipo === "texto" && campo.editor_tipo === "lista") {
      return (
        <SelectEtiqueta
          valor={original}
          opciones={campo.opciones ?? []}
          onChange={(v) => guardarCampo(id, campo.nombre_tecnico, v, original)}
        />
      );
    }
    // Texto libre: borrador mientras escribe; se guarda al salir o con Enter.
    const k = clave(id, campo.nombre_tecnico);
    const enEdicion = borradores[k] !== undefined ? borradores[k] : original;
    const confirmar = () => {
      setBorradores((prev) => {
        const copia = { ...prev };
        delete copia[k];
        return copia;
      });
      guardarCampo(id, campo.nombre_tecnico, enEdicion, original);
    };
    return (
      <input
        type="text"
        className="celda-editar"
        value={enEdicion}
        onChange={(e) => setBorradores((prev) => ({ ...prev, [k]: e.target.value }))}
        onBlur={confirmar}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setBorradores((prev) => {
              const copia = { ...prev };
              delete copia[k];
              return copia;
            });
            e.currentTarget.blur();
          }
        }}
      />
    );
  }

  const selectorVista = datos?.configurado && datos.embudo ? (
    <div className="vista-selector" role="group" aria-label="Vista">
      <button
        type="button"
        className={`vista-opcion${vista === "tabla" ? " vista-opcion-activa" : ""}`}
        aria-pressed={vista === "tabla"}
        onClick={() => elegirVista("tabla")}
      >
        <IconoVistaTabla className="icono-inline" />
        Tabla
      </button>
      <button
        type="button"
        className={`vista-opcion${vista === "embudo" ? " vista-opcion-activa" : ""}`}
        aria-pressed={vista === "embudo"}
        onClick={() => elegirVista("embudo")}
      >
        <IconoVistaEmbudo className="icono-inline" />
        Embudo
      </button>
    </div>
  ) : null;

  const enTabla = vista === "tabla" || !(datos?.configurado && datos.embudo);

  return (
    <div className="pagina-formulario">
      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {!datos && !error && <Cargador />}

      {datos && !datos.configurado && (
        <div className="marcador">
          <strong>Todavía no hay una base de datos para tu sucursal</strong>
          <span>Cuando el administrador de la plataforma la dé de alta, aparecerá aquí.</span>
        </div>
      )}

      {/* Panel de filtrado configurado por el admin: filtros, KPIs y botones rápidos. */}
      {datos?.configurado && hayPanel && (
        <>
          <PanelFiltros
            items={itemsActuales}
            campos={campos}
            estado={estadoP}
            escritos={escritos}
            kpis={kpis}
            visibilidad={visibilidad}
            onEscribir={(id, texto) => setEscritos((prev) => ({ ...prev, [id]: texto }))}
            onSeleccion={alElegir}
            onAplicarFecha={alAplicarFecha}
            onLimpiarFecha={alLimpiarFecha}
            onBoton={alPulsarBoton}
            cargarValores={cargarValores}
          />

          <div className="pf-barra">
            <span className="pf-conteo">
              <strong>{datos.total.toLocaleString("es-MX")}</strong> {datos.total === 1 ? "registro" : "registros"}
            </span>
            <div className="pf-acciones">
              {selectorVista}
              {enTabla && orden && (
                <button type="button" className="boton-secundario-claro pf-accion" onClick={() => setOrden(null)}>
                  <IconoXMarca className="icono-inline" />
                  Quitar orden
                </button>
              )}
              <button type="button" className="boton-secundario-claro pf-accion" onClick={limpiarTodo}>
                <IconoXMarca className="icono-inline" />
                Limpiar todo
              </button>
              <button
                ref={visibilidadRef}
                type="button"
                className="boton-secundario-claro pf-accion"
                onClick={() => setMenuVisibilidad((v) => !v)}
              >
                Visibilidad
                <IconoChevron className="icono-inline" />
              </button>
              {menuVisibilidad && (
                <Flotante ancla={visibilidadRef} onCerrar={() => setMenuVisibilidad(false)} anchoMinimo={300} className="pf-visibilidad">
                  <div className="pf-visibilidad-titulo">Visibilidad</div>
                  <div className="pf-visibilidad-ayuda">Muestra u oculta bloques del panel.</div>
                  {SECCIONES.map((s) => (
                    <label key={s.clave} className="pf-visibilidad-fila">
                      <span>
                        <strong>{s.titulo}</strong>
                        <small>{s.descripcion}</small>
                      </span>
                      <span className="pf-interruptor">
                        <input
                          type="checkbox"
                          checked={visibilidad[s.clave]}
                          onChange={(e) => setVisibilidad((v) => ({ ...v, [s.clave]: e.target.checked }))}
                        />
                        <span />
                      </span>
                    </label>
                  ))}
                </Flotante>
              )}
            </div>
          </div>
        </>
      )}

      {/* Barra genérica (búsqueda y filtros por columna): solo si la sucursal no tiene panel. */}
      {datos?.configurado && itemsPanel !== null && !hayPanel && (
        <div className="tabla-barra">
          {selectorVista}
          <label className="tabla-buscar">
            <IconoBuscar className="icono-inline" />
            <input
              type="text"
              placeholder="Buscar en la tabla…"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
            {busqueda && (
              <button type="button" className="tabla-buscar-limpiar" aria-label="Borrar búsqueda" onClick={() => setBusqueda("")}>
                <IconoXMarca className="icono-inline" />
              </button>
            )}
          </label>

          <div className="filtro-ancla">
            <button
              type="button"
              className="boton-secundario-claro boton-con-icono"
              onClick={() => setPanel((p) => ({ abierto: !p.abierto || p.editar !== null, editar: null }))}
            >
              <IconoFiltro className="icono-inline" />
              Filtros{filtros.length > 0 ? ` (${filtros.length})` : ""}
            </button>
            {panel.abierto && (
              <PanelFiltro
                key={panel.editar?.columna ?? "nuevo"}
                sucursalId={sucursalId}
                campos={datos.campos}
                inicial={panel.editar}
                yaFiltradas={filtros.map((f) => f.columna)}
                onAplicar={aplicarFiltro}
                onCerrar={() => setPanel({ abierto: false, editar: null })}
              />
            )}
          </div>

          {filtros.map((f) => {
            const campo = datos.campos.find((c) => c.nombre_tecnico === f.columna);
            if (!campo) return null;
            return (
              <span key={f.columna} className="filtro-pill">
                <button
                  type="button"
                  className="filtro-pill-texto"
                  onClick={() => setPanel({ abierto: true, editar: f })}
                >
                  <strong>{campo.nombre_visible}:</strong> {resumenFiltro(campo, f)}
                </button>
                <button type="button" className="filtro-pill-quitar" aria-label={`Quitar filtro de ${campo.nombre_visible}`} onClick={() => quitarFiltro(f.columna)}>
                  <IconoXMarca className="icono-inline" />
                </button>
              </span>
            );
          })}

          {hayCriterios && (
            <button type="button" className="boton-tenue" onClick={limpiarTodo}>
              Limpiar
            </button>
          )}
        </div>
      )}

      {datos?.configurado && enTabla && datos.filas.length === 0 && (
        <div className="marcador">
          {hayCriterios ? (
            <>
              <strong>Sin resultados</strong>
              <span>Ningún registro coincide con la búsqueda o los filtros aplicados.</span>
              <button type="button" className="boton-secundario-claro" onClick={limpiarTodo}>
                Limpiar filtros
              </button>
            </>
          ) : (
            <>
              <strong>{datos.nombre_visible}</strong>
              <span>Todavía no hay registros.</span>
            </>
          )}
        </div>
      )}

      {datos?.configurado && !enTabla && (
        <Embudo
          sucursalId={sucursalId}
          parametros={parametrosFiltro}
          version={`${parametrosFiltro().toString()}|${refrescos}`}
          onAviso={mostrarAviso}
        />
      )}

      {datos?.configurado && enTabla && datos.filas.length > 0 && (
        <>
          <div className={`tabla-envoltura${cargando ? " tabla-cargando" : ""}`}>
            <table className="tabla">
              <thead>
                <tr>
                  {datos.campos.map((c) => {
                    const ordenada = orden?.columna === c.nombre_tecnico ? orden.dir : null;
                    return (
                      <th
                        key={c.nombre_tecnico}
                        className={c.origen === "back" ? "col-editable" : undefined}
                        aria-sort={ordenada === "asc" ? "ascending" : ordenada === "desc" ? "descending" : "none"}
                      >
                        <button type="button" className="th-orden" onClick={() => alternarOrden(c.nombre_tecnico)}>
                          {c.nombre_visible}
                          <IconoChevron className={`th-flecha${ordenada ? ` th-flecha-${ordenada}` : ""}`} />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {datos.filas.map((fila) => {
                  const id = String(fila.id);
                  return (
                    <tr key={id}>
                      {datos.campos.map((c) => (
                        <td key={c.nombre_tecnico} className={c.origen === "back" ? "col-editable" : undefined}>
                          {c.origen === "back"
                            ? celdaEditable(fila, c)
                            : c.tipo === "texto" && c.editor_tipo === "lista"
                              ? (() => {
                                  const v = fila[c.nombre_tecnico];
                                  const color = (c.opciones ?? []).find((o) => o.valor === v)?.color;
                                  return v && color ? <Chip texto={String(v)} color={color} /> : formatearValor(v, c.tipo);
                                })()
                              : formatearValor(fila[c.nombre_tecnico], c.tipo)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <footer className="barra-acciones">
            <p>
              {(datos.pagina - 1) * datos.limite + 1}–{Math.min(datos.pagina * datos.limite, datos.total)} de {datos.total}
            </p>
            <div className="pagina-acciones">
              <button
                type="button"
                className="boton-secundario-claro"
                disabled={pagina <= 1}
                onClick={() => setPagina((p) => p - 1)}
              >
                Anterior
              </button>
              <button
                type="button"
                className="boton-secundario-claro"
                disabled={datos.pagina * datos.limite >= datos.total}
                onClick={() => setPagina((p) => p + 1)}
              >
                Siguiente
              </button>
            </div>
          </footer>
        </>
      )}

      {aviso && (
        <div className={`aviso-flotante aviso-flotante-${aviso.tipo}`} role="status">
          {aviso.texto}
        </div>
      )}
    </div>
  );
}
