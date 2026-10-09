import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import Cargador from "../componentes/Cargador";
import { IconoChat, IconoLlamada } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { colorCampo, iniciales, textoCampo, type CampoValor, type VistaTarjeta } from "../lib/vistaTarjeta";

type Tarjeta = Record<string, unknown> & { id: string };
type Columna = {
  id: string;
  nombre: string;
  color: string;
  tipo: "abierta" | "ganada" | "perdida";
  tiempo_max_horas: number | null;
  fuera_sla: number;
  total: number;
  tarjetas: Tarjeta[];
};
type CampoTarjeta = CampoValor & { nombre_tecnico: string; nombre_visible: string };
type Respuesta =
  | { configurado: false }
  | { configurado: true; campos: CampoTarjeta[]; etapas: Columna[]; motivos: string[]; limite: number; vista: VistaTarjeta };
type UltimoMensaje = { texto: string | null; tipo: string; creado_en: string } | null;

type Props = {
  sucursalId: string;
  /** Filtros, búsqueda y botones activos de la tabla: el embudo los comparte. */
  parametros: () => URLSearchParams;
  /** Cambia cuando los filtros o los datos cambian (incluye el tiempo real). */
  version: string;
  onAviso: (tipo: "ok" | "error", texto: string) => void;
  /** Abre la ficha de una oportunidad (clic en su tarjeta). */
  onAbrir: (id: string) => void;
};

const POR_PAGINA = 30;

type Movimiento = { origen: DropResult["source"]; destino: NonNullable<DropResult["destination"]>; id: string };

/**
 * Embudo: una columna por etapa, tarjetas arrastrables entre ellas. Mover una tarjeta
 * cambia su etapa en el servidor (con historial); la vista se actualiza al instante y
 * vuelve a como estaba si el servidor lo rechaza.
 */
