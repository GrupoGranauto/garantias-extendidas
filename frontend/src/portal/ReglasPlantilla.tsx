import { useState } from "react";
import Alerta from "../componentes/Alerta";
import { apiFetch } from "../lib/api";

type Opcion = { valor: string; etiqueta: string; color?: string };
export type CatalogoReglas = { campanas: Opcion[]; estados: Opcion[]; resultados: Opcion[]; etapas_vehiculo: Opcion[] };
export type Reglas = { campanas: string[]; estados: string[]; resultados: string[]; etapas_vehiculo: string[] };

export const SIN_REGLAS: Reglas = { campanas: [], estados: [], resultados: [], etapas_vehiculo: [] };

const GRUPOS: { clave: keyof Reglas; titulo: string; vacio: string }[] = [
  { clave: "campanas", titulo: "Campañas", vacio: "Sin campaña marcada, la plantilla es general: sirve para cualquiera." },
  { clave: "estados", titulo: "Estado del lead", vacio: "Sin marcar, cualquier estado." },
  { clave: "resultados", titulo: "Resultado BDC", vacio: "Sin marcar, cualquier resultado." },
  { clave: "etapas_vehiculo", titulo: "Etapa del vehículo", vacio: "Sin marcar, cualquier etapa." },
];

/** «12 meses · Por contactar» o «General · cualquier estado», más el resultado y la etapa del vehículo si los tiene. */
export function resumenReglas(r: Reglas | undefined, c: CatalogoReglas): string {
  const reglas = r ?? SIN_REGLAS;
  const nombres = (valores: string[], opciones: Opcion[]) => valores.map((v) => opciones.find((o) => o.valor === v)?.etiqueta ?? v).join(", ");
  return [
    reglas.campanas.length > 0 ? nombres(reglas.campanas, c.campanas) : "General",
    reglas.estados.length > 0 ? nombres(reglas.estados, c.estados) : "cualquier estado",
    reglas.resultados.length > 0 ? `Resultado: ${nombres(reglas.resultados, c.resultados)}` : null,
    reglas.etapas_vehiculo.length > 0 ? `Vehículo: ${nombres(reglas.etapas_vehiculo, c.etapas_vehiculo)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

type Props = {
  sucursalId: string;
  plantilla: { id: string; nombre: string };
  catalogo: CatalogoReglas;
  inicial: Reglas | undefined;
  onCerrar: () => void;
  onGuardado: (r: Reglas) => void;
};

/**
 * A quién se le puede mandar una plantilla en un masivo: sus campañas, estados del lead, Resultado BDC y etapa del
 * vehículo. Al enviar, a quien no le corresponde se le omite.
 */
export default function ReglasPlantilla({ sucursalId, plantilla, catalogo, inicial, onCerrar, onGuardado }: Props) {
  const [reglas, setReglas] = useState<Reglas>(inicial ?? SIN_REGLAS);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alternar = (clave: keyof Reglas, valor: string) =>
    setReglas((r) => ({ ...r, [clave]: r[clave].includes(valor) ? r[clave].filter((v) => v !== valor) : [...r[clave], valor] }));

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/crm/masivos/plantillas/${plantilla.id}/reglas`, { method: "PUT", body: JSON.stringify(reglas) });
      onGuardado(reglas);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
      setGuardando(false);
    }
  }

  return (
    <div className="modal-fondo" onClick={guardando ? undefined : onCerrar}>
      <div className="modal-tarjeta reglas-modal" role="dialog" aria-modal="true" aria-labelledby="reglas-titulo" onClick={(e) => e.stopPropagation()}>
        <h2 id="reglas-titulo">A quién se manda «{plantilla.nombre}»</h2>
        <p>Al enviar un masivo, esta plantilla solo les llega a los leads que cumplan todo lo que marques aquí. A los demás se les omite.</p>

        {GRUPOS.map((g) => (
          <fieldset key={g.clave} className="reglas-grupo">
            <legend>{g.titulo}</legend>
            {catalogo[g.clave].length === 0 ? (
              <small>No hay opciones en este grupo.</small>
            ) : (
              <div className="reglas-opciones">
                {catalogo[g.clave].map((o) => (
                  <label key={o.valor} className={`reglas-opcion${reglas[g.clave].includes(o.valor) ? " reglas-opcion-activa" : ""}`}>
                    <input type="checkbox" checked={reglas[g.clave].includes(o.valor)} onChange={() => alternar(g.clave, o.valor)} disabled={guardando} />
                    {o.etiqueta}
                  </label>
                ))}
              </div>
            )}
            {reglas[g.clave].length === 0 && <small>{g.vacio}</small>}
          </fieldset>
        ))}

        {error && <Alerta tipo="error">{error}</Alerta>}

        <div className="modal-acciones">
          <button type="button" className="boton-secundario-claro" onClick={onCerrar} disabled={guardando}>
            Cancelar
          </button>
          <button type="button" className="boton-guardar" onClick={guardar} disabled={guardando}>
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}
