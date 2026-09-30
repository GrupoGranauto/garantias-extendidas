import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoCheck, IconoClip, IconoDobleCheck, IconoDocumento, IconoReloj, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";
import { useEventosChat } from "./useEventosChat";

type Conversacion = {
  id: string;
  wa_id: string;
  nombre_contacto: string | null;
  ultimo_mensaje_en: string | null;
  ultimo_mensaje_tipo: string | null;
  ultimo_mensaje_texto: string | null;
  ultimo_mensaje_direccion: "entrante" | "saliente" | null;
  ultimo_mensaje_estado: string | null;
  no_leidos: number;
  resuelto: boolean;
  creado_en: string;
};

type Mensaje = {
  id: string;
  wa_message_id: string | null;
  direccion: "entrante" | "saliente";
  tipo: string;
  texto: string | null;
  media_url: string | null;
  media_mime_type: string | null;
  media_nombre_archivo: string | null;
  reaccion_emoji: string | null;
  reaccion_a_wa_message_id: string | null;
  estado: string;
  error_detalle: string | null;
  creado_en: string;
};

function etiquetaConversacion(c: Conversacion): string {
  return c.nombre_contacto?.trim() || c.wa_id;
}

function iniciales(texto: string): string {
  const limpio = texto.trim();
  return limpio ? limpio.charAt(0).toUpperCase() : "?";
}

