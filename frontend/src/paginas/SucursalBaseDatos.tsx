import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { useSucursal } from "./SucursalEditLayout";

type Tipo = "texto" | "entero" | "decimal" | "booleano" | "fecha" | "fecha_hora" | "uuid";
type Origen = "api" | "back";

type CampoServidor = {
  nombre_tecnico: string;
  nombre_visible: string;
  tipo: Tipo;
  longitud: number | null;
  requerido: boolean;
  origen: Origen;
};

type Entidad = {
  configurado: boolean;
  nombre_tecnico?: string;
  nombre_visible?: string;
  creado_en?: string;
  campos?: CampoServidor[];
  api_key: string;
};

type FilaCampo = CampoServidor & { clave: string; existente: boolean };

const TIPOS: { valor: Tipo; etiqueta: string }[] = [
  { valor: "texto", etiqueta: "Texto" },
  { valor: "entero", etiqueta: "Número entero" },
  { valor: "decimal", etiqueta: "Decimal" },
  { valor: "booleano", etiqueta: "Sí / No" },
  { valor: "fecha", etiqueta: "Fecha" },
  { valor: "fecha_hora", etiqueta: "Fecha y hora" },
  { valor: "uuid", etiqueta: "Identificador" },
];

const ORIGENES: { valor: Origen; etiqueta: string }[] = [
  { valor: "api", etiqueta: "API" },
  { valor: "back", etiqueta: "Back" },
];

const EJEMPLO_POR_TIPO: Record<Tipo, unknown> = {
  texto: "texto",
  entero: 0,
  decimal: 0.0,
  booleano: true,
  fecha: "2026-08-01",
  fecha_hora: "2026-08-01T10:30:00Z",
  uuid: "00000000-0000-0000-0000-000000000000",
};

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

/** Colorea un JSON como lo haría una consola: claves, cadenas y literales en tonos distintos. */
function resaltarJson(json: string) {
  const patron = /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g;
  const partes: ReactNode[] = [];
  let ultimo = 0;
  let indice = 0;
  let m: RegExpExecArray | null;

  while ((m = patron.exec(json))) {
    if (m.index > ultimo) partes.push(json.slice(ultimo, m.index));

    const texto = m[0];
    let clase = "tok-numero";
    if (texto.startsWith('"')) clase = /:\s*$/.test(texto) ? "tok-clave" : "tok-cadena";
    else if (texto === "true" || texto === "false") clase = "tok-booleano";
    else if (texto === "null") clase = "tok-nulo";

    partes.push(
      <span key={indice++} className={clase}>
        {texto}
      </span>,
    );
    ultimo = patron.lastIndex;
  }
  if (ultimo < json.length) partes.push(json.slice(ultimo));
  return partes;
}

function nuevaFila(): FilaCampo {
  return {
    clave: crypto.randomUUID(),
    existente: false,
    nombre_tecnico: "",
    nombre_visible: "",
    tipo: "texto",
    longitud: null,
    requerido: false,
    origen: "api",
  };
}

function BotonCopiar({ texto }: { texto: string }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      // portapapeles bloqueado: no hay mucho más que hacer
    }
  }

  return (
    <button type="button" className="boton-tenue" onClick={copiar}>
      {copiado ? "Copiado" : "Copiar"}
    </button>
  );
}

