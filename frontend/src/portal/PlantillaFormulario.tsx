import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import {
  IconoBateria,
  IconoCamara,
  IconoClip,
  IconoEmoji,
  IconoLlamada,
  IconoMicrofono,
  IconoSenal,
  IconoVideollamada,
} from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Categoria = "marketing" | "utility" | "authentication";

type BotonForm =
  | { tipo: "respuesta_rapida"; texto: string }
  | { tipo: "url"; texto: string; url: string }
  | { tipo: "telefono"; texto: string; telefono: string }
  | { tipo: "copiar_codigo"; ejemplo: string };

type HeaderForm =
  | { tipo: "texto"; texto: string }
  | { tipo: "imagen"; media_handle: string; media_url: string | null }
  | { tipo: "video"; media_handle: string; media_url: string | null }
  | { tipo: "documento"; media_handle: string; media_url: string | null; nombre_archivo: string | null };

type Componentes = {
  header: HeaderForm | null;
  body: { texto: string; ejemplos: string[] };
  footer: string | null;
  botones: BotonForm[];
};

const MIME_POR_TIPO: Record<"imagen" | "video" | "documento", string> = {
  imagen: "image/jpeg,image/png",
  video: "video/mp4",
  documento: "application/pdf",
};

type PlantillaDetalle = {
  id: string;
  nombre: string;
  nombre_tecnico: string;
  idioma: string;
  categoria: Categoria;
  componentes: Componentes;
};

