import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Categoria = "marketing" | "utility" | "authentication";

type BotonForm =
  | { tipo: "respuesta_rapida"; texto: string }
  | { tipo: "url"; texto: string; url: string }
  | { tipo: "telefono"; texto: string; telefono: string }
  | { tipo: "copiar_codigo"; ejemplo: string };

type Componentes = {
  header: { texto: string } | null;
  body: { texto: string; ejemplos: string[] };
  footer: string | null;
  botones: BotonForm[];
};

type PlantillaDetalle = {
  id: string;
  nombre_tecnico: string;
  idioma: string;
  categoria: Categoria;
  componentes: Componentes;
};

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
  const [nombreTecnico, setNombreTecnico] = useState("");
  const [idioma, setIdioma] = useState("es_MX");
  const [categoria, setCategoria] = useState<Categoria>("utility");

  const [headerActivo, setHeaderActivo] = useState(false);
  const [headerTexto, setHeaderTexto] = useState("");

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
        setNombreTecnico(p.nombre_tecnico);
        setIdioma(p.idioma);
        setCategoria(p.categoria);
        setHeaderActivo(Boolean(p.componentes.header));
        setHeaderTexto(p.componentes.header?.texto ?? "");
        setBodyTexto(p.componentes.body.texto);
        setEjemplos(p.componentes.body.ejemplos);
        setFooterActivo(Boolean(p.componentes.footer));
        setFooterTexto(p.componentes.footer ?? "");
        setBotones(p.componentes.botones);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la plantilla."))
      .finally(() => setCargando(false));
  }, [sucursalId, pid]);

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

  function construirComponentes(): Componentes {
    return {
      header: headerActivo && headerTexto.trim() ? { texto: headerTexto.trim() } : null,
      body: { texto: bodyTexto.trim(), ejemplos: ejemplos.map((e) => e.trim()) },
      footer: footerActivo && footerTexto.trim() ? footerTexto.trim() : null,
      botones,
    };
  }

  async function guardar(enviarDespues: boolean) {
    setError(null);

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

    setEnviando(true);
    try {
      const componentes = construirComponentes();
      let plantillaId = pid;

      if (editando && pid) {
        await apiFetch(`/api/admin/sucursales/${sucursalId}/plantillas/${pid}`, {
          method: "PATCH",
          body: JSON.stringify({ idioma, categoria, componentes }),
        });
      } else {
        const creada = await apiFetch<{ id: string }>(`/api/admin/sucursales/${sucursalId}/plantillas`, {
          method: "POST",
          body: JSON.stringify({ nombre_tecnico: nombreTecnico.trim(), idioma, categoria, componentes }),
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
              <p>El nombre no se puede cambiar después de crearla.</p>
            </div>

            <div className="seccion-campos">
              <div className="trio-campos">
                <div className="campo-formulario">
                  <label htmlFor="nombre-tecnico">
                    Nombre técnico <span className="obligatorio">*</span>
                  </label>
                  <input
                    id="nombre-tecnico"
                    type="text"
                    value={nombreTecnico}
                    onChange={(e) => setNombreTecnico(e.target.value.toLowerCase())}
                    placeholder="confirmacion_garantia"
                    disabled={editando}
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
              <p>Opcional. Una línea corta en negritas arriba del mensaje.</p>
            </div>

            <div className="seccion-campos">
              <label className="opcion-radio">
                <input type="checkbox" checked={headerActivo} onChange={(e) => setHeaderActivo(e.target.checked)} />
                <span>Incluir encabezado de texto</span>
              </label>

              {headerActivo && (
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
          <div className="burbuja-whatsapp">
            {headerActivo && headerTexto && <div className="burbuja-header">{headerTexto}</div>}
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
