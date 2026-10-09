import { useRef, useState, type CSSProperties } from "react";
import Flotante from "../componentes/Flotante";
import { IconoBuscar, IconoCalendario, IconoChevron } from "../componentes/Iconos";
import { COLOR_KPI_POR_DEFECTO, esCampoFecha, type CampoPanel, type ItemPanel } from "../lib/panel";
import type { EstadoPanel } from "./estadoPanel";

export type ValorKpi = { valor: number | null; error?: string };
export type Visibilidad = { filtros: boolean; insights: boolean; rapidos: boolean };

/** Los booleanos llegan como 'true'/'false' desde la base. */
function textoValor(valor: string, campo: CampoPanel | undefined): string {
  if (campo?.tipo === "booleano") return valor === "true" ? "Sí" : valor === "false" ? "No" : valor;
  return valor;
}

/** 'YYYY-MM-DD' → 'dd/mm/aaaa'. */
function fechaTexto(iso: string): string {
  const [a, m, d] = iso.split("-");
  return a && m && d ? `${d}/${m}/${a}` : iso;
}

function resumenSeleccion(seleccion: string[], campo: CampoPanel | undefined): string {
  if (seleccion.length === 0) return "Todos";
  if (seleccion.length === 1) return textoValor(seleccion[0], campo);
  return `${seleccion.length} seleccionados`;
}

