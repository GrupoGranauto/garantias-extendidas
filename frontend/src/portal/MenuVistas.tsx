import { useCallback, useEffect, useRef, useState } from "react";
import Flotante from "../componentes/Flotante";
import { IconoChevron, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";

type Vista = { id: string; nombre: string; compartida: boolean; propia: boolean; autor: string | null; config: Record<string, unknown> };

type Props = {
  sucursalId: string;
  /** Foto de lo que el usuario tiene puesto ahora (filtros, búsqueda, orden, vista). */
  capturar: () => Record<string, unknown>;
  aplicar: (config: Record<string, unknown>) => void;
  onError: (mensaje: string) => void;
};

/**
 * Vistas guardadas: una combinación de filtros, búsqueda, orden y vista (tabla o embudo) con nombre,
 * para volver a ella en un clic ("Mis pendientes de hoy"). El admin puede compartirlas con el equipo.
 */
export default function MenuVistas({ sucursalId, capturar, aplicar, onError }: Props) {
  const ancla = useRef<HTMLButtonElement>(null);
  const [abierto, setAbierto] = useState(false);
  const [vistas, setVistas] = useState<Vista[]>([]);
  const [nombre, setNombre] = useState("");
  const [compartir, setCompartir] = useState(false);
  const [esAdmin, setEsAdmin] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const base = `/api/admin/sucursales/${sucursalId}/crm/vistas`;

  const cargar = useCallback(() => {
    apiFetch<{ vistas: Vista[] }>(base)
      .then((d) => setVistas(d.vistas))
      .catch(() => setVistas([]));
  }, [base]);

  useEffect(() => {
    cargar();
    apiFetch<{ rol: string }>("/api/perfil")
      .then((p) => setEsAdmin(p.rol === "admin"))
      .catch(() => setEsAdmin(false));
  }, [cargar]);

  async function guardar() {
    const limpio = nombre.trim();
    if (!limpio) return;
    setGuardando(true);
    try {
      await apiFetch(base, { method: "POST", body: JSON.stringify({ nombre: limpio, compartida: esAdmin && compartir, config: capturar() }) });
      setNombre("");
      setCompartir(false);
      cargar();
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo guardar la vista.");
    } finally {
      setGuardando(false);
    }
  }

  async function borrar(v: Vista) {
    try {
      await apiFetch(`${base}/${v.id}`, { method: "DELETE" });
      cargar();
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo borrar la vista.");
    }
  }

  return (
    <>
      <button ref={ancla} type="button" className="boton-secundario-claro pf-accion" onClick={() => setAbierto((v) => !v)} aria-haspopup="menu" aria-expanded={abierto}>
        Vistas{vistas.length > 0 ? ` (${vistas.length})` : ""}
        <IconoChevron className="icono-inline" />
      </button>
      {abierto && (
        <Flotante ancla={ancla} onCerrar={() => setAbierto(false)} anchoMinimo={300} className="pf-visibilidad">
          <div className="pf-visibilidad-titulo">Vistas guardadas</div>
          {vistas.length === 0 && <div className="pf-visibilidad-ayuda">Aún no tienes vistas. Guarda la actual con un nombre.</div>}
          <ul className="vistas-lista">
            {vistas.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className="vistas-aplicar"
                  onClick={() => {
                    aplicar(v.config);
                    setAbierto(false);
                  }}
                >
                  <strong>{v.nombre}</strong>
                  {v.compartida && <small>Del equipo{v.autor ? ` · ${v.autor}` : ""}</small>}
                </button>
                {(v.propia || esAdmin) && (
                  <button type="button" className="auto-quitar" aria-label={`Borrar la vista ${v.nombre}`} onClick={() => borrar(v)}>
                    <IconoXMarca className="icono-inline" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="vistas-guardar">
            <input
              type="text"
              className="auto-input"
              placeholder="Nombre de la vista actual"
              maxLength={60}
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && guardar()}
            />
            {esAdmin && (
              <label className="vistas-compartir">
                <input type="checkbox" checked={compartir} onChange={(e) => setCompartir(e.target.checked)} /> Compartir con todo el equipo
              </label>
            )}
            <button type="button" className="boton-guardar" disabled={guardando || nombre.trim() === ""} onClick={guardar}>
              Guardar vista
            </button>
          </div>
        </Flotante>
      )}
    </>
  );
}
