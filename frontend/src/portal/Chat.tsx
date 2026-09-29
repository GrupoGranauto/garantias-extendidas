import { useEffect, useRef, useState, type FormEvent } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";
import { useEventosChat } from "./useEventosChat";

type Conversacion = {
  id: string;
  wa_id: string;
  nombre_contacto: string | null;
  ultimo_mensaje_en: string | null;
  no_leidos: number;
  creado_en: string;
};

type Mensaje = {
  id: string;
  direccion: "entrante" | "saliente";
  tipo: string;
  texto: string | null;
  media_url: string | null;
  media_mime_type: string | null;
  media_nombre_archivo: string | null;
  reaccion_emoji: string | null;
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

function textoPreview(m: Mensaje): string {
  if (m.tipo === "texto") return m.texto ?? "";
  const etiquetas: Record<string, string> = {
    imagen: "📷 Imagen",
    video: "🎬 Video",
    documento: "📄 Documento",
    audio: "🎤 Audio",
    ubicacion: "📍 Ubicación",
    contacto: "👤 Contacto",
    reaccion: "Reaccionó",
    sistema: "Mensaje",
  };
  return etiquetas[m.tipo] ?? m.tipo;
}

/** Chat de WhatsApp de la sucursal: conversaciones a la izquierda, hilo a la derecha. Tiempo real por SSE. */
export default function Chat() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [conversaciones, setConversaciones] = useState<Conversacion[] | null>(null);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
  const seleccionadaIdRef = useRef<string | null>(null);
  useEffect(() => {
    seleccionadaIdRef.current = seleccionadaId;
  }, [seleccionadaId]);

  const [mensajes, setMensajes] = useState<Mensaje[] | null>(null);
  const [errorHilo, setErrorHilo] = useState<string | null>(null);

  const [borrador, setBorrador] = useState("");
  const [enviando, setEnviando] = useState(false);

  const finHiloRef = useRef<HTMLDivElement>(null);

  function cargarConversaciones() {
    apiFetch<Conversacion[]>(`/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones`)
      .then((lista) => {
        setConversaciones(lista);
        setErrorLista(null);
      })
      .catch((err) => setErrorLista(err instanceof Error ? err.message : "No se pudieron cargar las conversaciones."));
  }

  useEffect(() => {
    cargarConversaciones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sucursalId]);

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

  useEffect(() => {
    finHiloRef.current?.scrollIntoView({ block: "end" });
  }, [mensajes]);

  function seleccionar(id: string) {
    setSeleccionadaId(id);
    setConversaciones((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, no_leidos: 0 } : c)) : prev));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const texto = borrador.trim();
    if (!texto || !seleccionadaId) return;

    setEnviando(true);
    try {
      const mensaje = await apiFetch<Mensaje>(
        `/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${seleccionadaId}/mensajes`,
        { method: "POST", body: JSON.stringify({ texto }) },
      );
      setMensajes((prev) => [...(prev ?? []), mensaje]);
      setBorrador("");
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
                  <span className="chat-item-telefono">{c.wa_id}</span>
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
              <div>
                <strong>{etiquetaConversacion(seleccionada)}</strong>
                <p>{seleccionada.wa_id}</p>
              </div>
            </header>

            {errorHilo && (
              <div className="aviso-formulario">
                <Alerta tipo="error">{errorHilo}</Alerta>
              </div>
            )}

            <div className="chat-hilo-mensajes">
              {!mensajes && !errorHilo && <Cargador />}

              {mensajes?.map((m) => (
                <div key={m.id} className={`chat-burbuja chat-burbuja-${m.direccion}`}>
                  <div className="chat-burbuja-texto">{textoPreview(m)}</div>
                  <div className="chat-burbuja-remate">
                    <span>{formatearHora(m.creado_en)}</span>
                    {m.direccion === "saliente" && m.estado === "fallido" && (
                      <span className="chat-burbuja-error" title={m.error_detalle ?? "Error al enviar"}>
                        ⚠
                      </span>
                    )}
                  </div>
                </div>
              ))}
              <div ref={finHiloRef} />
            </div>

            <form className="chat-composer" onSubmit={onSubmit}>
              <input
                type="text"
                value={borrador}
                onChange={(e) => setBorrador(e.target.value)}
                placeholder="Escribe un mensaje…"
                disabled={enviando}
              />
              <button type="submit" className="boton-guardar" disabled={enviando || !borrador.trim()}>
                {enviando ? "Enviando…" : "Enviar"}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
