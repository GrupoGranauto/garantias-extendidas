import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Tipo = "texto" | "entero" | "decimal" | "booleano" | "fecha" | "fecha_hora" | "uuid";
type Origen = "api" | "back";
type Opcion = { valor: string; color: string };

type CampoServidor = {
  nombre_tecnico: string;
  nombre_visible: string;
  tipo: Tipo;
  posicion: number;
  origen: Origen;
  editor_tipo: "texto" | "lista";
  opciones: Opcion[] | null;
};

type Fila = Record<string, unknown>;

type Respuesta =
  | { configurado: false }
  | {
      configurado: true;
      nombre_visible: string;
      campos: CampoServidor[];
      filas: Fila[];
      total: number;
      pagina: number;
      limite: number;
    };

function formatearValor(valor: unknown, tipo: Tipo): string {
  if (valor === null || valor === undefined || valor === "") return "—";
  if (tipo === "booleano") return valor ? "Sí" : "No";
  if (tipo === "fecha") return new Date(String(valor) + "T00:00:00").toLocaleDateString();
  if (tipo === "fecha_hora") return new Date(String(valor)).toLocaleString();
  return String(valor);
}

/** 'YYYY-MM-DD' para <input type="date">, desde una fecha o datetime. */
function aValorFecha(valor: unknown): string {
  if (!valor) return "";
  return String(valor).slice(0, 10);
}

function Chip({ texto, color }: { texto: string; color: string }) {
  return (
    <span style={{ background: color, color: "#fff", borderRadius: 999, padding: "2px 10px", fontSize: 12, whiteSpace: "nowrap" }}>
      {texto}
    </span>
  );
}

/** Los datos de la entidad de la sucursal. Los campos que captura la app son editables. */
export default function BaseDatos() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ediciones pendientes por fila: { rowId: { campo: valor } }
  const [ediciones, setEdiciones] = useState<Record<string, Record<string, string>>>({});
  const [guardandoId, setGuardandoId] = useState<string | null>(null);

  function cargar() {
    setError(null);
    apiFetch<Respuesta>(`/api/admin/sucursales/${sucursalId}/entidad/registros?pagina=${pagina}&limite=50`)
      .then((d) => {
        setDatos(d);
        setEdiciones({});
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la información."));
  }

  useEffect(cargar, [sucursalId, pagina]);

  function editar(rowId: string, campo: string, valor: string) {
    setEdiciones((prev) => ({ ...prev, [rowId]: { ...prev[rowId], [campo]: valor } }));
  }

  function valorActual(fila: Fila, campo: CampoServidor): string {
    const id = String(fila.id);
    const editado = ediciones[id]?.[campo.nombre_tecnico];
    if (editado !== undefined) return editado;
    const original = fila[campo.nombre_tecnico];
    if (campo.tipo === "fecha") return aValorFecha(original);
    return original === null || original === undefined ? "" : String(original);
  }

  async function guardarFila(rowId: string) {
    const cambios = ediciones[rowId];
    if (!cambios || Object.keys(cambios).length === 0) return;
    setGuardandoId(rowId);
    setError(null);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/entidad/registros/${rowId}`, {
        method: "PATCH",
        body: JSON.stringify(cambios),
      });
      // Reflejar en memoria y limpiar edición de esa fila.
      setDatos((prev) => {
        if (!prev || !prev.configurado) return prev;
        return {
          ...prev,
          filas: prev.filas.map((f) => (String(f.id) === rowId ? { ...f, ...cambios } : f)),
        };
      });
      setEdiciones((prev) => {
        const copia = { ...prev };
        delete copia[rowId];
        return copia;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el registro.");
    } finally {
      setGuardandoId(null);
    }
  }

  function celdaEditable(fila: Fila, campo: CampoServidor) {
    const id = String(fila.id);
    const valor = valorActual(fila, campo);

    if (campo.tipo === "fecha") {
      return <input type="date" value={valor} onChange={(e) => editar(id, campo.nombre_tecnico, e.target.value)} />;
    }
    if (campo.tipo === "texto" && campo.editor_tipo === "lista") {
      const opciones = campo.opciones ?? [];
      const color = opciones.find((o) => o.valor === valor)?.color;
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select value={valor} onChange={(e) => editar(id, campo.nombre_tecnico, e.target.value)}>
            <option value="">—</option>
            {opciones.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.valor}
              </option>
            ))}
          </select>
          {valor && color && <Chip texto={valor} color={color} />}
        </div>
      );
    }
    return (
      <input
        type="text"
        value={valor}
        onChange={(e) => editar(id, campo.nombre_tecnico, e.target.value)}
        placeholder="—"
      />
    );
  }

  return (
    <div className="pagina-formulario">
      <header className="pagina-cabecera">
        <div>
          <h1>Base de datos</h1>
          <p>Los campos que captura el personal se pueden editar; los de la fuente son solo lectura.</p>
        </div>
      </header>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {!datos && !error && <Cargador />}

      {datos && !datos.configurado && (
        <div className="marcador">
          <strong>Todavía no hay una base de datos para tu sucursal</strong>
          <span>Cuando el administrador de la plataforma la dé de alta, aparecerá aquí.</span>
        </div>
      )}

      {datos?.configurado && datos.filas.length === 0 && (
        <div className="marcador">
          <strong>{datos.nombre_visible}</strong>
          <span>Todavía no hay registros.</span>
        </div>
      )}

      {datos?.configurado && datos.filas.length > 0 && (
        <>
          <div className="tabla-envoltura">
            <table className="tabla">
              <thead>
                <tr>
                  {datos.campos.map((c) => (
                    <th key={c.nombre_tecnico}>{c.nombre_visible}</th>
                  ))}
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {datos.filas.map((fila) => {
                  const id = String(fila.id);
                  const sucia = Boolean(ediciones[id] && Object.keys(ediciones[id]).length > 0);
                  return (
                    <tr key={id}>
                      {datos.campos.map((c) => (
                        <td key={c.nombre_tecnico}>
                          {c.origen === "back"
                            ? celdaEditable(fila, c)
                            : c.tipo === "texto" && c.editor_tipo === "lista"
                              ? (() => {
                                  const v = fila[c.nombre_tecnico];
                                  const color = (c.opciones ?? []).find((o) => o.valor === v)?.color;
                                  return v && color ? <Chip texto={String(v)} color={color} /> : formatearValor(v, c.tipo);
                                })()
                              : formatearValor(fila[c.nombre_tecnico], c.tipo)}
                        </td>
                      ))}
                      <td>
                        {sucia && (
                          <button
                            type="button"
                            className="boton-guardar"
                            disabled={guardandoId === id}
                            onClick={() => guardarFila(id)}
                          >
                            {guardandoId === id ? "…" : "Guardar"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <footer className="barra-acciones">
            <p>
              {(datos.pagina - 1) * datos.limite + 1}–{Math.min(datos.pagina * datos.limite, datos.total)} de {datos.total}
            </p>
            <div className="pagina-acciones">
              <button
                type="button"
                className="boton-secundario-claro"
                disabled={pagina <= 1}
                onClick={() => setPagina((p) => p - 1)}
              >
                Anterior
              </button>
              <button
                type="button"
                className="boton-secundario-claro"
                disabled={datos.pagina * datos.limite >= datos.total}
                onClick={() => setPagina((p) => p + 1)}
              >
                Siguiente
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
