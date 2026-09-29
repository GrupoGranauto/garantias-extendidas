import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoCheck, IconoClip, IconoDobleCheck, IconoDocumento, IconoXMarca } from "../componentes/Iconos";
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
  const [enviando, setEnviando] = useState(false);
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
    if (!texto && !imagenAdjunta) return;

    setEnviando(true);
    try {
      let mensaje: Mensaje;
      if (imagenAdjunta) {
        const contenido_base64 = await leerComoBase64(imagenAdjunta);
        mensaje = await apiFetch<Mensaje>(
          `/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${seleccionadaId}/media`,
          {
            method: "POST",
            body: JSON.stringify({
              nombre_archivo: imagenAdjunta.name,
              tipo_mime: imagenAdjunta.type,
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
      setMensajes((prev) => [...(prev ?? []), mensaje]);
      setBorrador("");
      setImagenAdjunta(null);
      if (archivoInputRef.current) archivoInputRef.current.value = "";
      cargarConversaciones();
    } catch (err) {
      setErrorHilo(err instanceof Error ? err.message : "No se pudo enviar el mensaje.");
    } finally {
      setEnviando(false);
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
                  <span className="chat-item-hora">{formatearHora(c.ultimo_mensaje_en)}</span>
                </span>
                <span className="chat-item-fila">
                  <span className="chat-item-telefono">{previewConversacion(c)}</span>
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
                  return mensajes
                    .filter((m) => m.tipo !== "reaccion")
                    .map((m) => {
                      const emoji = m.wa_message_id ? reacciones[m.wa_message_id] : undefined;
                      return (
                        <div key={m.id} className={`chat-burbuja chat-burbuja-${m.direccion}`}>
                          {contenidoMensaje(m, desplazarAlFinal, setImagenVista)}
                          {emoji && <span className="chat-burbuja-reaccion">{emoji}</span>}
                          <div className="chat-burbuja-remate">
                            <span>{formatearHora(m.creado_en)}</span>
                            {m.direccion === "saliente" && m.estado === "fallido" && (
                              <span className="chat-burbuja-error" title={m.error_detalle ?? "Error al enviar"}>
                                ⚠
                              </span>
                            )}
                            {m.direccion === "saliente" && m.estado === "enviado" && (
                              <span className="chat-burbuja-estado" title="Enviado">
                                <IconoCheck />
                              </span>
                            )}
                            {m.direccion === "saliente" && m.estado === "entregado" && (
                              <span className="chat-burbuja-estado" title="Entregado">
                                <IconoDobleCheck />
                              </span>
                            )}
                            {m.direccion === "saliente" && m.estado === "leido" && (
                              <span className="chat-burbuja-estado chat-burbuja-estado-leido" title="Leído">
                                <IconoDobleCheck />
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    });
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
                  disabled={enviando}
                />
                <button
                  type="button"
                  className="chat-adjunto-boton"
                  onClick={() => archivoInputRef.current?.click()}
                  disabled={enviando}
                  title="Adjuntar imagen"
                >
                  <IconoClip />
                </button>
                <input
                  type="text"
                  value={borrador}
                  onChange={(e) => setBorrador(e.target.value)}
                  placeholder={imagenAdjunta ? "Escribe un pie de foto (opcional)…" : "Escribe un mensaje…"}
                  disabled={enviando}
                />
                <button
                  type="submit"
                  className="boton-guardar"
                  disabled={enviando || (!borrador.trim() && !imagenAdjunta)}
                >
                  {enviando ? "Enviando…" : "Enviar"}
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
