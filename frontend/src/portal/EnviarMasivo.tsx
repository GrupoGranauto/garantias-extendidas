import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";

type Vista = { encabezado: string | null; cuerpo: string; pie: string | null; botones: string[] };
type Plantilla = { id: string; nombre: string; no_usable: string | null; vista: Vista | null };
type Revision = {
  enviar: number;
  omitidos: { motivo: string; texto: string; n: number }[];
  ejemplo: (Vista & { cliente: string | null }) | null;
  sale: { fecha: string; hora: string } | null;
  horario: { inicio: string; fin: string };
};

type Props = {
  sucursalId: string;
  ids: string[];
  /** A quién va, dicho para el admin (las filas elegidas o las del filtro). */
  descripcion?: string;
  onCerrar: () => void;
  /** El masivo quedó en cola: recarga y muestra el mensaje. */
  onEnviado: (mensaje: string) => void;
};

const fechaLarga = (f: string) => new Date(`${f}T00:00:00`).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });

/** El mensaje como lo ve el cliente en WhatsApp. */
export function BurbujaMensaje({ vista }: { vista: Vista }) {
  return (
    <div className="masivo-chat">
      <div className="burbuja-whatsapp">
        {vista.encabezado && <div className="burbuja-header">{vista.encabezado}</div>}
        <div className="burbuja-cuerpo">{vista.cuerpo}</div>
        {vista.pie && <div className="burbuja-footer">{vista.pie}</div>}
        {vista.botones.length > 0 && (
          <div className="burbuja-botones">
            {vista.botones.map((b) => (
              <div key={b} className="burbuja-boton">
                {b}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Masivo manual: el admin elige una plantilla aprobada para las filas que marcó. Antes de mandar ve a cuántos les llega,
 * a quién se omite y por qué, y el mensaje con los datos de una persona real. Al confirmar, la web lo manda en segundo plano.
 */
export default function EnviarMasivo({ sucursalId, ids, descripcion, onCerrar, onEnviado }: Props) {
  const base = `/api/admin/sucursales/${sucursalId}/crm/masivos`;
  const [plantillas, setPlantillas] = useState<Plantilla[] | null>(null);
  const [plantillaId, setPlantillaId] = useState("");
  const [revision, setRevision] = useState<Revision | null>(null);
  const [revisando, setRevisando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    apiFetch<{ plantillas: Plantilla[] }>(`${base}/plantillas`)
      .then((d) => setPlantillas(d.plantillas))
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las plantillas."));
  }, [base]);

  const elegida = plantillas?.find((p) => p.id === plantillaId) ?? null;

  useEffect(() => {
    setRevision(null);
    setError(null);
    if (!elegida || elegida.no_usable) return;
    let vigente = true;
    setRevisando(true);
    apiFetch<Revision>(`${base}/revisar`, { method: "POST", body: JSON.stringify({ ids, plantilla_id: elegida.id }) })
      .then((r) => vigente && setRevision(r))
      .catch((err) => vigente && setError(err instanceof Error ? err.message : "No se pudo revisar el envío."))
      .finally(() => vigente && setRevisando(false));
    return () => {
      vigente = false;
    };
  }, [base, ids, elegida]);

  async function enviar() {
    if (!elegida || !revision) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await apiFetch<Revision>(base, { method: "POST", body: JSON.stringify({ ids, plantilla_id: elegida.id }) });
      onEnviado(
        r.sale
          ? `Masivo programado: ${r.enviar} mensaje(s) saldrán el ${fechaLarga(r.sale.fecha)} a las ${r.sale.hora}.`
          : `Masivo en camino: ${r.enviar} mensaje(s).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo enviar el masivo.");
      setEnviando(false);
    }
  }

  const usables = plantillas?.filter((p) => !p.no_usable) ?? [];
  const noUsables = plantillas?.filter((p) => p.no_usable) ?? [];
  const omitidos = revision?.omitidos.reduce((n, o) => n + o.n, 0) ?? 0;

  return (
    <div className="modal-fondo" onClick={enviando ? undefined : onCerrar}>
      <div className="modal-tarjeta masivo-modal" role="dialog" aria-modal="true" aria-labelledby="masivo-titulo" onClick={(e) => e.stopPropagation()}>
        <h2 id="masivo-titulo">Enviar WhatsApp</h2>
        <p>
          {descripcion ?? `${ids.length.toLocaleString("es-MX")} ${ids.length === 1 ? "fila elegida" : "filas elegidas"}.`} Solo se pueden mandar plantillas
          aprobadas por Meta.
        </p>

        {!plantillas && !error && <Cargador />}

        {plantillas && (
          <label className="auto-campo masivo-campo">
            <span>Plantilla</span>
            <select className="auto-input" value={plantillaId} onChange={(e) => setPlantillaId(e.target.value)} disabled={enviando}>
              <option value="">Elige una plantilla</option>
              {usables.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
              {noUsables.length > 0 && (
                <optgroup label="No se pueden mandar">
                  {noUsables.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        )}
        {plantillas && plantillas.length === 0 && <Alerta tipo="info">No hay plantillas aprobadas todavía. Créalas en «Plantillas».</Alerta>}
        {elegida?.no_usable && <Alerta tipo="error">{elegida.no_usable}</Alerta>}
        {error && <Alerta tipo="error">{error}</Alerta>}
        {revisando && <Cargador />}

        {revision && (
          <div className="masivo-resumen">
            <p className="masivo-total">
              {revision.enviar > 0 ? (
                <>
                  Le llegará a <strong>{revision.enviar.toLocaleString("es-MX")}</strong> {revision.enviar === 1 ? "persona" : "personas"}.
                </>
              ) : (
                <>Ninguna de las filas elegidas puede recibir el mensaje.</>
              )}
            </p>
            {omitidos > 0 && (
              <ul className="masivo-omitidos">
                {revision.omitidos.map((o) => (
                  <li key={o.motivo}>
                    Se omiten <strong>{o.n.toLocaleString("es-MX")}</strong>: {o.texto}.
                  </li>
                ))}
              </ul>
            )}
            {revision.sale && revision.enviar > 0 && (
              <Alerta tipo="info">
                Los mensajes salen de {revision.horario.inicio} a {revision.horario.fin} (hora de Hermosillo). Empezarán el {fechaLarga(revision.sale.fecha)} a las{" "}
                {revision.sale.hora}.
              </Alerta>
            )}
            {revision.ejemplo && (
              <>
                <span className="masivo-ejemplo-titulo">Así le llega{revision.ejemplo.cliente ? ` a ${revision.ejemplo.cliente}` : ""}:</span>
                <BurbujaMensaje vista={revision.ejemplo} />
              </>
            )}
          </div>
        )}

        <div className="modal-acciones">
          <button type="button" className="boton-secundario-claro" onClick={onCerrar} disabled={enviando}>
            Cancelar
          </button>
          <button type="button" className="boton-guardar" disabled={!revision || revision.enviar === 0 || enviando || revisando} onClick={enviar}>
            {enviando ? "Enviando…" : revision && revision.enviar > 0 ? `Enviar a ${revision.enviar.toLocaleString("es-MX")}` : "Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}
