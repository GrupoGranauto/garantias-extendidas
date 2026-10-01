import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import {
  IconoCamara,
  IconoCheck,
  IconoClip,
  IconoDobleCheck,
  IconoDocumento,
  IconoEmoji,
  IconoMensaje,
  IconoMicrofono,
  IconoReloj,
  IconoUbicacion,
  IconoUsuarios,
  IconoVideollamada,
  IconoXMarca,
} from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";
import { useEventosChat } from "./useEventosChat";
import { useRealtimeChat } from "./useRealtimeChat";

type Conversacion = {
  id: string;
  wa_id: string;
  nombre_contacto: string | null;
  ultimo_mensaje_en: string | null;
  ultimo_mensaje_tipo: string | null;
  ultimo_mensaje_texto: string | null;
  ultimo_mensaje_direccion: "entrante" | "saliente" | null;
  ultimo_mensaje_estado: string | null;
  ultimo_mensaje_cliente_en: string | null;
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

type PlantillaDisponible = { id: string; nombre: string; nombre_tecnico: string; idioma: string; preview: string };

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

const VENTANA_24H_MS = 24 * 60 * 60 * 1000;

/**
 * Ventana de 24h de WhatsApp: solo se puede mandar texto/imagen libre dentro
 * de las 24h desde el último mensaje del CLIENTE. Pasadas, solo se reabre
 * si el cliente vuelve a escribir — no por tiempo — o se manda una plantilla.
 */
function estadoVentana24h(ultimoMensajeClienteEn: string | null): { cerrada: boolean; restanteMs: number } {
  if (!ultimoMensajeClienteEn) return { cerrada: true, restanteMs: 0 };
  const restanteMs = VENTANA_24H_MS - (Date.now() - new Date(ultimoMensajeClienteEn).getTime());
  return { cerrada: restanteMs <= 0, restanteMs };
}

function formatearRestante(ms: number): string {
  const horas = Math.floor(ms / 3600000);
  const minutos = Math.floor((ms % 3600000) / 60000);
  return `${horas}h ${minutos}m`;
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
  imagen: "Foto",
  video: "Video",
  audio: "Audio",
  documento: "Documento",
  sticker: "Sticker",
  ubicacion: "Ubicación",
  contacto: "Contacto",
  reaccion: "Reacción",
  sistema: "Mensaje",
};

const ICONO_TIPO: Record<string, (props: { className?: string }) => ReactNode> = {
  imagen: IconoCamara,
  video: IconoVideollamada,
  audio: IconoMicrofono,
  documento: IconoDocumento,
  sticker: IconoEmoji,
  ubicacion: IconoUbicacion,
  contacto: IconoUsuarios,
  reaccion: IconoEmoji,
  sistema: IconoMensaje,
};

/** Ícono + etiqueta para un tipo de mensaje que no es texto (sin emojis). */
function TipoMensaje({ tipo }: { tipo: string | null }) {
  if (!tipo) return null;
  const Icono = ICONO_TIPO[tipo];
  const etiqueta = ETIQUETAS_TIPO[tipo] ?? tipo;
  return (
    <span className="chat-tipo-preview">
      {Icono && <Icono className="icono-inline" />}
      {etiqueta}
    </span>
  );
}

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

/** *negrita*, _cursiva_, ~tachado~, ```monoespaciado``` — el mismo formato que WhatsApp interpreta en el teléfono del cliente. */
function formatoWhatsApp(texto: string): ReactNode {
  const partes: ReactNode[] = [];
  const regex = /```([^`]+)```|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~/g;
  let ultimo = 0;
  let clave = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(texto))) {
    if (match.index > ultimo) partes.push(texto.slice(ultimo, match.index));
    if (match[1] !== undefined) partes.push(<code key={clave++}>{match[1]}</code>);
    else if (match[2] !== undefined) partes.push(<strong key={clave++}>{match[2]}</strong>);
    else if (match[3] !== undefined) partes.push(<em key={clave++}>{match[3]}</em>);
    else if (match[4] !== undefined) partes.push(<del key={clave++}>{match[4]}</del>);
    ultimo = regex.lastIndex;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes;
}

/** Línea de previsualización en el listado de conversaciones: texto si es texto, ícono + etiqueta si no. */
function previewConversacion(c: Conversacion): ReactNode {
  if (!c.ultimo_mensaje_tipo) return c.wa_id;
  if (c.ultimo_mensaje_texto) return c.ultimo_mensaje_texto;
  return <TipoMensaje tipo={c.ultimo_mensaje_tipo} />;
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
        {m.texto && <div className="chat-burbuja-texto">{formatoWhatsApp(m.texto)}</div>}
      </>
    );
  }
  if (m.tipo === "video" && m.media_url) {
    return (
      <>
        <video src={m.media_url} controls className="chat-media-video" onLoadedMetadata={onMediaLoad} />
        {m.texto && <div className="chat-burbuja-texto">{formatoWhatsApp(m.texto)}</div>}
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
  return (
    <div className="chat-burbuja-texto">
      {m.tipo === "texto" && m.texto ? formatoWhatsApp(m.texto) : <TipoMensaje tipo={m.tipo} />}
    </div>
  );
}

/** Chat de WhatsApp de la sucursal: conversaciones a la izquierda, hilo a la derecha. Tiempo real por SSE. */
export default function Chat() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [conversaciones, setConversaciones] = useState<Conversacion[] | null>(null);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [vista, setVista] = useState<"activas" | "no_leidos" | "resueltas">("activas");
  const [busqueda, setBusqueda] = useState("");
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
  const [plantillas, setPlantillas] = useState<PlantillaDisponible[] | null>(null);
  const [enviandoPlantilla, setEnviandoPlantilla] = useState(false);
  const [, forzarRecalculoVentana] = useState(0);

  useEffect(() => {
    const intervalo = setInterval(() => forzarRecalculoVentana((n) => n + 1), 60000);
    return () => clearInterval(intervalo);
  }, []);

  const finHiloRef = useRef<HTMLDivElement>(null);
  const archivoInputRef = useRef<HTMLInputElement>(null);

  function cargarConversaciones() {
    const resueltas = vista === "resueltas" ? "true" : "false";
    const noLeidos = vista === "no_leidos" ? "&no_leidos=true" : "";
    apiFetch<Conversacion[]>(
      `/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones?resueltas=${resueltas}${noLeidos}`,
    )
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

  useEffect(() => {
    apiFetch<PlantillaDisponible[]>(`/api/admin/sucursales/${sucursalId}/whatsapp/plantillas-disponibles`)
      .then(setPlantillas)
      .catch(() => setPlantillas([]));
  }, [sucursalId]);

  async function alternarResuelto() {
    if (!seleccionadaId) return;
    setResolviendo(true);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${seleccionadaId}/resolver`, {
        method: "POST",
        body: JSON.stringify({ resuelto: vista !== "resueltas" }),
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

  // Supabase Realtime: mantiene la lista en vivo entre asesores (y si cambia el
  // dueño de un chat suelto, le desaparece a los demás al instante).
  useRealtimeChat(sucursalId, () => {
    cargarConversaciones();
    const sel = seleccionadaIdRef.current;
    if (sel) cargarMensajes(sel);
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

  async function enviarPlantilla(plantilla: PlantillaDisponible) {
    if (!seleccionadaId) return;
    setBorrador("");

    const tempId = `temp-${crypto.randomUUID()}`;
    const optimista: Mensaje = {
      id: tempId,
      wa_message_id: null,
      direccion: "saliente",
      tipo: "texto",
      texto: `Plantilla: ${plantilla.nombre}`,
      media_url: null,
      media_mime_type: null,
      media_nombre_archivo: null,
      reaccion_emoji: null,
      reaccion_a_wa_message_id: null,
      estado: "enviando",
      error_detalle: null,
      creado_en: new Date().toISOString(),
    };
    setMensajes((prev) => [...(prev ?? []), optimista]);
    setEnviandoPlantilla(true);

    try {
      const mensaje = await apiFetch<Mensaje>(
        `/api/admin/sucursales/${sucursalId}/whatsapp/conversaciones/${seleccionadaId}/plantilla`,
        { method: "POST", body: JSON.stringify({ plantilla_id: plantilla.id }) },
      );
      setMensajes((prev) => (prev ?? []).map((m) => (m.id === tempId ? mensaje : m)));
      cargarConversaciones();
    } catch (err) {
      const detalle = err instanceof Error ? err.message : "No se pudo enviar la plantilla.";
      setMensajes((prev) => (prev ?? []).map((m) => (m.id === tempId ? { ...m, estado: "fallido", error_detalle: detalle } : m)));
      setErrorHilo(detalle);
    } finally {
      setEnviandoPlantilla(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!seleccionadaId) return;
    if (borrador.startsWith("/")) return; // se manda desde el picker de plantillas, no como texto
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
  const ventana = estadoVentana24h(seleccionada?.ultimo_mensaje_cliente_en ?? null);

  const mostrarPickerPlantillas = borrador.startsWith("/");
  const plantillasFiltradas = mostrarPickerPlantillas
    ? (plantillas ?? []).filter((p) => p.nombre.toLowerCase().includes(borrador.slice(1).trim().toLowerCase()))
    : [];

  const conversacionesFiltradas = (conversaciones ?? []).filter((c) => {
    const texto = busqueda.trim().toLowerCase();
    if (!texto) return true;
    return etiquetaConversacion(c).toLowerCase().includes(texto) || c.wa_id.includes(texto);
  });
  const totalNoLeidos = conversacionesFiltradas.reduce((suma, c) => suma + (c.no_leidos > 0 ? 1 : 0), 0);

  return (
    <div className="chat-inbox">
      <aside className="chat-lista">
        <header className="chat-lista-cabecera">
          <input
            type="text"
            className="chat-buscador"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre o teléfono…"
          />
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
              className={`chat-tab${vista === "no_leidos" ? " chat-tab-activo" : ""}`}
              onClick={() => setVista("no_leidos")}
            >
              No leídos
            </button>
            <button
              type="button"
              className={`chat-tab${vista === "resueltas" ? " chat-tab-activo" : ""}`}
              onClick={() => setVista("resueltas")}
            >
              Resueltos
            </button>
          </div>
        </header>

        {conversaciones && conversaciones.length > 0 && (
          <div className="chat-lista-contador">
            <span>{totalNoLeidos} no leídos</span>
            <span>{conversacionesFiltradas.length} conversaciones</span>
          </div>
        )}

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
          {conversacionesFiltradas.map((c) => (
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
                {resolviendo ? "Guardando…" : vista === "resueltas" ? "Reabrir" : "Resolver"}
              </button>
            </header>

            {!ventana.cerrada && (
              <div className="chat-ventana-24h">Ventana de atención activa ({formatearRestante(ventana.restanteMs)} restantes)</div>
            )}

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
              {ventana.cerrada && (
                <div className="chat-ventana-cerrada">
                  <strong>Ventana de 24h cerrada.</strong>
                  <span>
                    {etiquetaConversacion(seleccionada)} debe escribirte de nuevo para reabrirla — no se reabre por
                    tiempo. Mientras tanto solo puedes mandar una plantilla aprobada: escribe "/" para elegir una.
                  </span>
                </div>
              )}
              {mostrarPickerPlantillas && (
                <div className="chat-plantillas-picker">
                  {plantillas === null && <div className="chat-plantillas-picker-vacio">Cargando plantillas…</div>}
                  {plantillas !== null && plantillasFiltradas.length === 0 && (
                    <div className="chat-plantillas-picker-vacio">Sin plantillas listas para enviar así.</div>
                  )}
                  {plantillasFiltradas.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="chat-plantillas-picker-item"
                      disabled={enviandoPlantilla}
                      onClick={() => enviarPlantilla(p)}
                    >
                      <span className="chat-plantillas-picker-item-cabecera">
                        <strong>{p.nombre}</strong>
                        <span>{p.idioma}</span>
                      </span>
                      {p.preview && <span className="chat-plantillas-picker-item-preview">{p.preview}</span>}
                    </button>
                  ))}
                </div>
              )}
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
                  disabled={ventana.cerrada}
                  title="Adjuntar imagen"
                >
                  <IconoClip />
                </button>
                <input
                  type="text"
                  value={borrador}
                  onChange={(e) => setBorrador(e.target.value)}
                  placeholder={
                    ventana.cerrada
                      ? 'Ventana cerrada — escribe "/" para mandar una plantilla…'
                      : imagenAdjunta
                        ? "Escribe un pie de foto (opcional)…"
                        : "Escribe un mensaje…"
                  }
                />
                <button
                  type="submit"
                  className="boton-guardar"
                  disabled={(!borrador.trim() && !imagenAdjunta) || (ventana.cerrada && !mostrarPickerPlantillas)}
                >
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