/* ------------------------------------------------------------------ */
/* Desplegable de valores (simple o de selección múltiple)             */
/* ------------------------------------------------------------------ */
function CampoDesplegable({
  item,
  campo,
  seleccion,
  soloVista,
  cargarValores,
  onSeleccion,
}: {
  item: ItemPanel;
  campo: CampoPanel | undefined;
  seleccion: string[];
  soloVista: boolean;
  cargarValores: (item: ItemPanel) => Promise<string[]>;
  onSeleccion: (valores: string[]) => void;
}) {
  const anclaRef = useRef<HTMLButtonElement>(null);
  const [abierto, setAbierto] = useState(false);
  const [valores, setValores] = useState<string[] | null>(null);
  const [error, setError] = useState(false);

  function alternar() {
    if (soloVista) return;
    if (abierto) {
      setAbierto(false);
      return;
    }
    // Las opciones se piden al abrir: salen de lo que dejan pasar los otros filtros.
    setValores(null);
    setError(false);
    setAbierto(true);
    cargarValores(item)
      .then(setValores)
      .catch(() => setError(true));
  }

  function elegir(v: string) {
    if (item.multiple) {
      onSeleccion(seleccion.includes(v) ? seleccion.filter((x) => x !== v) : [...seleccion, v]);
    } else {
      onSeleccion([v]);
      setAbierto(false);
    }
  }

  return (
    <>
      <button
        ref={anclaRef}
        type="button"
        className={`pf-caja pf-selector${abierto ? " pf-caja-abierta" : ""}${seleccion.length > 0 ? " pf-caja-activa" : ""}`}
        disabled={soloVista}
        onClick={alternar}
      >
        <span>{resumenSeleccion(seleccion, campo)}</span>
        <IconoChevron className="pf-flecha" />
      </button>

      {abierto && (
        <Flotante ancla={anclaRef} onCerrar={() => setAbierto(false)} anchoMinimo={200}>
          {item.multiple ? (
            <button type="button" className="pf-limpiar-seleccion" onClick={() => onSeleccion([])}>
              Limpiar selección
            </button>
          ) : (
            <button
              type="button"
              className={`pf-opcion${seleccion.length === 0 ? " pf-opcion-activa" : ""}`}
              onClick={() => {
                onSeleccion([]);
                setAbierto(false);
              }}
            >
              Todos
            </button>
          )}
          {valores === null && !error && <div className="pf-vacio">Cargando…</div>}
          {error && <div className="pf-vacio">No se pudieron cargar los valores.</div>}
          {valores !== null && valores.length === 0 && <div className="pf-vacio">Sin valores.</div>}
          {valores?.map((v) =>
            item.multiple ? (
              <label key={v} className="pf-opcion pf-opcion-check">
                <input type="checkbox" checked={seleccion.includes(v)} onChange={() => elegir(v)} />
                <span>{textoValor(v, campo)}</span>
              </label>
            ) : (
              <button
                key={v}
                type="button"
                className={`pf-opcion${seleccion[0] === v ? " pf-opcion-activa" : ""}`}
                onClick={() => elegir(v)}
              >
                {textoValor(v, campo)}
              </button>
            ),
          )}
        </Flotante>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Rango de fechas con calendario                                      */
/* ------------------------------------------------------------------ */
function CampoFecha({
  rango,
  soloVista,
  onAplicar,
  onLimpiar,
}: {
  rango: { desde: string; hasta: string } | undefined;
  soloVista: boolean;
  onAplicar: (desde: string, hasta: string) => void;
  onLimpiar: () => void;
}) {
  const anclaRef = useRef<HTMLButtonElement>(null);
  const [abierto, setAbierto] = useState(false);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");

  function abrir() {
    if (soloVista) return;
    if (abierto) {
      setAbierto(false);
      return;
    }
    setDesde(rango?.desde ?? "");
    setHasta(rango?.hasta ?? "");
    setAbierto(true);
  }

  const texto = rango ? `${fechaTexto(rango.desde)} - ${fechaTexto(rango.hasta)}` : "";

  return (
    <>
      <button
        ref={anclaRef}
        type="button"
        className={`pf-caja pf-selector${abierto ? " pf-caja-abierta" : ""}${texto ? " pf-caja-activa" : ""}`}
        disabled={soloVista}
        onClick={abrir}
      >
        <span className={texto ? undefined : "pf-selector-vacio"}>{texto || "Cualquiera"}</span>
        <IconoCalendario className="pf-icono-fecha" />
      </button>

      {abierto && (
        <Flotante ancla={anclaRef} onCerrar={() => setAbierto(false)} anchoMinimo={260}>
          <div className="pf-fechas">
            <label>
              <span>Desde</span>
              <input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} />
            </label>
            <label>
              <span>Hasta</span>
              <input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} />
            </label>
            <div className="pf-fechas-acciones">
              <button
                type="button"
                className="boton-secundario-claro"
                onClick={() => {
                  onLimpiar();
                  setAbierto(false);
                }}
              >
                Limpiar
              </button>
              <button
                type="button"
                className="boton-guardar"
                disabled={!desde}
                onClick={() => {
                  onAplicar(desde, hasta);
                  setAbierto(false);
                }}
              >
                Aplicar
              </button>
            </div>
          </div>
        </Flotante>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Panel completo: Filtros · Insights (KPIs) · Filtros rápidos         */
/* ------------------------------------------------------------------ */
export default function PanelFiltros({
  items,
  campos,
  estado,
  escritos,
  kpis,
  visibilidad,
  soloVista = false,
  onEscribir,
  onSeleccion,
  onAplicarFecha,
  onLimpiarFecha,
  onBoton,
  cargarValores,
}: {
  items: ItemPanel[];
  campos: CampoPanel[];
  estado: EstadoPanel;
  escritos: Record<string, string>;
  kpis: Record<string, ValorKpi>;
  visibilidad: Visibilidad;
  soloVista?: boolean;
  onEscribir: (id: string, texto: string) => void;
  onSeleccion: (id: string, valores: string[]) => void;
  onAplicarFecha: (id: string, desde: string, hasta: string) => void;
  onLimpiarFecha: (id: string) => void;
  onBoton: (id: string) => void;
  cargarValores: (item: ItemPanel) => Promise<string[]>;
}) {
  const filtros = items.filter((i) => i.tipo === "busqueda" || i.tipo === "desplegable");
  const indicadores = items.filter((i) => i.tipo === "kpi");
  const botones = items.filter((i) => i.tipo === "boton");
  const span = (n: number): CSSProperties => ({ gridColumn: `span ${Math.min(Math.max(n, 1), 4)}` });

  return (
    <div className="panel-filtros">
      {visibilidad.filtros && filtros.length > 0 && (
        <div className="pf-filtros">
          {filtros.map((item) => {
            const campo = campos.find((c) => c.nombre_tecnico === item.columna);
            return (
              <div key={item.id} className={`pf-item${item.tipo === "busqueda" ? " pf-item-busqueda" : ""}`} style={span(item.ancho)}>
                <span className="pf-etiqueta">{item.etiqueta}</span>
                {item.tipo === "busqueda" ? (
                  <label className="pf-caja pf-busqueda">
                    <IconoBuscar className="pf-icono-busqueda" />
                    <input
                      type="text"
                      value={escritos[item.id] ?? ""}
                      disabled={soloVista}
                      onChange={(e) => onEscribir(item.id, e.target.value)}
                      placeholder="Buscar en la tabla"
                    />
                  </label>
                ) : esCampoFecha(campo) ? (
                  <CampoFecha
                    rango={estado.fechas[item.id]}
                    soloVista={soloVista}
                    onAplicar={(d, h) => onAplicarFecha(item.id, d, h)}
                    onLimpiar={() => onLimpiarFecha(item.id)}
                  />
                ) : (
                  <CampoDesplegable
                    item={item}
                    campo={campo}
                    seleccion={estado.seleccion[item.id] ?? []}
                    soloVista={soloVista}
                    cargarValores={cargarValores}
                    onSeleccion={(v) => onSeleccion(item.id, v)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {visibilidad.insights && indicadores.length > 0 && (
        <div className="pf-kpis">
          {indicadores.map((item) => {
            const k = kpis[item.id];
            return (
              <div
                key={item.id}
                className="pf-kpi"
                style={{ ["--kpi" as string]: item.color ?? COLOR_KPI_POR_DEFECTO } as CSSProperties}
                title={k?.error}
              >
                <span className="pf-kpi-etiqueta">
                  <span className="pf-punto" />
                  {item.etiqueta}
                </span>
                <strong className="pf-kpi-valor">{k && k.valor !== null ? k.valor.toLocaleString("es-MX") : "—"}</strong>
              </div>
            );
          })}
        </div>
      )}

      {visibilidad.rapidos && botones.length > 0 && (
        <div className="pf-botones" role="group" aria-label="Filtros rápidos">
          {botones.map((item) => {
            const activo = estado.botones.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`pf-boton${activo ? " pf-boton-activo" : ""}`}
                aria-pressed={activo}
                disabled={soloVista}
                onClick={() => onBoton(item.id)}
              >
                {item.etiqueta}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
