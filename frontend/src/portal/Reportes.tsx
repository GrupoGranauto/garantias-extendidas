import { useEffect, useState, type CSSProperties } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import HistorialMasivos from "./HistorialMasivos";
import { usePortal } from "./PortalProvider";

type EtapaActual = { id: string; nombre: string; color: string; tipo: string; tiempo_max_horas: number | null; total: number; horas_promedio: number; fuera_sla: number };
type Reporte = {
  periodo: { desde: string; hasta: string };
  embudo_actual: EtapaActual[];
  flujo: { id: string; nombre: string; tipo: string; entradas: number }[];
  ventas: { ganadas: number; perdidas: number; tasa_cierre: number | null };
  motivos_perdida: { motivo: string; total: number }[];
  por_ejecutivo: {
    ejecutivo: string;
    cartera_abierta: number;
    sin_intentar: number;
    llamadas: number;
    whatsapps: number;
    contactos_efectivos: number;
    tareas_pendientes: number;
    tareas_vencidas: number;
    tareas_hechas: number;
  }[];
};

const dia = (d: Date) => d.toISOString().slice(0, 10);

function duracion(horas: number): string {
  if (horas < 1) return "menos de 1 h";
  if (horas < 48) return `${Math.round(horas)} h`;
  return `${Math.round(horas / 24)} d`;
}