export default function Embudo({ sucursalId, parametros, version, onAviso, onAbrir }: Props) {
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState<string | null>(null);
  const [pendientePerdido, setPendientePerdido] = useState<Movimiento | null>(null);
  const [motivo, setMotivo] = useState("");
  const solicitud = useRef(0);
  const datosRef = useRef(datos);
  datosRef.current = datos;

  const base = `/api/admin/sucursales/${sucursalId}/entidad/registros`;

  const cargar = useCallback(() => {
    const id = ++solicitud.current;
    const p = parametros();
    // Conserva lo ya desplegado con "Ver más": el refresco no lo vuelve a encoger.
    const actual = datosRef.current;
    const cargadas = actual && actual.configurado ? Math.max(POR_PAGINA, ...actual.etapas.map((e) => e.tarjetas.length)) : POR_PAGINA;
    p.set("limite", String(cargadas));
    apiFetch<Respuesta>(`${base}/embudo?${p.toString()}`)
      .then((d) => {
        if (id !== solicitud.current) return;
        setDatos(d);
        setError(null);
      })
      .catch((err) => {
        if (id !== solicitud.current) return;
        setError(err instanceof Error ? err.message : "No se pudo cargar el embudo.");
      });
    // `parametros` cambia en cada render; `version` es la señal explícita de recarga.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, version]);

  useEffect(cargar, [cargar]);

  async function verMas(columna: Columna) {
    setCargandoMas(columna.id);
    try {
      const p = parametros();
      p.set("etapa", columna.id);
      p.set("desplazamiento", String(columna.tarjetas.length));
      p.set("limite", String(POR_PAGINA));
      const r = await apiFetch<Respuesta>(`${base}/embudo?${p.toString()}`);
      if (!r.configurado) return;
      const nuevas = r.etapas[0]?.tarjetas ?? [];
      setDatos((prev) =>
        prev && prev.configurado
          ? {
              ...prev,
              etapas: prev.etapas.map((e) =>
                e.id === columna.id
                  ? {
                      ...e,
                      total: r.etapas[0]?.total ?? e.total,
                      tarjetas: [...e.tarjetas, ...nuevas.filter((n) => !e.tarjetas.some((t) => t.id === n.id))],
                    }
                  : e,
              ),
            }
          : prev,
      );
    } catch (err) {
      onAviso("error", err instanceof Error ? err.message : "No se pudieron cargar más tarjetas.");
    } finally {
      setCargandoMas(null);
    }
  }

  /** Aplica el movimiento en la vista y lo manda al servidor; si falla, vuelve a pedir lo real. */
  async function mover({ origen, destino, id }: Movimiento, motivoPerdida: string | null) {
    const actual = datosRef.current;
    if (!actual || !actual.configurado) return;

    const etapas = actual.etapas.map((e) => ({ ...e, tarjetas: [...e.tarjetas] }));
    const desde = etapas.find((e) => e.id === origen.droppableId);
    const hacia = etapas.find((e) => e.id === destino.droppableId);
    if (!desde || !hacia) return;
    const [tarjeta] = desde.tarjetas.splice(origen.index, 1);
    if (!tarjeta) return;
    const cambioEtapa = desde.id !== hacia.id;
    const antes = hacia.tarjetas[destino.index] ?? null; // la tarjeta que queda detrás de la movida
    hacia.tarjetas.splice(destino.index, 0, {
      ...tarjeta,
      ...(cambioEtapa
        ? { entro_a_etapa_en: new Date().toISOString(), motivo_perdida: hacia.tipo === "perdida" ? motivoPerdida : null }
        : {}),
    });
    if (cambioEtapa) {
      desde.total -= 1;
      hacia.total += 1;
    }
    setDatos({ ...actual, etapas });

    try {
      await apiFetch(`${base}/${id}/mover`, {
        method: "POST",
        body: JSON.stringify({ etapa_id: hacia.id, antes_id: antes?.id ?? null, motivo_perdida: motivoPerdida }),
      });
      onAviso("ok", cambioEtapa ? `Movido a ${hacia.nombre}` : "Orden guardado");
    } catch (err) {
      onAviso("error", err instanceof Error ? err.message : "Error de red: no se movió la tarjeta.");
      cargar();
    }
  }

  function alSoltar(r: DropResult) {
    const { source, destination } = r;
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    const actual = datosRef.current;
    if (!actual || !actual.configurado) return;
    const movimiento: Movimiento = { origen: source, destino: destination, id: r.draggableId };
    const destinoEtapa = actual.etapas.find((e) => e.id === destination.droppableId);
    const cambia = destination.droppableId !== source.droppableId;
    // Perder una oportunidad pide el motivo antes de moverla; la tarjeta no se toca hasta confirmar.
    if (cambia && destinoEtapa?.tipo === "perdida" && actual.motivos.length > 0) {
      setMotivo(actual.motivos[0]);
      setPendientePerdido(movimiento);
      return;
    }
    void mover(movimiento, null);
  }

  if (error) return <p className="embudo-vacio">{error}</p>;
  if (!datos) return <Cargador />;
  if (!datos.configurado) return <p className="embudo-vacio">Esta sucursal todavía no tiene un embudo.</p>;

  const vista = datos.vista;
  const campoDe = (n: string | null) => (n ? datos.campos.find((c) => c.nombre_tecnico === n) : undefined);

  return (
    <>
      <DragDropContext onDragEnd={alSoltar}>
        <div className="embudo">
          {datos.etapas.map((col) => (
            <section key={col.id} className="embudo-col" style={{ "--etapa": col.color } as CSSProperties}>
              <header className="embudo-col-cab">
                <span className="embudo-col-nombre">
                  <span className="embudo-col-punto" />
                  {col.nombre}
                </span>
                {col.fuera_sla > 0 && (
                  <span className="embudo-col-sla" title={`Llevan más de ${col.tiempo_max_horas} h en este estado`}>
                    {col.fuera_sla} fuera de SLA
                  </span>
                )}
                <span className="embudo-col-total">{col.total.toLocaleString("es-MX")}</span>
              </header>
              <Droppable droppableId={col.id}>
                {(prov, snap) => (
                  <div
                    ref={prov.innerRef}
                    {...prov.droppableProps}
                    className={`embudo-lista${snap.isDraggingOver ? " embudo-lista-sobre" : ""}`}
                  >
                    {col.tarjetas.map((t, i) => {
                      const tarde =
                        col.tipo === "abierta" &&
                        col.tiempo_max_horas !== null &&
                        !!t.entro_a_etapa_en &&
                        Date.now() - new Date(String(t.entro_a_etapa_en)).getTime() > col.tiempo_max_horas * 3600000;
                      const lugar = (n: string | null) => (n ? textoCampo(t[n], campoDe(n)) : null);
                      const arriba = [lugar(vista.arriba), lugar(vista.arriba_extra)].filter(Boolean).join(", ");
                      const esquina = lugar(vista.esquina);
                      const subtitulo = lugar(vista.subtitulo);
                      const titulo = lugar(vista.titulo);
                      const detalle = lugar(vista.detalle);
                      const pie = lugar(vista.pie);
                      const pendientes = Number(t.tareas_pendientes) || 0;
                      const vencidas = Number(t.tareas_vencidas) || 0;
                      const digitos = String(t.telefono_principal ?? "").replace(/[^\d+]/g, "");
                      const telefono = vista.llamar && digitos.replace(/\D/g, "").length >= 10 ? digitos : null;
                      const mensaje = t.ultimo_mensaje as UltimoMensaje | undefined;
                      return (
                      <Draggable key={t.id} draggableId={t.id} index={i}>
                        {(p, s) => (
                          <article
                            ref={p.innerRef}
                            {...p.draggableProps}
                            {...p.dragHandleProps}
                            className={`embudo-tarjeta${s.isDragging ? " embudo-tarjeta-arrastrando" : ""}${tarde ? " embudo-tarjeta-tarde" : ""}`}
                            onClick={() => onAbrir(t.id)}
                          >
                            {vista.avatar && <span className="embudo-avatar">{iniciales(vista.titulo ? t[vista.titulo] : null)}</span>}
                            <div className="embudo-tarjeta-cuerpo">
                              {(arriba || esquina) && (
                                <div className="embudo-tarjeta-fila">
                                  <span className="embudo-tarjeta-arriba">{arriba}</span>
                                  {esquina && <span className="embudo-tarjeta-esquina">{esquina}</span>}
                                </div>
                              )}
                              {subtitulo && <span className="embudo-tarjeta-linea">{subtitulo}</span>}
                              <strong className="embudo-tarjeta-titulo">{titulo ?? "Sin nombre"}</strong>
                              {detalle && <span className="embudo-tarjeta-linea">{detalle}</span>}
                              <div className="embudo-tarjeta-etiquetas">
                                  {vista.etiquetas.map((e) => {
                                    const texto = textoCampo(t[e], campoDe(e));
                                    if (!texto) return null;
                                    const color = colorCampo(t[e], campoDe(e));
                                    return (
                                      <span
                                        key={e}
                                        className={`embudo-mini${color ? " embudo-mini-color" : ""}`}
                                        style={color ? ({ "--chip": color } as CSSProperties) : undefined}
                                      >
                                        {texto}
                                      </span>
                                    );
                                  })}
                                  {col.tipo === "perdida" && t.motivo_perdida ? (
                                    <span className="embudo-mini embudo-mini-perdida">{String(t.motivo_perdida)}</span>
                                  ) : null}
                                  {tarde && <span className="embudo-mini embudo-mini-perdida">Fuera de tiempo</span>}
                              </div>
                              {(pie || vista.tareas || telefono) && (
                              <div className="embudo-tarjeta-pie">
                                <span className="embudo-tarjeta-responsable">{pie}</span>
                                {(vista.tareas || telefono) && (
                                  <span className="embudo-tarjeta-acciones">
                                    {vista.tareas && (
                                      <span
                                        className={`embudo-tareas${vencidas > 0 ? " embudo-tareas-vencidas" : pendientes > 0 ? " embudo-tareas-pendientes" : ""}`}
                                        title={pendientes > 0 ? `${pendientes} ${pendientes === 1 ? "tarea pendiente" : "tareas pendientes"}` : "Sin tareas pendientes"}
                                      >
                                        {vencidas > 0
                                          ? `${vencidas} vencida${vencidas === 1 ? "" : "s"}`
                                          : pendientes > 0
                                            ? `${pendientes} ${pendientes === 1 ? "tarea" : "tareas"}`
                                            : ""}
                                      </span>
                                    )}
                                    {telefono && (
                                      <a className="embudo-llamar" href={`tel:${telefono}`} aria-label={`Llamar a ${titulo ?? ""}`} onClick={(e) => e.stopPropagation()}>
                                        <IconoLlamada className="icono-inline" />
                                      </a>
                                    )}
                                  </span>
                                )}
                              </div>
                              )}
                              {vista.ultimo_mensaje && mensaje && (
                                <span className="embudo-tarjeta-mensaje" title="Último mensaje del contacto">
                                  <IconoChat className="embudo-tarjeta-icono" />
                                  <span>{mensaje.texto ?? `(${mensaje.tipo})`}</span>
                                </span>
                              )}
                            </div>
                          </article>
                        )}
                      </Draggable>
                      );
                    })}
                    {prov.placeholder}
                    {col.tarjetas.length === 0 && !snap.isDraggingOver && <p className="embudo-col-vacia">Sin leads en este estado</p>}
                    {col.tarjetas.length < col.total && (
                      <button type="button" className="embudo-mas" disabled={cargandoMas === col.id} onClick={() => verMas(col)}>
                        {cargandoMas === col.id ? "Cargando…" : `Ver más (${col.total - col.tarjetas.length})`}
                      </button>
                    )}
                  </div>
                )}
              </Droppable>
            </section>
          ))}
        </div>
      </DragDropContext>

      {pendientePerdido && (
        <div className="modal-fondo" onClick={() => setPendientePerdido(null)}>
          <div className="modal-tarjeta" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>Motivo de pérdida</h2>
            <p>Elige por qué se pierde esta oportunidad.</p>
            <select className="embudo-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)}>
              {datos.motivos.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="modal-acciones">
              <button type="button" className="boton-secundario-claro" onClick={() => setPendientePerdido(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="boton-guardar"
                onClick={() => {
                  const p = pendientePerdido;
                  setPendientePerdido(null);
                  void mover(p, motivo);
                }}
              >
                Mover a Perdido
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