/** Minúsculas, sin acentos, todo lo no alfanumérico colapsado a "_". Solo para comodidad al escribir. */
function aNombreTecnico(texto: string): string {
  const normalizado = texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  let slug = "";
  for (const caracter of normalizado) {
    if (/[a-z0-9]/.test(caracter)) slug += caracter;
    else if (/[ \-_./]/.test(caracter)) slug += "_";
  }
  return slug.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

const CATEGORIAS: { valor: Categoria; etiqueta: string }[] = [
  { valor: "utility", etiqueta: "Utilidad" },
  { valor: "marketing", etiqueta: "Marketing" },
  { valor: "authentication", etiqueta: "Autenticación" },
];

const LIMITES: Record<BotonForm["tipo"], number> = {
  respuesta_rapida: 3,
  url: 2,
  telefono: 1,
  copiar_codigo: 1,
};

function botonPorDefecto(tipo: BotonForm["tipo"]): BotonForm {
  switch (tipo) {
    case "respuesta_rapida":
      return { tipo, texto: "" };
    case "url":
      return { tipo, texto: "", url: "" };
    case "telefono":
      return { tipo, texto: "", telefono: "" };
    case "copiar_codigo":
      return { tipo, ejemplo: "" };
  }
}

/** Alta/edición de una plantilla. Vive en el portal de la sucursal: la sucursal sale del subdominio, no de la URL. */
export default function PlantillaFormulario() {
  const { pid } = useParams<{ pid?: string }>();
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const navigate = useNavigate();
  const editando = Boolean(pid);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const [cargando, setCargando] = useState(editando);
  const [nombre, setNombre] = useState("");
  const [nombreTecnico, setNombreTecnico] = useState("");
  const [idioma, setIdioma] = useState("es_MX");
  const [categoria, setCategoria] = useState<Categoria>("utility");

  const [headerTipo, setHeaderTipo] = useState<"ninguno" | "texto" | "imagen" | "video" | "documento">("ninguno");
  const [headerTexto, setHeaderTexto] = useState("");
  const [headerMediaHandle, setHeaderMediaHandle] = useState("");
  const [headerMediaUrl, setHeaderMediaUrl] = useState<string | null>(null);
  const [headerNombreArchivo, setHeaderNombreArchivo] = useState<string | null>(null);
  const [subiendoHeader, setSubiendoHeader] = useState(false);
  const [avisoHeader, setAvisoHeader] = useState<string | null>(null);

  const [bodyTexto, setBodyTexto] = useState("");
  const [ejemplos, setEjemplos] = useState<string[]>([]);

  const [footerActivo, setFooterActivo] = useState(false);
  const [footerTexto, setFooterTexto] = useState("");

  const [botones, setBotones] = useState<BotonForm[]>([]);

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const variables = useMemo(() => {
    const numeros = [...bodyTexto.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    return Array.from(new Set(numeros)).sort((a, b) => a - b);
  }, [bodyTexto]);

  useEffect(() => {
    setEjemplos((previos) => variables.map((_, i) => previos[i] ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables.length]);

  useEffect(() => {
    if (!pid) return;
    apiFetch<PlantillaDetalle>(`/api/admin/sucursales/${sucursalId}/plantillas/${pid}`)
      .then((p) => {
        setNombre(p.nombre);
        setNombreTecnico(p.nombre_tecnico);
        setIdioma(p.idioma);
        setCategoria(p.categoria);
        const h = p.componentes.header;
        setHeaderTipo(h?.tipo ?? "ninguno");
        setHeaderTexto(h?.tipo === "texto" ? h.texto : "");
        setHeaderMediaHandle(h && h.tipo !== "texto" ? h.media_handle : "");
        setHeaderMediaUrl(h && h.tipo !== "texto" ? h.media_url : null);
        setHeaderNombreArchivo(h?.tipo === "documento" ? h.nombre_archivo : null);
        setBodyTexto(p.componentes.body.texto);
        setEjemplos(p.componentes.body.ejemplos);
        setFooterActivo(Boolean(p.componentes.footer));
        setFooterTexto(p.componentes.footer ?? "");
        setBotones(p.componentes.botones);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la plantilla."))
      .finally(() => setCargando(false));
  }, [sucursalId, pid]);

  function cambiarNombre(valor: string) {
    setNombre(valor);
    // El nombre técnico sigue al nombre mientras la plantilla no exista todavía
    if (!editando) setNombreTecnico(aNombreTecnico(valor));
  }

  function leerComoBase64(archivo: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => resolve(String(lector.result));
      lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
      lector.readAsDataURL(archivo);
    });
  }

  async function subirArchivoHeader(tipo: "imagen" | "video" | "documento", archivo: File | undefined) {
    if (!archivo) return;

    // La vista previa no depende de que la subida a Meta funcione: se ve de
    // inmediato con el archivo local, aunque la sucursal no tenga WhatsApp
    // configurado todavía (eso solo hace falta para mandarla a revisión).
    setHeaderMediaUrl(URL.createObjectURL(archivo));
    setHeaderNombreArchivo(archivo.name);
    setHeaderMediaHandle("");
    setAvisoHeader(null);
    setError(null);
    setSubiendoHeader(true);
    try {
      const contenido_base64 = await leerComoBase64(archivo);
      const resultado = await apiFetch<{ media_handle: string; media_url: string }>(
        `/api/admin/sucursales/${sucursalId}/plantillas/subir-media`,
        {
          method: "POST",
          body: JSON.stringify({
            tipo,
            nombre_archivo: archivo.name,
            tipo_mime: archivo.type,
            contenido_base64,
          }),
        },
      );
      setHeaderMediaHandle(resultado.media_handle);
      setHeaderMediaUrl(resultado.media_url);
    } catch (err) {
      // No se pudo subir a Meta (ej. falta configurar WhatsApp): se avisa,
      // pero el preview local se queda — no hace falta bloquear el borrador.
      setAvisoHeader(err instanceof Error ? err.message : "No se pudo subir el archivo a Meta.");
    } finally {
      setSubiendoHeader(false);
    }
  }

  function insertarVariable() {
    const siguiente = variables.length ? Math.max(...variables) + 1 : 1;
    const token = `{{${siguiente}}}`;
    const area = areaRef.current;

    if (!area) {
      setBodyTexto((t) => t + token);
      return;
    }

    const inicio = area.selectionStart;
    const fin = area.selectionEnd;
    const nuevo = bodyTexto.slice(0, inicio) + token + bodyTexto.slice(fin);
    setBodyTexto(nuevo);

    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(inicio + token.length, inicio + token.length);
    });
  }

  function agregarBoton(tipo: BotonForm["tipo"]) {
    setBotones((prev) => [...prev, botonPorDefecto(tipo)]);
  }

  function actualizarBoton(indice: number, cambios: Partial<BotonForm>) {
    setBotones((prev) => prev.map((b, i) => (i === indice ? ({ ...b, ...cambios } as BotonForm) : b)));
  }

  function quitarBoton(indice: number) {
    setBotones((prev) => prev.filter((_, i) => i !== indice));
  }

  function conteoBotones(tipo: BotonForm["tipo"]) {
    return botones.filter((b) => b.tipo === tipo).length;
  }

  function construirHeader(): HeaderForm | null {
    switch (headerTipo) {
      case "texto":
        return headerTexto.trim() ? { tipo: "texto", texto: headerTexto.trim() } : null;
      case "imagen":
      case "video":
        return headerMediaHandle ? { tipo: headerTipo, media_handle: headerMediaHandle, media_url: headerMediaUrl } : null;
      case "documento":
        return headerMediaHandle
          ? { tipo: "documento", media_handle: headerMediaHandle, media_url: headerMediaUrl, nombre_archivo: headerNombreArchivo }
          : null;
      default:
        return null;
    }
  }

  function construirComponentes(): Componentes {
    return {
      header: construirHeader(),
      body: { texto: bodyTexto.trim(), ejemplos: ejemplos.map((e) => e.trim()) },
      footer: footerActivo && footerTexto.trim() ? footerTexto.trim() : null,
      botones,
    };
  }

  async function guardar(enviarDespues: boolean) {
    setError(null);

    if (!nombre.trim()) {
      setError("Escribe el nombre de la plantilla.");
      return;
    }
    if (!nombreTecnico.trim() && !editando) {
      setError("Escribe el nombre técnico de la plantilla.");
      return;
    }
    if (!bodyTexto.trim()) {
      setError("El cuerpo del mensaje no puede estar vacío.");
      return;
    }
    if (variables.some((v, i) => v !== i + 1)) {
      setError("Las variables deben ser consecutivas empezando en {{1}}, sin saltos.");
      return;
    }
    if (ejemplos.some((e) => !e.trim())) {
      setError("Captura un ejemplo para cada variable del cuerpo.");
      return;
    }
    if (subiendoHeader) {
      setError("Espera a que termine de subirse el archivo del encabezado.");
      return;
    }
    if (
      enviarDespues &&
      (headerTipo === "imagen" || headerTipo === "video" || headerTipo === "documento") &&
      !headerMediaHandle
    ) {
      setError("El archivo del encabezado no se pudo subir a Meta; revisa la configuración de WhatsApp o vuelve a intentar.");
      return;
    }

    setEnviando(true);
    try {
      const componentes = construirComponentes();
      let plantillaId = pid;

      if (editando && pid) {
        await apiFetch(`/api/admin/sucursales/${sucursalId}/plantillas/${pid}`, {
          method: "PATCH",
          body: JSON.stringify({ nombre: nombre.trim(), idioma, categoria, componentes }),
        });
      } else {
        const creada = await apiFetch<{ id: string }>(`/api/admin/sucursales/${sucursalId}/plantillas`, {
          method: "POST",
          body: JSON.stringify({
            nombre: nombre.trim(),
            nombre_tecnico: nombreTecnico.trim(),
            idioma,
            categoria,
            componentes,
          }),
        });
        plantillaId = creada.id;
      }

      if (enviarDespues && plantillaId) {
        await apiFetch(`/api/admin/sucursales/${sucursalId}/plantillas/${plantillaId}/enviar`, { method: "POST" });
      }

      navigate("/plantillas");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la plantilla.");
    } finally {
      setEnviando(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    guardar(false);
  }

  if (cargando) {
    return (
      <div className="pagina-formulario">
        <Cargador />
      </div>
    );
  }

  const textoPreview = variables.reduce(
    (texto, v) => texto.replace(`{{${v}}}`, ejemplos[v - 1]?.trim() || `[variable ${v}]`),
    bodyTexto || "El cuerpo del mensaje aparece aquí…",
  );

  return (
    <form onSubmit={onSubmit} className="pagina-formulario">
      <nav className="migas" aria-label="Ruta">
        <Link to="/plantillas">Plantillas</Link>
        <span aria-hidden="true">/</span>
        <span>{editando ? "Editar" : "Nueva"}</span>
      </nav>

      <header className="pagina-cabecera">
        <h1>{editando ? "Editar plantilla" : "Nueva plantilla"}</h1>
        <p>Meta revisa cada plantilla antes de poder usarla para iniciar conversación fuera de la ventana de 24h.</p>
      </header>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      <div className="constructor-plantilla">
        <div>
          {/* ---------- Identidad ---------- */}
          <section className="seccion">
            <div className="seccion-info">
              <h2>Identidad</h2>
              <p>El nombre técnico no se puede cambiar después de crearla.</p>
            </div>

            <div className="seccion-campos">
              <div className="campo-formulario">
                <label htmlFor="nombre">
                  Nombre <span className="obligatorio">*</span>
                </label>
                <input
                  id="nombre"
                  type="text"
                  value={nombre}
                  onChange={(e) => cambiarNombre(e.target.value)}
                  placeholder="Confirmación de garantía"
                />
              </div>

              <div className="trio-campos">
                <div className="campo-formulario">
                  <label htmlFor="nombre-tecnico">
                    Nombre técnico <span className="obligatorio">*</span>
                  </label>
                  <input
                    id="nombre-tecnico"
                    type="text"
                    value={nombreTecnico}
                    onChange={(e) => setNombreTecnico(aNombreTecnico(e.target.value))}
                    placeholder="confirmacion_garantia"
                    disabled={editando}
                    style={{ fontFamily: "monospace" }}
                    spellCheck={false}
                  />
                </div>

                <div className="campo-formulario">
                  <label htmlFor="idioma">Idioma</label>
                  <input
                    id="idioma"
                    type="text"
                    value={idioma}
                    onChange={(e) => setIdioma(e.target.value)}
                    placeholder="es_MX"
                    spellCheck={false}
                  />
                </div>

                <div className="campo-formulario">
                  <label htmlFor="categoria">Categoría</label>
                  <select id="categoria" value={categoria} onChange={(e) => setCategoria(e.target.value as Categoria)}>
                    {CATEGORIAS.map((c) => (
                      <option key={c.valor} value={c.valor}>
                        {c.etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="campo-ayuda">Solo minúsculas, números y guiones bajos. Ej. confirmacion_garantia.</p>
            </div>
          </section>

          {/* ---------- Encabezado ---------- */}
          <section className="seccion">
            <div className="seccion-info">
              <h2>Encabezado</h2>
              <p>Opcional. Texto, imagen, video o documento arriba del mensaje.</p>
            </div>

            <div className="seccion-campos">
              <div className="campo-formulario">
                <label htmlFor="header-tipo">Tipo</label>
                <select
                  id="header-tipo"
                  value={headerTipo}
                  onChange={(e) => {
                    const tipo = e.target.value as typeof headerTipo;
                    setHeaderTipo(tipo);
                    setHeaderTexto("");
                    setHeaderMediaHandle("");
                    setHeaderMediaUrl(null);
                    setHeaderNombreArchivo(null);
                  }}
                >
                  <option value="ninguno">Ninguno</option>
                  <option value="texto">Texto</option>
                  <option value="imagen">Imagen</option>
                  <option value="video">Video</option>
                  <option value="documento">Documento</option>
                </select>
              </div>

              {headerTipo === "texto" && (
                <div className="campo-formulario">
                  <input
                    type="text"
                    value={headerTexto}
                    onChange={(e) => setHeaderTexto(e.target.value)}
                    placeholder="Ej. Actualización de tu garantía"
                    maxLength={60}
                  />
                  <p className="campo-ayuda">{headerTexto.length}/60</p>
                </div>
              )}

              {(headerTipo === "imagen" || headerTipo === "video" || headerTipo === "documento") && (
                <div className="campo-formulario">
                  <input
                    type="file"
                    accept={MIME_POR_TIPO[headerTipo]}
                    onChange={(e) => subirArchivoHeader(headerTipo, e.target.files?.[0])}
                    disabled={subiendoHeader}
                  />
                  {subiendoHeader && <p className="campo-ayuda">Subiendo a Meta…</p>}
                  {!subiendoHeader && headerNombreArchivo && (
                    <p className="campo-ayuda">
                      {headerMediaHandle ? "Listo: " : "Vista previa lista (falta subirla): "}
                      {headerNombreArchivo}.{" "}
                      <button
                        type="button"
                        className="boton-quitar"
                        style={{ padding: 0, display: "inline" }}
                        onClick={() => {
                          setHeaderMediaHandle("");
                          setHeaderMediaUrl(null);
                          setHeaderNombreArchivo(null);
                          setAvisoHeader(null);
                        }}
                      >
                        Quitar
                      </button>
                    </p>
                  )}
                  {avisoHeader && <Alerta tipo="info">{avisoHeader}</Alerta>}
                  <p className="campo-ayuda">
                    {headerTipo === "imagen" && "JPG o PNG."}
                    {headerTipo === "video" && "MP4."}
                    {headerTipo === "documento" && "PDF."}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* ---------- Cuerpo ---------- */}
          <section className="seccion">
            <div className="seccion-info">
              <h2>Cuerpo</h2>
              <p>El mensaje en sí. Usa variables para personalizarlo por destinatario.</p>
            </div>

            <div className="seccion-campos">
              <div className="campo-formulario">
                <label htmlFor="cuerpo">
                  Texto <span className="obligatorio">*</span>
                </label>
                <textarea
                  id="cuerpo"
                  ref={areaRef}
                  value={bodyTexto}
                  onChange={(e) => setBodyTexto(e.target.value)}
                  placeholder="Hola {{1}}, tu garantía folio {{2}} fue actualizada."
                  rows={5}
                  maxLength={1024}
                />
                <p className="campo-ayuda">{bodyTexto.length}/1024</p>
              </div>

              <button type="button" className="boton-agregar-tenue" onClick={insertarVariable}>
                + Insertar variable
              </button>

              {variables.map((v, i) => (
                <div className="fila-variable" key={v}>
                  <span>{`{{${v}}}`}</span>
                  <input
                    type="text"
                    value={ejemplos[i] ?? ""}
                    onChange={(e) => setEjemplos((prev) => prev.map((val, idx) => (idx === i ? e.target.value : val)))}
                    placeholder={`Ejemplo para {{${v}}}, ej. Juan Pérez`}
                  />
                </div>
              ))}
            </div>
          </section>

          {/* ---------- Pie ---------- */}
          <section className="seccion">
            <div className="seccion-info">
              <h2>Pie de página</h2>
              <p>Opcional. Una línea gris pequeña al final.</p>
            </div>

            <div className="seccion-campos">
              <label className="opcion-radio">
                <input type="checkbox" checked={footerActivo} onChange={(e) => setFooterActivo(e.target.checked)} />
                <span>Incluir pie de página</span>
              </label>

              {footerActivo && (
                <div className="campo-formulario">
                  <input
                    type="text"
                    value={footerTexto}
                    onChange={(e) => setFooterTexto(e.target.value)}
                    placeholder="Ej. Grupo GranAuto"
                    maxLength={60}
                  />
                  <p className="campo-ayuda">{footerTexto.length}/60</p>
                </div>
              )}
            </div>
          </section>

          {/* ---------- Botones ---------- */}
          <section className="seccion">
            <div className="seccion-info">
              <h2>Botones</h2>
              <p>Opcional. Hasta 10 en total.</p>
            </div>

            <div className="seccion-campos">
              {botones.map((b, i) => (
                <div className="fila-boton" key={i}>
                  <strong>
                    {b.tipo === "respuesta_rapida" && "Respuesta rápida"}
                    {b.tipo === "url" && "Abrir URL"}
                    {b.tipo === "telefono" && "Llamar"}
                    {b.tipo === "copiar_codigo" && "Copiar código"}
                  </strong>

                  <div className="pareja-campos">
                    {b.tipo !== "copiar_codigo" && (
                      <input
                        type="text"
                        value={b.texto}
                        onChange={(e) => actualizarBoton(i, { texto: e.target.value } as Partial<BotonForm>)}
                        placeholder="Texto del botón"
                        maxLength={25}
                      />
                    )}
                    {b.tipo === "url" && (
                      <input
                        type="text"
                        value={b.url}
                        onChange={(e) => actualizarBoton(i, { url: e.target.value })}
                        placeholder="https://…"
                      />
                    )}
                    {b.tipo === "telefono" && (
                      <input
                        type="text"
                        value={b.telefono}
                        onChange={(e) => actualizarBoton(i, { telefono: e.target.value })}
                        placeholder="+52 662 000 0000"
                      />
                    )}
                    {b.tipo === "copiar_codigo" && (
                      <input
                        type="text"
                        value={b.ejemplo}
                        onChange={(e) => actualizarBoton(i, { ejemplo: e.target.value })}
                        placeholder="Código de ejemplo"
                        maxLength={15}
                      />
                    )}
                  </div>

                  <button type="button" className="boton-quitar" onClick={() => quitarBoton(i)}>
                    Quitar
                  </button>
                </div>
              ))}

              <div className="celda-acciones" style={{ flexWrap: "wrap", marginTop: 10 }}>
                <button
                  type="button"
                  className="boton-agregar-tenue"
                  disabled={conteoBotones("respuesta_rapida") >= LIMITES.respuesta_rapida}
                  onClick={() => agregarBoton("respuesta_rapida")}
                >
                  + Respuesta rápida
                </button>
                <button
                  type="button"
                  className="boton-agregar-tenue"
                  disabled={conteoBotones("url") >= LIMITES.url}
                  onClick={() => agregarBoton("url")}
                >
                  + URL
                </button>
                <button
                  type="button"
                  className="boton-agregar-tenue"
                  disabled={conteoBotones("telefono") >= LIMITES.telefono}
                  onClick={() => agregarBoton("telefono")}
                >
                  + Llamada
                </button>
                <button
                  type="button"
                  className="boton-agregar-tenue"
                  disabled={conteoBotones("copiar_codigo") >= LIMITES.copiar_codigo}
                  onClick={() => agregarBoton("copiar_codigo")}
                >
                  + Copiar código
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* ---------- Preview ---------- */}
        <aside className="vista-previa-whatsapp">
          <h3>Vista previa</h3>
          <div className="telefono-marco">
            <div className="telefono-pantalla">
              <div className="telefono-notch" />

              <div className="telefono-statusbar">
                <span>04:20</span>
                <span className="telefono-statusbar-iconos">
                  <IconoSenal />
                  <IconoBateria />
                </span>
              </div>

              <div className="chat-header">
                <span className="chat-header-flecha">‹</span>
                <span className="chat-header-avatar">
                  <img src="/marca/icono-blanco.png" alt="" />
                </span>
                <span className="chat-header-datos">
                  <span className="chat-header-nombre">{portal?.nombre ?? "Tu sucursal"}</span>
                  <span className="chat-header-estado">en línea</span>
                </span>
                <span className="chat-header-acciones">
                  <IconoVideollamada />
                  <IconoLlamada />
                </span>
              </div>

              <div className="chat-fondo">
                <span className="chat-fecha">HOY</span>

                <div className="burbuja-whatsapp">
                  {headerTipo === "texto" && headerTexto && <div className="burbuja-header">{headerTexto}</div>}
                  {headerTipo === "imagen" && (
                    <div className="burbuja-media">
                      {headerMediaUrl ? <img src={headerMediaUrl} alt="" /> : "Imagen"}
                    </div>
                  )}
                  {headerTipo === "video" && (
                    <div className="burbuja-media">
                      {headerMediaUrl ? <video src={headerMediaUrl} controls /> : "Video"}
                    </div>
                  )}
                  {headerTipo === "documento" && (
                    <div className="burbuja-media">{headerNombreArchivo ?? "Documento"}</div>
                  )}
                  <div className="burbuja-cuerpo">{textoPreview}</div>
                  {footerActivo && footerTexto && <div className="burbuja-footer">{footerTexto}</div>}
                  {botones.length > 0 && (
                    <div className="burbuja-botones">
                      {botones.map((b, i) => (
                        <div className="burbuja-boton" key={i}>
                          {b.tipo === "copiar_codigo" ? "Copiar código" : b.texto || "…"}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="burbuja-remate">
                    <span>04:20</span>
                  </div>
                </div>
              </div>

              <div className="chat-entrada">
                <div className="chat-entrada-campo">
                  <IconoEmoji />
                  <span>Mensaje</span>
                  <IconoClip />
                  <IconoCamara />
                </div>
                <span className="chat-entrada-mic">
                  <IconoMicrofono />
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <footer className="barra-acciones">
        <p>
          Los campos marcados con <span className="obligatorio">*</span> son obligatorios.
        </p>
        <div className="pagina-acciones">
          <Link to="/plantillas" className="boton-secundario-claro">
            Cancelar
          </Link>
          <button type="submit" className="boton-secundario-claro" disabled={enviando}>
            {enviando ? "Guardando…" : "Guardar borrador"}
          </button>
          <button type="button" className="boton-guardar" disabled={enviando} onClick={() => guardar(true)}>
            {enviando ? "Guardando…" : "Guardar y enviar a revisión"}
          </button>
        </div>
      </footer>
    </form>
  );
}
