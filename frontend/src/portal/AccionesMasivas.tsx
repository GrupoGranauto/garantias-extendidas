import { useState } from "react";
import { apiFetch } from "../lib/api";

type Opcion = { valor: string; color: string; tipo?: string };

type Props = {
  sucursalId: string;
  ids: string[];
  etapas: Opcion[];
  motivos: Opcion[];
  ejecutivos: Opcion[];
  /** Termina una acción: recarga y muestra el mensaje. */
  onListo: (mensaje: string) => void;
  onError: (mensaje: string) => void;
  onLimpiar: () => void;
  /** Filas que cumplen el filtro actual: si son más que las elegidas, se ofrece elegirlas todas. */
  total?: number;
  onElegirTodas?: () => void;
  /** Solo el admin: manda una plantilla de WhatsApp a las filas elegidas. */
  onEnviarPlantilla?: () => void;
};

type Panel = "etapa" | "ejecutivo" | "tarea" | null;

/**
 * Barra de acciones sobre las filas elegidas: cambiar de etapa, reasignar ejecutivo o crear una tarea
 * para cada una. Se aplica todo o nada; las filas que el usuario no puede tocar se cuentan como omitidas.
 * El admin además puede mandarles una plantilla de WhatsApp (masivo).
 */
export default function AccionesMasivas({
  sucursalId,
  ids,
  etapas,
  motivos,
  ejecutivos,
  onListo,
  onError,
  onLimpiar,
  total,
  onElegirTodas,
  onEnviarPlantilla,
}: Props) {
  const [panel, setPanel] = useState<Panel>(null);
  const [etapa, setEtapa] = useState(etapas[0]?.valor ?? "");
  const [motivo, setMotivo] = useState("");
  const [ejecutivo, setEjecutivo] = useState(ejecutivos[0]?.valor ?? "");
  const [titulo, setTitulo] = useState("");
  const [horas, setHoras] = useState("24");
  const [enviando, setEnviando] = useState(false);

  const esPerdida = etapas.find((e) => e.valor === etapa)?.tipo === "perdida";

  async function aplicar(accion: Record<string, unknown>, verbo: string) {
    setEnviando(true);
    try {
      const r = await apiFetch<{ afectadas: number; omitidas: number }>(`/api/admin/sucursales/${sucursalId}/crm/masivo`, {
        method: "POST",
        body: JSON.stringify({ ids, accion }),
      });
      onListo(`${verbo}: ${r.afectadas}${r.omitidas > 0 ? ` (${r.omitidas} omitidas)` : ""}`);
      setPanel(null);
      setTitulo("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo aplicar la acción.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="masivo" role="region" aria-label="Acciones sobre la selección">
      <div className="masivo-fila">
        <strong>
          {ids.length.toLocaleString("es-MX")} {ids.length === 1 ? "seleccionada" : "seleccionadas"}
        </strong>
        {onElegirTodas && total !== undefined && total > ids.length && (
          <button type="button" className="boton-tenue" onClick={onElegirTodas}>
            Elegir las {total.toLocaleString("es-MX")} del filtro
          </button>
        )}
        {onEnviarPlantilla && (
          <button type="button" className="boton-guardar" onClick={onEnviarPlantilla}>
            Enviar plantilla
          </button>
        )}
        <button type="button" className="boton-secundario-claro" onClick={() => setPanel(panel === "etapa" ? null : "etapa")}>
          Cambiar estado del lead
        </button>
        <button type="button" className="boton-secundario-claro" onClick={() => setPanel(panel === "ejecutivo" ? null : "ejecutivo")}>
          Reasignar
        </button>
        <button type="button" className="boton-secundario-claro" onClick={() => setPanel(panel === "tarea" ? null : "tarea")}>
          Crear tarea
        </button>
        <button type="button" className="boton-tenue" onClick={onLimpiar}>
          Quitar selección
        </button>
      </div>

      {panel === "etapa" && (
        <div className="masivo-fila">
          <select className="auto-input" value={etapa} onChange={(e) => setEtapa(e.target.value)} aria-label="Estado del lead destino">
            {etapas.map((e) => (
              <option key={e.valor} value={e.valor}>
                {e.valor}
              </option>
            ))}
          </select>
          {esPerdida && (
            <select className="auto-input" value={motivo} onChange={(e) => setMotivo(e.target.value)} aria-label="Motivo de pérdida">
              <option value="">Sin motivo</option>
              {motivos.map((m) => (
                <option key={m.valor} value={m.valor}>
                  {m.valor}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="boton-guardar"
            disabled={enviando || !etapa}
            onClick={() => aplicar({ accion: "etapa", etapa, motivo: esPerdida && motivo ? motivo : null }, "Movidas")}
          >
            Mover {ids.length}
          </button>
        </div>
      )}

      {panel === "ejecutivo" && (
        <div className="masivo-fila">
          <select className="auto-input" value={ejecutivo} onChange={(e) => setEjecutivo(e.target.value)} aria-label="Ejecutivo destino">
            {ejecutivos.map((e) => (
              <option key={e.valor} value={e.valor}>
                {e.valor}
              </option>
            ))}
          </select>
          <button type="button" className="boton-guardar" disabled={enviando || !ejecutivo} onClick={() => aplicar({ accion: "ejecutivo", ejecutivo }, "Reasignadas")}>
            Reasignar {ids.length}
          </button>
        </div>
      )}

      {panel === "tarea" && (
        <div className="masivo-fila">
          <input type="text" className="auto-input masivo-titulo" placeholder="Título de la tarea" maxLength={160} value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          <input type="number" min={0} className="auto-input masivo-horas" placeholder="Horas" value={horas} onChange={(e) => setHoras(e.target.value)} aria-label="Vence en horas" />
          <button
            type="button"
            className="boton-guardar"
            disabled={enviando || titulo.trim() === ""}
            onClick={() => aplicar({ accion: "tarea", titulo: titulo.trim(), vence_horas: horas === "" ? null : Math.max(0, Math.floor(Number(horas))) }, "Tareas creadas")}
          >
            Crear {ids.length}
          </button>
        </div>
      )}
    </div>
  );
}
