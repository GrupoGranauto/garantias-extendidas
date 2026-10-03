import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoCalendario } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { useSucursal } from "./SucursalEditLayout";

type EditorTipo = "texto" | "lista";
type Opcion = { valor: string; color: string };

type CampoServidor = {
  nombre_tecnico: string;
  nombre_visible: string;
  tipo: string;
  editor_tipo: EditorTipo;
  opciones: Opcion[] | null;
};

type Campo = {
  nombre_tecnico: string;
  nombre_visible: string;
  tipo: string;
  editor_tipo: EditorTipo;
  opciones: Opcion[];
};

const COLOR_POR_DEFECTO = "#493f91";

export default function SucursalCamposEditables() {
  const { sucursal } = useSucursal();

  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [configurado, setConfigurado] = useState(true);
  const [campos, setCampos] = useState<Campo[]>([]);

  useEffect(() => {
    apiFetch<{ configurado: boolean; campos: CampoServidor[] }>(
      `/api/admin/sucursales/${sucursal.id}/entidad/campos-editables`,
    )
      .then((r) => {
        setConfigurado(r.configurado);
        setCampos(
          (r.campos ?? []).map((c) => ({
            nombre_tecnico: c.nombre_tecnico,
            nombre_visible: c.nombre_visible,
            tipo: c.tipo,
            editor_tipo: c.editor_tipo ?? "texto",
            opciones: c.opciones ?? [],
          })),
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la configuración."))
      .finally(() => setCargando(false));
  }, [sucursal.id]);

  function actualizar(nombre: string, cambios: Partial<Campo>) {
    setCampos((prev) => prev.map((c) => (c.nombre_tecnico === nombre ? { ...c, ...cambios } : c)));
    setGuardado(false);
  }

  function agregarOpcion(nombre: string) {
    setCampos((prev) =>
      prev.map((c) =>
        c.nombre_tecnico === nombre
          ? { ...c, opciones: [...c.opciones, { valor: "", color: COLOR_POR_DEFECTO }] }
          : c,
      ),
    );
  }

  function cambiarOpcion(nombre: string, indice: number, cambios: Partial<Opcion>) {
    setCampos((prev) =>
      prev.map((c) =>
        c.nombre_tecnico === nombre
          ? { ...c, opciones: c.opciones.map((o, i) => (i === indice ? { ...o, ...cambios } : o)) }
          : c,
      ),
    );
  }

  function quitarOpcion(nombre: string, indice: number) {
    setCampos((prev) =>
      prev.map((c) =>
        c.nombre_tecnico === nombre ? { ...c, opciones: c.opciones.filter((_, i) => i !== indice) } : c,
      ),
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Solo los campos de texto se configuran; las fechas usan calendario fijo.
    const texto = campos.filter((c) => c.tipo === "texto");
    for (const c of texto) {
      if (c.editor_tipo === "lista") {
        if (c.opciones.length === 0) {
          setError(`"${c.nombre_visible}" es lista pero no tiene opciones.`);
          return;
        }
        if (c.opciones.some((o) => !o.valor.trim())) {
          setError(`"${c.nombre_visible}" tiene una opción sin texto.`);
          return;
        }
      }
    }

    setEnviando(true);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursal.id}/entidad/campos-editables`, {
        method: "PUT",
        body: JSON.stringify({
          campos: texto.map((c) => ({
            nombre_tecnico: c.nombre_tecnico,
            editor_tipo: c.editor_tipo,
            opciones: c.editor_tipo === "lista" ? c.opciones.map((o) => ({ valor: o.valor.trim(), color: o.color })) : [],
          })),
        }),
      });
      setGuardado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setEnviando(false);
    }
  }

  if (cargando) return <Cargador />;

  return (
    <form onSubmit={onSubmit}>
      <p className="pestana-descripcion">
        Define cómo se capturan en la tabla los campos que llena el personal (no los que vienen de la fuente).
        Las fechas siempre usan calendario; los de texto pueden ser texto libre o una lista de opciones con color.
      </p>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}
      {guardado && (
        <div className="aviso-formulario">
          <Alerta tipo="ok">Configuración guardada.</Alerta>
        </div>
      )}

      {!configurado && (
        <div className="marcador">
          <strong>Primero define la entidad</strong>
          <span>Crea la tabla en la pestaña «Base de datos» para poder configurar sus campos editables.</span>
        </div>
      )}

      {configurado && campos.length === 0 && (
        <div className="marcador">
          <strong>No hay campos editables</strong>
          <span>Esta entidad no tiene campos de origen «Back» (los que captura el personal).</span>
        </div>
      )}

      {campos.map((campo) => (
        <section className="seccion" key={campo.nombre_tecnico}>
          <div className="seccion-info">
            <h2>{campo.nombre_visible}</h2>
            <p>
              <code>{campo.nombre_tecnico}</code>
            </p>
          </div>
          <div className="seccion-campos">
            {campo.tipo === "fecha" ? (
              <p className="campo-ayuda" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IconoCalendario className="icono-inline" /> Fecha — se edita con <strong>calendario</strong> (no configurable).
              </p>
            ) : campo.tipo !== "texto" ? (
              <p className="campo-ayuda">
                Tipo <strong>{campo.tipo}</strong> — se edita directo, sin configuración.
              </p>
            ) : (
              <>
                <div className="campo-formulario">
                  <label htmlFor={`tipo-${campo.nombre_tecnico}`}>¿Cómo se captura?</label>
                  <select
                    id={`tipo-${campo.nombre_tecnico}`}
                    value={campo.editor_tipo}
                    onChange={(e) => actualizar(campo.nombre_tecnico, { editor_tipo: e.target.value as EditorTipo })}
                  >
                    <option value="texto">Texto libre</option>
                    <option value="lista">Lista desplegable</option>
                  </select>
                </div>

                {campo.editor_tipo === "lista" && (
                  <div className="campo-formulario">
                    <label>Opciones (etiquetas)</label>
                    {campo.opciones.map((op, i) => (
                      <div className="fila-opcion-etiqueta" key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                        <input
                          type="color"
                          value={op.color}
                          onChange={(e) => cambiarOpcion(campo.nombre_tecnico, i, { color: e.target.value })}
                          title="Color de la etiqueta"
                          style={{ width: 44, height: 36, padding: 2, flex: "0 0 auto" }}
                        />
                        <input
                          type="text"
                          value={op.valor}
                          onChange={(e) => cambiarOpcion(campo.nombre_tecnico, i, { valor: e.target.value })}
                          placeholder="Nombre de la opción"
                          style={{ flex: 1 }}
                        />
                        <span className="etiqueta-chip" style={{ "--chip": op.color } as CSSProperties}>
                          {op.valor || "Ejemplo"}
                        </span>
                        <button
                          type="button"
                          className="boton-tenue"
                          onClick={() => quitarOpcion(campo.nombre_tecnico, i)}
                          aria-label="Quitar opción"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <div>
                      <button type="button" className="boton-tenue" onClick={() => agregarOpcion(campo.nombre_tecnico)}>
                        + Agregar opción
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      ))}

      {configurado && campos.some((c) => c.tipo === "texto") && (
        <footer className="barra-acciones">
          <div className="pagina-acciones">
            <button type="submit" className="boton-guardar" disabled={enviando}>
              {enviando ? "Guardando…" : "Guardar cambios"}
            </button>
          </div>
        </footer>
      )}
    </form>
  );
}