export default function SucursalBaseDatos() {
  const { sucursal } = useSucursal();

  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entidad, setEntidad] = useState<Entidad | null>(null);
  const [editando, setEditando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const [nombreVisible, setNombreVisible] = useState("");
  const [nombreTecnico, setNombreTecnico] = useState("");
  const [campos, setCampos] = useState<FilaCampo[]>([]);

  function cargar() {
    apiFetch<Entidad>(`/api/admin/sucursales/${sucursal.id}/entidad`)
      .then((data) => {
        setEntidad(data);
        if (!data.configurado) iniciarFormularioVacio();
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la entidad."))
      .finally(() => setCargando(false));
  }

  useEffect(cargar, [sucursal.id]);

  function iniciarFormularioVacio() {
    setNombreVisible("");
    setNombreTecnico("");
    setCampos([nuevaFila()]);
    setEditando(false);
  }

  function iniciarEdicion() {
    if (!entidad?.configurado) return;
    setNombreVisible(entidad.nombre_visible ?? "");
    setNombreTecnico(entidad.nombre_tecnico ?? "");
    setCampos(
      (entidad.campos ?? []).map((campo) => ({ ...campo, clave: crypto.randomUUID(), existente: true })),
    );
    setEditando(true);
    setGuardado(false);
  }

  function cambiarNombreVisible(valor: string) {
    setNombreVisible(valor);
    // El nombre técnico sigue al visible mientras no exista ya la entidad
    if (!entidad?.configurado) setNombreTecnico(aNombreTecnico(valor));
  }

  function agregarCampo() {
    setCampos((previos) => [...previos, nuevaFila()]);
  }

  function quitarCampo(clave: string) {
    setCampos((previos) => previos.filter((c) => c.clave !== clave));
  }

  function actualizarCampo(clave: string, cambios: Partial<FilaCampo>) {
    setCampos((previos) =>
      previos.map((campo) => {
        if (campo.clave !== clave) return campo;
        const actualizado = { ...campo, ...cambios };
        // El nombre técnico del campo sigue al visible mientras sea un campo nuevo
        if ("nombre_visible" in cambios && !campo.existente) {
          actualizado.nombre_tecnico = aNombreTecnico(cambios.nombre_visible ?? "");
        }
        return actualizado;
      }),
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (nombreVisible.trim().length < 2) {
      setError("Escribe el nombre de la entidad.");
      return;
    }
    if (campos.length === 0) {
      setError("Agrega al menos un campo.");
      return;
    }
    for (const campo of campos) {
      if (!campo.nombre_visible.trim()) {
        setError("Todos los campos necesitan un nombre visible.");
        return;
      }
    }

    setEnviando(true);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursal.id}/entidad`, {
        method: "PUT",
        body: JSON.stringify({
          nombre_visible: nombreVisible.trim(),
          nombre_tecnico: nombreTecnico.trim(),
          campos: campos.map(({ clave: _clave, existente: _existente, ...campo }) => ({
            ...campo,
            nombre_visible: campo.nombre_visible.trim(),
            nombre_tecnico: campo.nombre_tecnico.trim(),
          })),
        }),
      });

      setEditando(false);
      setGuardado(true);
      cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la entidad.");
    } finally {
      setEnviando(false);
    }
  }

  async function eliminarEntidad() {
    if (!entidad?.nombre_visible) return;
    const confirmado = window.confirm(
      `¿Eliminar «${entidad.nombre_visible}» y su tabla «${entidad.nombre_tecnico}»? Se perderán todos sus datos y no se puede deshacer.`,
    );
    if (!confirmado) return;

    try {
      await apiFetch(`/api/admin/sucursales/${sucursal.id}/entidad`, { method: "DELETE" });
      cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la entidad.");
    }
  }

  async function regenerarApiKey() {
    const confirmado = window.confirm(
      "Se generará una nueva API key y la anterior dejará de funcionar de inmediato. Tendrás que actualizarla donde la uses. ¿Continuar?",
    );
    if (!confirmado) return;

    try {
      const { api_key } = await apiFetch<{ api_key: string }>(
        `/api/admin/sucursales/${sucursal.id}/entidad/api-key/regenerar`,
        { method: "POST" },
      );
      setEntidad((previa) => (previa ? { ...previa, api_key } : previa));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo regenerar la API key.");
    }
  }

  if (cargando) {
    return <Cargador />;
  }

  const mostrarFormulario = !entidad?.configurado || editando;
  const origenApiUrl = `${window.location.origin}/api/entidades/${sucursal.id}`;
  const camposApi = (entidad?.campos ?? []).filter((c) => c.origen !== "back");

  return (
    <>
      <p className="pestana-descripcion">
        Define la entidad principal de esta sucursal (por ejemplo, sus garantías o citas): sus campos
        generan una tabla real, lista para recibir datos por API.
      </p>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}
      {guardado && !mostrarFormulario && (
        <div className="aviso-formulario">
          <Alerta tipo="ok">Cambios guardados.</Alerta>
        </div>
      )}

      {/* ---------- Resumen de la entidad ya creada ---------- */}
      {entidad?.configurado && !editando && (
        <section className="seccion">
          <div className="seccion-info">
            <h2>Entidad de la sucursal</h2>
            <p>Solo una por sucursal. Edítala para cambiar su estructura, o elimínala para crear otra.</p>
          </div>
          <div className="seccion-campos">
            <div className="tarjeta-entidad">
              <div>
                <strong>{entidad.nombre_visible}</strong>
                <div className="tarjeta-entidad-meta">
                  <code>{entidad.nombre_tecnico}</code>
                  <span>
                    {(entidad.campos ?? []).length} campos ·{" "}
                    {entidad.creado_en ? new Date(entidad.creado_en).toLocaleDateString() : ""}
                  </span>
                </div>
              </div>
              <div className="pagina-acciones">
                <button type="button" className="boton-tenue" onClick={iniciarEdicion}>
                  Editar
                </button>
                <button type="button" className="boton-tenue boton-peligro" onClick={eliminarEntidad}>
                  Eliminar
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ---------- Formulario: crear o editar ---------- */}
      {mostrarFormulario && (
        <form onSubmit={onSubmit}>
          <section className="seccion">
            <div className="seccion-info">
              <h2>{editando ? "Editar entidad" : "1 · Nombra la entidad"}</h2>
              <p>El nombre técnico se genera solo; puedes ajustarlo. Al editar, el nombre de la tabla no cambia.</p>
            </div>
            <div className="seccion-campos">
              <div className="pareja-campos">
                <div className="campo-formulario">
                  <label htmlFor="entidad-nombre">
                    Nombre visible <span className="obligatorio">*</span>
                  </label>
                  <input
                    id="entidad-nombre"
                    type="text"
                    value={nombreVisible}
                    onChange={(e) => cambiarNombreVisible(e.target.value)}
                    placeholder="Citas"
                  />
                </div>
                <div className="campo-formulario">
                  <label htmlFor="entidad-tecnico">Nombre técnico (tabla)</label>
                  <input
                    id="entidad-tecnico"
                    type="text"
                    value={nombreTecnico}
                    disabled={Boolean(entidad?.configurado)}
                    onChange={(e) => setNombreTecnico(aNombreTecnico(e.target.value))}
                    style={{ fontFamily: "monospace" }}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="seccion">
            <div className="seccion-info">
              <h2>2 · Define los campos</h2>
              <p>Cada campo es una columna de la tabla. El id, las fechas y la auditoría se agregan solos.</p>
            </div>
            <div className="seccion-campos">
              {campos.map((campo) => (
                <div className="fila-campo-entidad" key={campo.clave}>
                  <input
                    type="text"
                    value={campo.nombre_visible}
                    onChange={(e) => actualizarCampo(campo.clave, { nombre_visible: e.target.value })}
                    placeholder="Nombre del campo"
                  />
                  <input
                    type="text"
                    value={campo.nombre_tecnico}
                    disabled={campo.existente}
                    onChange={(e) => actualizarCampo(campo.clave, { nombre_tecnico: aNombreTecnico(e.target.value) })}
                    placeholder="nombre_tecnico"
                    style={{ fontFamily: "monospace" }}
                  />
                  <select
                    value={campo.tipo}
                    onChange={(e) => actualizarCampo(campo.clave, { tipo: e.target.value as Tipo })}
                  >
                    {TIPOS.map((t) => (
                      <option key={t.valor} value={t.valor}>
                        {t.etiqueta}
                      </option>
                    ))}
                  </select>
                  <select
                    value={campo.origen}
                    onChange={(e) => {
                      const origen = e.target.value as Origen;
                      // Un campo de origen Back se llena después, a mano: nunca puede ser obligatorio.
                      actualizarCampo(campo.clave, origen === "back" ? { origen, requerido: false } : { origen });
                    }}
                    title="Origen: quién llena el campo"
                  >
                    {ORIGENES.map((o) => (
                      <option key={o.valor} value={o.valor}>
                        {o.etiqueta}
                      </option>
                    ))}
                  </select>
                  <label className="campo-check-inline">
                    <input
                      type="checkbox"
                      checked={campo.requerido}
                      disabled={campo.origen === "back"}
                      onChange={(e) => actualizarCampo(campo.clave, { requerido: e.target.checked })}
                    />
                    Obligatorio
                  </label>
                  <button
                    type="button"
                    className="boton-tenue"
                    onClick={() => quitarCampo(campo.clave)}
                    aria-label="Quitar campo"
                  >
                    ✕
                  </button>
                </div>
              ))}

              {campos.length === 0 && (
                <div className="marcador" style={{ minHeight: "auto", padding: "16px 14px" }}>
                  <span>
                    Aún no agregas campos. Usa «Agregar campo» para empezar (por ejemplo: Cliente, Teléfono,
                    Fecha, Servicio).
                  </span>
                </div>
              )}

              <div>
                <button type="button" className="boton-tenue" onClick={agregarCampo}>
                  + Agregar campo
                </button>
              </div>
            </div>
          </section>

          <footer className="barra-acciones">
            <p>
              Los campos marcados con <span className="obligatorio">*</span> son obligatorios.
            </p>
            <div className="pagina-acciones">
              {editando && (
                <button type="button" className="boton-secundario-claro" onClick={() => setEditando(false)}>
                  Cancelar
                </button>
              )}
              <button type="submit" className="boton-guardar" disabled={enviando}>
                {enviando ? "Guardando…" : editando ? "Guardar cambios" : "Crear entidad"}
              </button>
            </div>
          </footer>
        </form>
      )}

      {/* ---------- Inserción vía API ---------- */}
      {entidad?.configurado && !editando && (
        <section className="seccion">
          <div className="seccion-info">
            <h2>Insertar registros vía API</h2>
            <p>Copia cada parte en su lugar de Postman. Cada botón copia exactamente lo que se pega.</p>
          </div>
          <div className="seccion-campos">
            <div className="campo-formulario">
              <div className="campo-cabecera-fila">
                <label>Método</label>
              </div>
              <p className="campo-ayuda">POST — no se copia, solo selecciónalo en Postman.</p>
            </div>

            <div className="campo-formulario">
              <div className="campo-cabecera-fila">
                <label>URL (un registro)</label>
                <BotonCopiar texto={`${origenApiUrl}/registros`} />
              </div>
              <input type="text" readOnly value={`${origenApiUrl}/registros`} className="campo-codigo" />
            </div>

            <div className="campo-formulario">
              <div className="campo-cabecera-fila">
                <label>API Key (header X-Api-Key)</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="boton-tenue" onClick={regenerarApiKey}>
                    Regenerar
                  </button>
                  <BotonCopiar texto={entidad.api_key} />
                </div>
              </div>
              <input type="text" readOnly value={entidad.api_key} className="campo-codigo" />
              <p className="campo-ayuda">
                Es la credencial de esta sucursal. No caduca hasta que la regeneres; no la compartas.
              </p>
            </div>

            <div className="campo-formulario">
              <div className="campo-cabecera-fila">
                <label>Body (raw → JSON)</label>
                <BotonCopiar
                  texto={JSON.stringify(
                    Object.fromEntries(camposApi.map((c) => [c.nombre_tecnico, EJEMPLO_POR_TIPO[c.tipo]])),
                    null,
                    2,
                  )}
                />
              </div>
              <pre className="bloque-codigo">
                {resaltarJson(
                  JSON.stringify(
                    Object.fromEntries(camposApi.map((c) => [c.nombre_tecnico, EJEMPLO_POR_TIPO[c.tipo]])),
                    null,
                    2,
                  ),
                )}
              </pre>
            </div>

            <div className="campo-formulario">
              <div className="campo-cabecera-fila">
                <label>URL (lote, hasta 5000)</label>
                <BotonCopiar texto={`${origenApiUrl}/registros/lote`} />
              </div>
              <input type="text" readOnly value={`${origenApiUrl}/registros/lote`} className="campo-codigo" />
              <p className="campo-ayuda">Mismo método y key. El cuerpo es un arreglo JSON de registros: [ {"{…}"}, {"{…}"} ].</p>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
