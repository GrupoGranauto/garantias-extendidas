import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoChat, IconoLlamada, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { MAX_ETIQUETAS, type LugarTarjeta, type VistaTarjeta } from "../lib/vistaTarjeta";

type Campo = { nombre_tecnico: string; nombre_visible: string };
type Respuesta = { vista: VistaTarjeta; por_defecto: VistaTarjeta; campos: Campo[] };

const OPCIONES: [keyof Pick<VistaTarjeta, "avatar" | "ultimo_mensaje" | "tareas" | "llamar">, string][] = [
  ["avatar", "Mostrar avatar del contacto"],
  ["ultimo_mensaje", "Mostrar el último mensaje del contacto"],
  ["tareas", "Mostrar tareas pendientes"],
  ["llamar", "Botón para llamar"],
];

/**
 * Editor de la vista de la tarjeta del embudo (solo admins). Se ve como la tarjeta: cada lugar es una lista para
 * elegir qué campo va ahí. Al guardar, todos los usuarios de la sucursal ven la tarjeta nueva.
 */
export default function EditorTarjeta({ sucursalId, onCerrar, onGuardado }: { sucursalId: string; onCerrar: () => void; onGuardado: () => void }) {
  const base = `/api/admin/sucursales/${sucursalId}/entidad/tarjeta`;
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [vista, setVista] = useState<VistaTarjeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    apiFetch<Respuesta>(base)
      .then((r) => {
        setDatos(r);
        setVista(r.vista);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo leer la vista."));
  }, [base]);

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  async function guardar() {
    if (!vista) return;
    setGuardando(true);
    setError(null);
    try {
      await apiFetch(base, { method: "PUT", body: JSON.stringify(vista) });
      onGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la vista.");
      setGuardando(false);
    }
  }

  const nombre = (n: string) => datos?.campos.find((c) => c.nombre_tecnico === n)?.nombre_visible ?? n;

  function lugar(l: LugarTarjeta, vacio: string, clase = "") {
    if (!vista || !datos) return null;
    return (
      <select
        className={`et-lugar${vista[l] ? "" : " et-lugar-vacio"}${clase ? ` ${clase}` : ""}`}
        value={vista[l] ?? ""}
        aria-label={vacio}
        onChange={(e) => setVista({ ...vista, [l]: e.target.value || null })}
      >
        {l !== "titulo" && <option value="">{vacio}</option>}
        {datos.campos.map((c) => (
          <option key={c.nombre_tecnico} value={c.nombre_tecnico}>
            {c.nombre_visible}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="modal-fondo" onClick={onCerrar}>
      <div className="modal-tarjeta et-modal" role="dialog" aria-modal="true" aria-labelledby="et-titulo" onClick={(e) => e.stopPropagation()}>
        <div className="et-cab">
          <h2 id="et-titulo">Vista de la tarjeta</h2>
          <div className="et-botones">
            <button type="button" className="boton-secundario-claro" onClick={onCerrar}>
              Cancelar
            </button>
            <button type="button" className="boton-guardar" disabled={!vista || guardando} onClick={guardar}>
              {guardando ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
        <p>Elige qué dato va en cada lugar de la tarjeta del embudo. La ven todos los usuarios de la sucursal.</p>

        {!vista || !datos ? (
          error ? <Alerta tipo="error">{error}</Alerta> : <Cargador />
        ) : (
          <>
            <div className="et-opciones">
              {OPCIONES.map(([clave, texto]) => (
                <label key={clave}>
                  <input type="checkbox" checked={vista[clave]} onChange={(e) => setVista({ ...vista, [clave]: e.target.checked })} />
                  {texto}
                </label>
              ))}
            </div>

            <div className="et-lienzo">
              <div className="et-tarjeta">
                {vista.avatar && <span className="embudo-avatar et-avatar">AB</span>}
                <div className="et-cuerpo">
                  <div className="et-fila">
                    {lugar("arriba", "Primera línea")}
                    {lugar("arriba_extra", "Junto a la primera línea")}
                    <span className="et-espacio" />
                    {lugar("esquina", "Esquina")}
                  </div>
                  <div className="et-fila">{lugar("subtitulo", "Segunda línea")}</div>
                  <div className="et-fila">{lugar("titulo", "Nombre", "et-lugar-titulo")}</div>
                  <div className="et-fila">{lugar("detalle", "Debajo del nombre")}</div>
                  <div className="et-fila">
                    {vista.etiquetas.map((e) => (
                      <span key={e} className="embudo-mini et-etiqueta">
                        {nombre(e)}
                        <button
                          type="button"
                          aria-label={`Quitar la etiqueta ${nombre(e)}`}
                          onClick={() => setVista({ ...vista, etiquetas: vista.etiquetas.filter((x) => x !== e) })}
                        >
                          <IconoXMarca className="icono-inline" />
                        </button>
                      </span>
                    ))}
                    {vista.etiquetas.length < MAX_ETIQUETAS && (
                      <select
                        className="et-lugar et-lugar-vacio et-agregar"
                        value=""
                        aria-label="Agregar etiqueta"
                        onChange={(e) => e.target.value && setVista({ ...vista, etiquetas: [...vista.etiquetas, e.target.value] })}
                      >
                        <option value="">+ Etiqueta</option>
                        {datos.campos
                          .filter((c) => !vista.etiquetas.includes(c.nombre_tecnico))
                          .map((c) => (
                            <option key={c.nombre_tecnico} value={c.nombre_tecnico}>
                              {c.nombre_visible}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                  <div className="et-fila et-pie">
                    {lugar("pie", "Pie de la tarjeta")}
                    <span className="et-espacio" />
                    {vista.tareas && <span className="embudo-tareas embudo-tareas-pendientes">Tareas</span>}
                    {vista.llamar && (
                      <span className="embudo-llamar" aria-hidden="true">
                        <IconoLlamada className="icono-inline" />
                      </span>
                    )}
                  </div>
                  {vista.ultimo_mensaje && (
                    <span className="embudo-tarjeta-mensaje et-mensaje">
                      <IconoChat className="embudo-tarjeta-icono" />
                      <span>Último mensaje del contacto</span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {error && <Alerta tipo="error">{error}</Alerta>}
            <button type="button" className="boton-tenue et-restablecer" onClick={() => setVista(datos.por_defecto)}>
              Volver a la vista estándar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