function Barras({ filas, color }: { filas: { clave: string; etiqueta: string; valor: number; color?: string; nota?: string }[]; color?: string }) {
  const max = Math.max(1, ...filas.map((f) => f.valor));
  return (
    <ul className="rep-barras">
      {filas.map((f) => (
        <li key={f.clave}>
          <span className="rep-barra-etiqueta">{f.etiqueta}</span>
          <span className="rep-barra-pista">
            <span className="rep-barra" style={{ width: `${(f.valor / max) * 100}%`, background: f.color ?? color ?? "var(--marca)" } as CSSProperties} />
          </span>
          <span className="rep-barra-valor">{f.valor.toLocaleString("es-MX")}</span>
          {f.nota && <span className="rep-barra-nota">{f.nota}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Reporte del embudo: dónde está la cartera, qué se movió en el periodo y cómo trabaja cada ejecutivo. El admin ve además
 * sus masivos de WhatsApp.
 */
export default function Reportes() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [desde, setDesde] = useState(() => dia(new Date(Date.now() - 29 * 86400000)));
  const [hasta, setHasta] = useState(() => dia(new Date()));
  const [datos, setDatos] = useState<Reporte | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [esAdmin, setEsAdmin] = useState(false);
  const [vista, setVista] = useState<"embudo" | "masivos">(() => {
    try {
      return sessionStorage.getItem("portal.reportes.vista") === "masivos" ? "masivos" : "embudo";
    } catch {
      return "embudo";
    }
  });
  const elegirVista = (v: "embudo" | "masivos") => {
    setVista(v);
    try {
      sessionStorage.setItem("portal.reportes.vista", v);
    } catch {
      // sin persistencia; no afecta el funcionamiento
    }
  };
  useEffect(() => {
    apiFetch<{ rol: string }>("/api/perfil")
      .then((p) => setEsAdmin(p.rol === "admin"))
      .catch(() => setEsAdmin(false));
  }, []);
  const verMasivos = esAdmin && vista === "masivos";

  useEffect(() => {
    if (desde > hasta) {
      setError("La fecha inicial no puede ser posterior a la final.");
      return;
    }
    setCargando(true);
    apiFetch<Reporte>(`/api/admin/sucursales/${sucursalId}/crm/reportes/embudo?desde=${desde}&hasta=${hasta}`)
      .then((d) => {
        setDatos(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el reporte."))
      .finally(() => setCargando(false));
  }, [sucursalId, desde, hasta]);

  const abiertas = datos?.embudo_actual.filter((e) => e.tipo === "abierta") ?? [];
  const totalAbiertas = abiertas.reduce((n, e) => n + e.total, 0);
  const fueraSla = abiertas.reduce((n, e) => n + e.fuera_sla, 0);

  return (
    <div className="pagina-formulario">
      <div className="pf-barra">
        {esAdmin && (
          <div className="vista-selector" role="tablist" aria-label="Reporte">
            <button type="button" role="tab" aria-selected={!verMasivos} className={`vista-opcion${!verMasivos ? " vista-opcion-activa" : ""}`} onClick={() => elegirVista("embudo")}>
              Embudo
            </button>
            <button type="button" role="tab" aria-selected={verMasivos} className={`vista-opcion${verMasivos ? " vista-opcion-activa" : ""}`} onClick={() => elegirVista("masivos")}>
              Masivos
            </button>
          </div>
        )}
        {!verMasivos && (
        <div className="rep-rango">
          <label>
            Desde
            <input type="date" className="auto-input" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} />
          </label>
          <label>
            Hasta
            <input type="date" className="auto-input" value={hasta} min={desde} max={dia(new Date())} onChange={(e) => setHasta(e.target.value)} />
          </label>
        </div>
        )}
      </div>

      {verMasivos && (
        <section className="rep-tarjeta">
          <h3>Masivos de WhatsApp</h3>
          <HistorialMasivos sucursalId={sucursalId} />
        </section>
      )}

      {!verMasivos && error && <Alerta tipo="error">{error}</Alerta>}
      {!verMasivos && !datos && !error && <Cargador />}

      {!verMasivos && datos && (
        <div className={`rep${cargando ? " tabla-cargando" : ""}`}>
          <div className="rep-kpis">
            <div className="rep-kpi">
              <span>Cartera abierta</span>
              <strong>{totalAbiertas.toLocaleString("es-MX")}</strong>
            </div>
            <div className={`rep-kpi${fueraSla > 0 ? " rep-kpi-alerta" : ""}`}>
              <span>Fuera de tiempo (SLA)</span>
              <strong>{fueraSla.toLocaleString("es-MX")}</strong>
            </div>
            <div className="rep-kpi">
              <span>Ventas en el periodo</span>
              <strong>{datos.ventas.ganadas}</strong>
            </div>
            <div className="rep-kpi">
              <span>Perdidas en el periodo</span>
              <strong>{datos.ventas.perdidas}</strong>
            </div>
            <div className="rep-kpi">
              <span>Tasa de cierre</span>
              <strong>{datos.ventas.tasa_cierre === null ? "—" : `${datos.ventas.tasa_cierre}%`}</strong>
            </div>
          </div>

          <div className="rep-rejilla">
            <section className="rep-tarjeta">
              <h3>Embudo actual</h3>
              <Barras
                filas={datos.embudo_actual.map((e) => ({
                  clave: e.id,
                  etiqueta: e.nombre,
                  valor: e.total,
                  color: e.color,
                  nota: e.tipo === "abierta" && e.total > 0 ? `${duracion(e.horas_promedio)} en promedio${e.fuera_sla > 0 ? ` · ${e.fuera_sla} fuera de SLA` : ""}` : undefined,
                }))}
              />
            </section>

            <section className="rep-tarjeta">
              <h3>Movimientos del periodo</h3>
              <p className="rep-ayuda">Leads que entraron a cada estado por una acción del equipo o una automatización.</p>
              {datos.flujo.length === 0 ? (
                <p className="auto-vacio">Sin movimientos en estas fechas.</p>
              ) : (
                <Barras filas={datos.flujo.map((f) => ({ clave: f.id, etiqueta: f.nombre, valor: f.entradas }))} />
              )}
            </section>

            <section className="rep-tarjeta">
              <h3>Motivos de pérdida</h3>
              {datos.motivos_perdida.length === 0 ? (
                <p className="auto-vacio">Sin pérdidas en estas fechas.</p>
              ) : (
                <Barras color="#dc2626" filas={datos.motivos_perdida.map((m) => ({ clave: m.motivo, etiqueta: m.motivo, valor: m.total }))} />
              )}
            </section>
          </div>

          <section className="rep-tarjeta">
            <h3>Por ejecutivo</h3>
            <div className="tabla-envoltura">
              <table className="tabla">
                <thead>
                  <tr>
                    <th>Ejecutivo</th>
                    <th>Cartera abierta</th>
                    <th>Sin intentar</th>
                    <th>Llamadas</th>
                    <th>WhatsApp</th>
                    <th>Contactos efectivos</th>
                    <th>Tareas pendientes</th>
                    <th>Vencidas</th>
                    <th>Hechas</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.por_ejecutivo.map((e) => (
                    <tr key={e.ejecutivo}>
                      <td>{e.ejecutivo}</td>
                      <td>{e.cartera_abierta}</td>
                      <td>{e.sin_intentar}</td>
                      <td>{e.llamadas}</td>
                      <td>{e.whatsapps}</td>
                      <td>{e.contactos_efectivos}</td>
                      <td>{e.tareas_pendientes}</td>
                      <td className={e.tareas_vencidas > 0 ? "rep-celda-alerta" : undefined}>{e.tareas_vencidas}</td>
                      <td>{e.tareas_hechas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rep-ayuda">Las llamadas y WhatsApp salen de los contactos registrados en la ficha de cada oportunidad desde que se estrenó.</p>
          </section>
        </div>
      )}
    </div>
  );
}