function formatearHora(valor: string | null): string {
  if (!valor) return "";
  return new Date(valor).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

function diasDesdeHoy(fecha: Date): number {
  const hoy = new Date();
  const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const inicioFecha = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  return Math.round((inicioHoy.getTime() - inicioFecha.getTime()) / 86400000);
}

function nombreDia(fecha: Date): string {
  const texto = fecha.toLocaleDateString("es-MX", { weekday: "long" });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Etiqueta de día para separadores del hilo: "Hoy", "Ayer", nombre del día (última semana) o fecha completa. */
function etiquetaFecha(valor: string): string {
  const fecha = new Date(valor);
  const diff = diasDesdeHoy(fecha);
  if (diff <= 0) return "Hoy";
  if (diff === 1) return "Ayer";
  if (diff < 7) return nombreDia(fecha);
  return fecha.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Hora en la tarjeta de la lista: la hora si es de hoy, si no la misma etiqueta de día que el separador del hilo. */
function formatearHoraLista(valor: string | null): string {
  if (!valor) return "";
  const fecha = new Date(valor);
  if (diasDesdeHoy(fecha) <= 0) return fecha.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  return etiquetaFecha(valor);
}

const ETIQUETAS_TIPO: Record<string, string> = {
  imagen: "📷 Foto",
  video: "🎥 Video",
  audio: "🎤 Audio",
  documento: "📄 Documento",
  sticker: "Sticker",
  ubicacion: "📍 Ubicación",
  contacto: "👤 Contacto",
  reaccion: "Reaccionó",
  sistema: "Mensaje",
};

function iconoEstadoEnvio(estado: string, errorDetalle?: string | null): ReactNode {
  if (estado === "fallido") {
    return (
      <span className="chat-burbuja-error" title={errorDetalle ?? "Error al enviar"}>
        ⚠
      </span>
    );
  }
  if (estado === "enviando") {
    return (
      <span className="chat-burbuja-estado" title="Enviando…">
        <IconoReloj />
      </span>
    );
  }
  if (estado === "enviado") {
    return (
      <span className="chat-burbuja-estado" title="Enviado">
        <IconoCheck />
      </span>
    );
  }
  if (estado === "entregado") {
    return (
      <span className="chat-burbuja-estado" title="Entregado">
        <IconoDobleCheck />
      </span>
    );
  }
  if (estado === "leido") {
    return (
      <span className="chat-burbuja-estado chat-burbuja-estado-leido" title="Leído">
        <IconoDobleCheck />
      </span>
    );
  }
  return null;
}

function textoPreview(m: Mensaje): string {
  return ETIQUETAS_TIPO[m.tipo] ?? m.texto ?? m.tipo;
}

/** Línea de previsualización en el listado de conversaciones (como el desktop): texto si es texto, ícono + etiqueta si no. */
function previewConversacion(c: Conversacion): string {
  if (!c.ultimo_mensaje_tipo) return c.wa_id;
  if (c.ultimo_mensaje_texto) return c.ultimo_mensaje_texto;
  return ETIQUETAS_TIPO[c.ultimo_mensaje_tipo] ?? c.ultimo_mensaje_tipo;
}

/** Del listado plano de mensajes, arma un mapa wa_message_id -> emoji con la última reacción de cada uno (vacío = se quitó). */
function mapaReacciones(mensajes: Mensaje[]): Record<string, string> {
  const mapa: Record<string, string> = {};
  for (const m of mensajes) {
    if (m.tipo !== "reaccion" || !m.reaccion_a_wa_message_id) continue;
    if (m.reaccion_emoji) mapa[m.reaccion_a_wa_message_id] = m.reaccion_emoji;
    else delete mapa[m.reaccion_a_wa_message_id];
  }
  return mapa;
}

function contenidoMensaje(m: Mensaje, onMediaLoad: () => void, onAbrirImagen: (url: string) => void): ReactNode {
  if (m.tipo === "imagen" && m.media_url) {
    return (
      <>
        <img
          src={m.media_url}
          alt=""
          className="chat-media-imagen"
          onLoad={onMediaLoad}
          onClick={() => onAbrirImagen(m.media_url!)}
        />
        {m.texto && <div className="chat-burbuja-texto">{m.texto}</div>}
      </>
    );
  }
  if (m.tipo === "video" && m.media_url) {
    return (
      <>
        <video src={m.media_url} controls className="chat-media-video" onLoadedMetadata={onMediaLoad} />
        {m.texto && <div className="chat-burbuja-texto">{m.texto}</div>}
      </>
    );
  }
  if (m.tipo === "audio" && m.media_url) {
    return <audio src={m.media_url} controls className="chat-media-audio" onLoadedMetadata={onMediaLoad} />;
  }
  if (m.tipo === "sticker" && m.media_url) {
    return (
      <img
        src={m.media_url}
        alt=""
        className="chat-media-sticker"
        onLoad={onMediaLoad}
        onClick={() => onAbrirImagen(m.media_url!)}
      />
    );
  }
  if (m.tipo === "documento" && m.media_url) {
    return (
      <a href={m.media_url} target="_blank" rel="noreferrer" className="chat-media-documento">
        <IconoDocumento />
        <span>{m.media_nombre_archivo ?? "Documento"}</span>
      </a>
    );
  }
  return <div className="chat-burbuja-texto">{textoPreview(m)}</div>;
}

/** Chat de WhatsApp de la sucursal: conversaciones a la izquierda, hilo a la derecha. Tiempo real por SSE. */
export default function Chat() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [conversaciones, setConversaciones] = useState<Conversacion[] | null>(null);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [vista, setVista] = useState<"activas" | "resueltas">("activas");
  const [resolviendo, setResolviendo] = useState(false);
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
  const seleccionadaIdRef = useRef<string | null>(null);
  useEffect(() => {
    seleccionadaIdRef.current = seleccionadaId;
  }, [seleccionadaId]);

  const [mensajes, setMensajes] = useState<Mensaje[] | null>(null);
  const [errorHilo, setErrorHilo] = useState<string | null>(null);

  const [borrador, setBorrador] = useState("");
  const [imagenAdjunta, setImagenAdjunta] = useState<File | null>(null);
  const [imagenVista, setImagenVista] = useState<string | null>(null);

  const finHiloRef = useRef<HTMLDivElement>(null);
  const archivoInputRef = useRef<HTMLInputElement>(null);

  function cargarConversaciones() {
    const resueltas = vista === "resueltas" ? "true" : "false";
    apiFetch<Conversacion[]>(`/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones?resueltas=${resueltas}`)
      .then((lista) => {
        setConversaciones(lista);
        setErrorLista(null);
      })
      .catch((err) => setErrorLista(err instanceof Error ? err.message : "No se pudieron cargar las conversaciones."));
  }

  useEffect(() => {
    setSeleccionadaId(null);
    cargarConversaciones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sucursalId, vista]);

  async function alternarResuelto() {
    if (!seleccionadaId) return;
    setResolviendo(true);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${seleccionadaId}/resolver`, {
        method: "POST",
        body: JSON.stringify({ resuelto: vista === "activas" }),
      });
      setSeleccionadaId(null);
      cargarConversaciones();
    } catch (err) {
      setErrorHilo(err instanceof Error ? err.message : "No se pudo actualizar la conversación.");
    } finally {
      setResolviendo(false);
    }
  }

  function cargarMensajes(id: string) {
    apiFetch<Mensaje[]>(`/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${id}/mensajes`)
      .then((lista) => {
        setMensajes(lista);
        setErrorHilo(null);
      })
      .catch((err) => setErrorHilo(err instanceof Error ? err.message : "No se pudieron cargar los mensajes."));
  }

  useEffect(() => {
    if (!seleccionadaId) {
      setMensajes(null);
      return;
    }
    setMensajes(null);
    cargarMensajes(seleccionadaId);
    apiFetch(`/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${seleccionadaId}/leido`, { method: "POST" }).catch(
      () => {
        // no es crítico si falla marcar como leído
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seleccionadaId, sucursalId]);

  useEventosChat(sucursalId, (evento) => {
    cargarConversaciones();
    if (evento.conversacionId === seleccionadaIdRef.current) {
      cargarMensajes(evento.conversacionId);
      if (evento.tipo === "mensaje_entrante") {
        apiFetch(`/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${evento.conversacionId}/leido`, {
          method: "POST",
        }).catch(() => {
          // no es crítico si falla marcar como leído
        });
      }
    }
  });

  function desplazarAlFinal() {
    finHiloRef.current?.scrollIntoView({ block: "end" });
  }

  useEffect(() => {
    desplazarAlFinal();
  }, [mensajes]);

  function seleccionar(id: string) {
    setSeleccionadaId(id);
    setConversaciones((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, no_leidos: 0 } : c)) : prev));
  }

  function leerComoBase64(archivo: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => resolve(String(lector.result));
      lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
      lector.readAsDataURL(archivo);
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!seleccionadaId) return;
    const texto = borrador.trim();
    const archivo = imagenAdjunta;
    if (!texto && !archivo) return;

    const tempId = `temp-${crypto.randomUUID()}`;
    const optimista: Mensaje = {
      id: tempId,
      wa_message_id: null,
      direccion: "saliente",
      tipo: archivo ? "imagen" : "texto",
      texto: texto || null,
      media_url: archivo ? URL.createObjectURL(archivo) : null,
      media_mime_type: archivo?.type ?? null,
      media_nombre_archivo: null,
      reaccion_emoji: null,
      reaccion_a_wa_message_id: null,
      estado: "enviando",
      error_detalle: null,
      creado_en: new Date().toISOString(),
    };

    setMensajes((prev) => [...(prev ?? []), optimista]);
    setBorrador("");
    setImagenAdjunta(null);
    if (archivoInputRef.current) archivoInputRef.current.value = "";

    try {
      let mensaje: Mensaje;
      if (archivo) {
        const contenido_base64 = await leerComoBase64(archivo);
        mensaje = await apiFetch<Mensaje>(
          `/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${seleccionadaId}/media`,
          {
            method: "POST",
            body: JSON.stringify({
              nombre_archivo: archivo.name,
              tipo_mime: archivo.type,
              contenido_base64,
              caption: texto || undefined,
            }),
          },
        );
      } else {
        mensaje = await apiFetch<Mensaje>(
          `/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${seleccionadaId}/mensajes`,
          { method: "POST", body: JSON.stringify({ texto }) },
        );
      }
      setMensajes((prev) => (prev ?? []).map((m) => (m.id === tempId ? mensaje : m)));
      cargarConversaciones();
    } catch (err) {
      const detalle = err instanceof Error ? err.message : "No se pudo enviar el mensaje.";
      setMensajes((prev) => (prev ?? []).map((m) => (m.id === tempId ? { ...m, estado: "fallido", error_detalle: detalle } : m)));
      setErrorHilo(detalle);
    }
  }

  const seleccionada = conversaciones?.find((c) => c.id === seleccionadaId) ?? null;

  return (
    <div className="chat-inbox">
      <aside className="chat-lista">
        <header className="chat-lista-cabecera">
          <h1>Chat</h1>
          <div className="chat-tabs">
            <button
              type="button"
              className={`chat-tab${vista === "activas" ? " chat-tab-activo" : ""}`}
              onClick={() => setVista("activas")}
            >
              Activas
            </button>
            <button
              type="button"
              className={`chat-tab${vista === "resueltas" ? " chat-tab-activo" : ""}`}
              onClick={() => setVista("resueltas")}
            >
              Resueltas
            </button>
          </div>
        </header>

        {errorLista && (
          <div className="aviso-formulario">
            <Alerta tipo="error">{errorLista}</Alerta>
          </div>
        )}

        {!conversaciones && !errorLista && <Cargador />}

        {conversaciones && conversaciones.length === 0 && (
          <div className="marcador">
            <strong>Sin conversaciones todavía</strong>
            <span>Cuando un cliente escriba por WhatsApp, aparecerá aquí.</span>
          </div>
        )}

        <div className="chat-lista-items">
          {conversaciones?.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chat-item${c.id === seleccionadaId ? " chat-item-activo" : ""}`}
              onClick={() => seleccionar(c.id)}
            >
              <span className="chat-item-avatar">{iniciales(etiquetaConversacion(c))}</span>
              <span className="chat-item-datos">
                <span className="chat-item-fila">
                  <strong>{etiquetaConversacion(c)}</strong>
                  <span className="chat-item-hora">{formatearHoraLista(c.ultimo_mensaje_en)}</span>
                </span>
                <span className="chat-item-fila">
                  <span className="chat-item-telefono">
                    {c.ultimo_mensaje_direccion === "saliente" &&
                      c.ultimo_mensaje_estado &&
                      iconoEstadoEnvio(c.ultimo_mensaje_estado)}
                    {previewConversacion(c)}
                  </span>
                  {c.no_leidos > 0 && <span className="chat-item-badge">{c.no_leidos}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="chat-hilo-panel">
        {!seleccionada ? (
          <div className="chat-hilo-vacio">
            <p>Selecciona una conversación para ver los mensajes.</p>
          </div>
        ) : (
          <>
            <header className="chat-hilo-cabecera">
              <span className="chat-item-avatar">{iniciales(etiquetaConversacion(seleccionada))}</span>
              <div className="chat-hilo-cabecera-datos">
                <strong>{etiquetaConversacion(seleccionada)}</strong>
                <p>{seleccionada.wa_id}</p>
              </div>
              <button type="button" className="boton-tenue" onClick={alternarResuelto} disabled={resolviendo}>
                {resolviendo ? "Guardando…" : vista === "activas" ? "Resolver" : "Reabrir"}
              </button>
            </header>

            {errorHilo && (
              <div className="aviso-formulario">
                <Alerta tipo="error">{errorHilo}</Alerta>
              </div>
            )}

            <div className="chat-hilo-mensajes">
              {!mensajes && !errorHilo && <Cargador />}

              {mensajes &&
                (() => {
                  const reacciones = mapaReacciones(mensajes);
                  const visibles = mensajes.filter((m) => m.tipo !== "reaccion");
                  const elementos: ReactNode[] = [];
                  let diaAnterior: string | null = null;

                  for (const m of visibles) {
                    const dia = new Date(m.creado_en).toDateString();
                    if (dia !== diaAnterior) {
                      elementos.push(
                        <div key={`fecha-${dia}`} className="chat-separador-fecha">
                          <span>{etiquetaFecha(m.creado_en)}</span>
                        </div>,
                      );
                      diaAnterior = dia;
                    }

                    const emoji = m.wa_message_id ? reacciones[m.wa_message_id] : undefined;
                    elementos.push(
                      <div key={m.id} className={`chat-burbuja chat-burbuja-${m.direccion}`}>
                        {contenidoMensaje(m, desplazarAlFinal, setImagenVista)}
                        {emoji && <span className="chat-burbuja-reaccion">{emoji}</span>}
                        <div className="chat-burbuja-remate">
                          <span>{formatearHora(m.creado_en)}</span>
                          {m.direccion === "saliente" && iconoEstadoEnvio(m.estado, m.error_detalle)}
                        </div>
                      </div>,
                    );
                  }

                  return elementos;
                })()}
              <div ref={finHiloRef} />
            </div>

            <form className="chat-composer" onSubmit={onSubmit}>
              {imagenAdjunta && (
                <div className="chat-adjunto">
                  <img src={URL.createObjectURL(imagenAdjunta)} alt="" />
                  <span>{imagenAdjunta.name}</span>
                  <button
                    type="button"
                    className="chat-adjunto-quitar"
                    onClick={() => {
                      setImagenAdjunta(null);
                      if (archivoInputRef.current) archivoInputRef.current.value = "";
                    }}
                  >
                    <IconoXMarca />
                  </button>
                </div>
              )}
              <div className="chat-composer-fila">
                <input
                  ref={archivoInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  className="chat-adjunto-input"
                  onChange={(e) => setImagenAdjunta(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  className="chat-adjunto-boton"
                  onClick={() => archivoInputRef.current?.click()}
                  title="Adjuntar imagen"
                >
                  <IconoClip />
                </button>
                <input
                  type="text"
                  value={borrador}
                  onChange={(e) => setBorrador(e.target.value)}
                  placeholder={imagenAdjunta ? "Escribe un pie de foto (opcional)…" : "Escribe un mensaje…"}
                />
                <button type="submit" className="boton-guardar" disabled={!borrador.trim() && !imagenAdjunta}>
                  Enviar
                </button>
              </div>
            </form>
          </>
        )}
      </section>

      {imagenVista && (
        <div className="chat-visor" onClick={() => setImagenVista(null)}>
          <button type="button" className="chat-visor-cerrar" onClick={() => setImagenVista(null)}>
            <IconoXMarca />
          </button>
          <img src={imagenVista} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
