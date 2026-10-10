import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";

type Vista = { encabezado: string | null; cuerpo: string; pie: string | null; botones: string[] };
type Reglas = { campanas: string[]; estados: string[]; resultados: string[]; etapasVehiculo: string[] };
type Plantilla = { id: string; nombre: string; no_usable: string | null; vista: Vista | null; reglas: Reglas; coinciden: number };
type Opciones = {
  plantillas: Plantilla[];
  campanas: { valor: string; etiqueta: string; n: number }[];
  estados: { id: string; nombre: string; color: string }[];
  etapas_vehiculo: { id: string; nombre: string }[];
};

/** El filtro rápido «Generales»: plantillas sin campaña, sirven para cualquiera. */
const GENERALES = "__generales";
const capitalizar = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();
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
 * Masivo manual: el admin elige una plantilla aprobada para las filas que marcó. Arriba, un filtro rápido por campaña; en
 * cada campaña, sus plantillas agrupadas por estado del lead. A quien no le corresponde la plantilla (otra campaña, otro
 * estado…) se le omite. Antes de mandar ve a cuántos les llega, a quién se omite y por qué, y el mensaje con los datos de
 * una persona real. Al confirmar, la web lo manda en segundo plano.
 */
export default function EnviarMasivo({ sucursalId, ids, descripcion, onCerrar, onEnviado }: Props) {
  const base = `/api/admin/sucursales/${sucursalId}/crm/masivos`;
  const [opciones, setOpciones] = useState<Opciones | null>(null);
  const [campana, setCampana] = useState<string>(GENERALES);
  const [plantillaId, setPlantillaId] = useState("");
  const [revision, setRevision] = useState<Revision | null>(null);
  const [revisando, setRevisando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    apiFetch<Opciones>(`${base}/opciones`, { method: "POST", body: JSON.stringify({ ids }) })
      .then((d) => {
        setOpciones(d);
        // Arranca en la campaña con más filas elegidas; si ninguna tiene campaña, en las generales.
        const mayor = [...d.campanas].sort((a, b) => b.n - a.n)[0];
        setCampana(mayor && mayor.n > 0 ? mayor.valor : GENERALES);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las plantillas."));
  }, [base, ids]);

  const plantillas = opciones?.plantillas ?? null;
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

  const omitidos = revision?.omitidos.reduce((n, o) => n + o.n, 0) ?? 0;

  // Plantillas de la campaña elegida (o las generales), agrupadas por los estados del lead a los que van.
  const ordenEstado = new Map((opciones?.estados ?? []).map((e, i) => [e.id, i]));
  const nombreEstado = new Map((opciones?.estados ?? []).map((e) => [e.id, e.nombre]));
  const nombreEtapa = new Map((opciones?.etapas_vehiculo ?? []).map((e) => [e.id, e.nombre]));
  const deCampana = (plantillas ?? []).filter((p) => (campana === GENERALES ? p.reglas.campanas.length === 0 : p.reglas.campanas.includes(campana)));
  const grupos = new Map<string, { orden: number; titulo: string; plantillas: Plantilla[] }>();
  for (const p of deCampana) {
    const estados = [...p.reglas.estados].sort((a, b) => (ordenEstado.get(a) ?? 99) - (ordenEstado.get(b) ?? 99));
    const clave = estados.join(",") || "*";
    const grupo = grupos.get(clave) ?? {
      orden: estados.length > 0 ? (ordenEstado.get(estados[0]) ?? 99) : 1000,
      titulo: estados.length > 0 ? estados.map((e) => nombreEstado.get(e) ?? "Estado").join(", ") : "Cualquier estado",
      plantillas: [],
    };
    grupo.plantillas.push(p);
    grupos.set(clave, grupo);
  }
  const ordenados = [...grupos.values()].sort((a, b) => a.orden - b.orden);
  const generales = (plantillas ?? []).filter((p) => p.reglas.campanas.length === 0).length;

  const otrasReglas = (r: Reglas) =>
    [
      r.resultados.length > 0 ? `Resultado: ${r.resultados.map(capitalizar).join(", ")}` : null,
      r.etapasVehiculo.length > 0 ? `Vehículo: ${r.etapasVehiculo.map((e) => nombreEtapa.get(e) ?? "Etapa").join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  function elegirCampana(c: string) {
    setCampana(c);
    setPlantillaId("");
  }

  return (
    <div className="modal-fondo" onClick={enviando ? undefined : onCerrar}>
      <div className="modal-tarjeta masivo-modal" role="dialog" aria-modal="true" aria-labelledby="masivo-titulo" onClick={(e) => e.stopPropagation()}>
        <h2 id="masivo-titulo">Enviar WhatsApp</h2>
        <p>
          {descripcion ?? `${ids.length.toLocaleString("es-MX")} ${ids.length === 1 ? "fila elegida" : "filas elegidas"}.`} Solo se pueden mandar plantillas
          aprobadas por Meta.
        </p>

        {!opciones && !error && <Cargador />}

        {opciones && (
          <>
            <div className="masivo-campanas" role="tablist" aria-label="Campaña">
              {opciones.campanas.map((c) => (
                <button
                  key={c.valor}
                  type="button"
                  role="tab"
                  aria-selected={campana === c.valor}
                  className={`masivo-chip${campana === c.valor ? " masivo-chip-activo" : ""}`}
                  onClick={() => elegirCampana(c.valor)}
                  disabled={enviando}
                >
                  {c.etiqueta}
                  {c.n > 0 && <span>{c.n.toLocaleString("es-MX")}</span>}
                </button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected={campana === GENERALES}
                className={`masivo-chip${campana === GENERALES ? " masivo-chip-activo" : ""}`}
                onClick={() => elegirCampana(GENERALES)}
                disabled={enviando}
              >
                Generales
                {generales > 0 && <span>{generales}</span>}
              </button>
            </div>

            {ordenados.length === 0 && (
              <p className="masivo-vacio">
                {campana === GENERALES
                  ? "No hay plantillas generales. Las plantillas sin campaña asignada aparecen aquí."
                  : "Esta campaña todavía no tiene plantillas. Asígnalas en «Plantillas» con el botón «A quién»."}
              </p>
            )}

            {ordenados.map((g) => (
              <div key={g.titulo} className="masivo-grupo">
                <span className="masivo-grupo-titulo">{g.titulo}</span>
                {g.plantillas.map((p) => {
                  const extra = otrasReglas(p.reglas);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`masivo-plantilla${plantillaId === p.id ? " masivo-plantilla-activa" : ""}`}
                      aria-pressed={plantillaId === p.id}
                      disabled={!!p.no_usable || enviando}
                      title={p.no_usable ?? undefined}
                      onClick={() => setPlantillaId(p.id)}
                    >
                      <strong>{p.nombre}</strong>
                      <span>
                        {p.no_usable ?? `Le corresponde a ${p.coinciden.toLocaleString("es-MX")} de ${ids.length.toLocaleString("es-MX")}`}
                      </span>
                      {extra && <span className="masivo-plantilla-reglas">{extra}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </>
        )}
        {plantillas && plantillas.length === 0 && <Alerta tipo="info">No hay plantillas aprobadas todavía. Créalas en «Plantillas».</Alerta>}
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
