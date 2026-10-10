import { Fragment, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { cuandoMasivo, type Masivo } from "./MasivosEnCurso";

type Destinatario = {
  oportunidad_id: string;
  cliente: string | null;
  telefono: string | null;
  vin: string | null;
  estado: string;
  motivo: string | null;
  motivo_texto: string | null;
  error: string | null;
  enviado_en: string | null;
};

const ESTADO_MASIVO: Record<Masivo["estado"], string> = { enviando: "Enviando", terminado: "Terminado", detenido: "Detenido" };
const ESTADO_ENVIO: Record<string, string> = {
  pendiente: "En cola",
  enviado: "Enviado",
  entregado: "Entregado",
  leido: "Leído",
  fallido: "Fallido",
  omitido: "Omitido",
};

const pct = (n: number, de: number) => (de > 0 ? `${Math.round((n * 100) / de)}%` : "—");

/** Los masivos del grupo: quién los mandó, cuántos salieron, se entregaron y se leyeron, y el detalle de cada persona. */
export default function HistorialMasivos({ sucursalId }: { sucursalId: string }) {
  const base = `/api/admin/sucursales/${sucursalId}/crm/masivos`;
  const [masivos, setMasivos] = useState<Masivo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<Destinatario[] | null>(null);

  useEffect(() => {
    apiFetch<{ masivos: Masivo[] }>(base)
      .then((d) => setMasivos(d.masivos))
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los masivos."));
  }, [base]);

  useEffect(() => {
    setDetalle(null);
    if (!abierto) return;
    let vigente = true;
    apiFetch<{ destinatarios: Destinatario[] }>(`${base}/${abierto}/destinatarios`)
      .then((d) => vigente && setDetalle(d.destinatarios))
      .catch(() => vigente && setDetalle([]));
    return () => {
      vigente = false;
    };
  }, [base, abierto]);

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!masivos) return <Cargador />;
  if (masivos.length === 0)
    return (
      <div className="marcador">
        <strong>Todavía no hay masivos</strong>
        <span>Se mandan desde la Base de Datos: elige las filas y usa «Enviar plantilla».</span>
      </div>
    );

  return (
    <div className="tabla-envoltura">
      <table className="tabla masivos-tabla">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Plantilla</th>
            <th>Lo mandó</th>
            <th>Estado</th>
            <th>Enviados</th>
            <th>Entregados</th>
            <th>Leídos</th>
            <th>Fallidos</th>
            <th>Omitidos</th>
          </tr>
        </thead>
        <tbody>
          {masivos.map((m) => (
            <Fragment key={m.id}>
              <tr className="masivos-fila" onClick={() => setAbierto(abierto === m.id ? null : m.id)} aria-expanded={abierto === m.id}>
                <td>{cuandoMasivo(m.creado_en)}</td>
                <td>{m.plantilla_nombre}</td>
                <td>{m.creado_por ?? "—"}</td>
                <td>
                  {ESTADO_MASIVO[m.estado]}
                  {m.estado === "enviando" && m.pendientes > 0 ? ` (${m.pendientes} en cola)` : ""}
                </td>
                <td>{m.enviados.toLocaleString("es-MX")}</td>
                <td>
                  {m.entregados.toLocaleString("es-MX")} <small>{pct(m.entregados, m.enviados)}</small>
                </td>
                <td>
                  {m.leidos.toLocaleString("es-MX")} <small>{pct(m.leidos, m.enviados)}</small>
                </td>
                <td>{m.fallidos.toLocaleString("es-MX")}</td>
                <td>{m.omitidos.toLocaleString("es-MX")}</td>
              </tr>
              {abierto === m.id && (
                <tr className="masivos-detalle">
                  <td colSpan={9}>
                    {!detalle ? (
                      <Cargador />
                    ) : (
                      <ul className="masivos-destinatarios">
                        {detalle.map((d) => (
                          <li key={d.oportunidad_id}>
                            <span className={`masivos-estado masivos-estado-${d.estado}`}>{ESTADO_ENVIO[d.estado] ?? d.estado}</span>
                            <span>{d.cliente ?? "Sin nombre"}</span>
                            <span className="masivos-dato">{[d.telefono, d.vin].filter(Boolean).join(" · ")}</span>
                            {(d.motivo_texto || d.error) && <span className="masivos-dato">{d.estado === "omitido" ? d.motivo_texto : d.error}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
