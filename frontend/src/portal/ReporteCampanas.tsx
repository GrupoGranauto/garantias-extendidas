import { useEffect, useState, type CSSProperties } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Fila = {
  campana: string;
  leads: number;
  respondieron: number;
  contestaron: number;
  ventas: number;
  avance: { etapa: string; total: number }[];
  mensajes: { enviados: number; entregados: number; leidos: number; fallidos: number; omitidos: number; simulados: number; pendientes: number };
  omitidos_por_motivo: { motivo: string; total: number }[];
  seguimientos: { hechos: number; omitidos: number; simulados: number; pendientes: number; tareas_creadas: number; tareas_hechas: number };
};
type Reporte = { periodo: { desde: string; hasta: string }; campanas: Fila[] };

const MOTIVOS: Record<string, string> = {
  baja: "Pidió la baja",
  ahora_no: "Respondió «Ahora no» (vuelve en la siguiente campaña)",
  sin_telefono: "Sin teléfono",
  sin_celular: "El número no es celular",
  etapa_no_permitida: "Estado del lead no permitido",
  respondio: "Ya respondió",
  ya_contactado: "Ya fue contactado",
  no_contactable: "El BDC lo marcó no contactable",
  un_mensaje_por_dia: "Ese teléfono ya recibió un mensaje hoy",
  fuera_de_ventana: "Fuera del horario",
  tope_diario: "Tope diario alcanzado",
  descanso_entre_campanas: "Descanso entre campañas",
  plantilla_no_disponible: "Plantilla no disponible",
  whatsapp_no_configurado: "WhatsApp sin configurar",
  campana_apagada: "Campaña apagada",
  ya_no_aplica: "Ya no aplica",
  fuera_de_vigencia: "Pasó su vigencia",
  fuera_del_piloto: "Fuera del piloto",
  variable_vacia: "Falta un dato para el mensaje",
  reintento: "Reintento",
};

const n = (v: number) => v.toLocaleString("es-MX");
const pct = (parte: number, total: number) => (total > 0 ? `${Math.round((parte / total) * 100)} %` : "—");

function Barras({ filas, color }: { filas: { clave: string; etiqueta: string; valor: number }[]; color?: string }) {
  const max = Math.max(1, ...filas.map((f) => f.valor));
  return (
    <ul className="rep-barras">
      {filas.map((f) => (
        <li key={f.clave}>
          <span className="rep-barra-etiqueta">{f.etiqueta}</span>
          <span className="rep-barra-pista">
            <span className="rep-barra" style={{ width: `${(f.valor / max) * 100}%`, background: color ?? "var(--marca)" } as CSSProperties} />
          </span>
          <span className="rep-barra-valor">{n(f.valor)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Reporte del ciclo de campañas. Cada lead cuenta en el periodo de su primer mensaje REAL de la campaña; de ahí se sigue si
 * respondió, si contestó y a qué etapas avanzó. Las simulaciones se muestran aparte y no entran a ninguna tasa.
 */
export default function ReporteCampanas({ desde, hasta }: { desde: string; hasta: string }) {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const [datos, setDatos] = useState<Reporte | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (desde > hasta) return;
    setCargando(true);
    apiFetch<Reporte>(`/api/admin/sucursales/${sucursalId}/crm/reportes/campanas?desde=${desde}&hasta=${hasta}`)
      .then((d) => {
        setDatos(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el reporte."))
      .finally(() => setCargando(false));
  }, [sucursalId, desde, hasta]);

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!datos) return <Cargador />;

  const t = datos.campanas.reduce(
    (a, c) => ({
      leads: a.leads + c.leads,
      enviados: a.enviados + c.mensajes.enviados,
      simulados: a.simulados + c.mensajes.simulados,
      respondieron: a.respondieron + c.respondieron,
      contestaron: a.contestaron + c.contestaron,
      ventas: a.ventas + c.ventas,
      seguimientos: a.seguimientos + c.seguimientos.hechos,
    }),
    { leads: 0, enviados: 0, simulados: 0, respondieron: 0, contestaron: 0, ventas: 0, seguimientos: 0 },
  );

  return (
    <div className={`rep${cargando ? " tabla-cargando" : ""}`}>
      {t.enviados === 0 && (
        <Alerta tipo="info">
          {t.simulados > 0
            ? `Todavía no hay mensajes reales en estas fechas. Hay ${n(t.simulados)} mensajes simulados: sirven para revisar a quién le habrían llegado, pero no cuentan como resultados.`
            : "Todavía no hay mensajes de campaña en estas fechas."}
        </Alerta>
      )}

      <div className="rep-kpis">
        <div className="rep-kpi">
          <span>Leads con mensaje</span>
          <strong>{n(t.leads)}</strong>
        </div>
        <div className="rep-kpi">
          <span>Mensajes enviados</span>
          <strong>{n(t.enviados)}</strong>
        </div>
        <div className="rep-kpi">
          <span>Respondieron</span>
          <strong>{pct(t.respondieron, t.leads)}</strong>
          <small>{n(t.respondieron)} de {n(t.leads)}</small>
        </div>
        <div className="rep-kpi">
          <span>Contestaron</span>
          <strong>{pct(t.contestaron, t.leads)}</strong>
          <small>{n(t.contestaron)} de {n(t.leads)}</small>
        </div>
        <div className="rep-kpi">
          <span>Ventas</span>
          <strong>{n(t.ventas)}</strong>
          <small>{pct(t.ventas, t.leads)} de los leads</small>
        </div>
        <div className="rep-kpi">
          <span>Seguimientos hechos</span>
          <strong>{n(t.seguimientos)}</strong>
        </div>
      </div>

      <section className="rep-tarjeta">
        <h3>Por campaña</h3>
        {datos.campanas.length === 0 ? (
          <p className="auto-vacio">Sin actividad de campañas en estas fechas.</p>
        ) : (
          <div className="tabla-envoltura">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Campaña</th>
                  <th>Leads</th>
                  <th>Enviados</th>
                  <th>Entregados</th>
                  <th>Leídos</th>
                  <th>Fallidos</th>
                  <th>Omitidos</th>
                  <th>Simulados</th>
                  <th>Respondieron</th>
                  <th>Contestaron</th>
                  <th>Ventas</th>
                </tr>
              </thead>
              <tbody>
                {datos.campanas.map((c) => (
                  <tr key={c.campana}>
                    <td>{c.campana}</td>
                    <td>{n(c.leads)}</td>
                    <td>{n(c.mensajes.enviados)}</td>
                    <td>{n(c.mensajes.entregados)}</td>
                    <td>{n(c.mensajes.leidos)}</td>
                    <td className={c.mensajes.fallidos > 0 ? "rep-celda-alerta" : undefined}>{n(c.mensajes.fallidos)}</td>
                    <td>{n(c.mensajes.omitidos)}</td>
                    <td>{n(c.mensajes.simulados)}</td>
                    <td>
                      {n(c.respondieron)} <small>({pct(c.respondieron, c.leads)})</small>
                    </td>
                    <td>
                      {n(c.contestaron)} <small>({pct(c.contestaron, c.leads)})</small>
                    </td>
                    <td>
                      {n(c.ventas)} <small>({pct(c.ventas, c.leads)})</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="rep-ayuda">
          «Leads» son las oportunidades cuyo primer mensaje real de la campaña salió en estas fechas; respondieron, contestaron y ventas se cuentan sobre esos leads, después de ese
          primer mensaje. «Enviados», «omitidos» y «simulados» cuentan los mensajes del periodo, también los de seguimiento.
        </p>
      </section>

      {datos.campanas.map((c) => {
        const hayDetalle = c.avance.length > 0 || c.omitidos_por_motivo.length > 0 || Object.values(c.seguimientos).some((v) => v > 0);
        if (!hayDetalle) return null;
        return (
          <section key={c.campana} className="rep-tarjeta">
            <h3>{c.campana}</h3>
            <div className="rep-rejilla">
              <div>
                <h4 className="camp-def-sub">A dónde avanzaron los leads</h4>
                {c.avance.length === 0 ? <p className="auto-vacio">Todavía ninguno cambió de estado después del mensaje.</p> : <Barras filas={c.avance.map((a) => ({ clave: a.etapa, etiqueta: a.etapa, valor: a.total }))} />}
              </div>
              <div>
                <h4 className="camp-def-sub">Por qué no salieron algunos mensajes</h4>
                {c.omitidos_por_motivo.length === 0 ? (
                  <p className="auto-vacio">Sin mensajes omitidos.</p>
                ) : (
                  <Barras color="#dc2626" filas={c.omitidos_por_motivo.map((m) => ({ clave: m.motivo, etiqueta: MOTIVOS[m.motivo] ?? m.motivo, valor: m.total }))} />
                )}
              </div>
              <div>
                <h4 className="camp-def-sub">Seguimientos</h4>
                <ul className="camp-def-cruces">
                  <li>
                    <strong>{n(c.seguimientos.hechos)}</strong> hechos ({n(c.seguimientos.tareas_creadas)} tareas o llamadas creadas, {n(c.seguimientos.tareas_hechas)} ya resueltas)
                  </li>
                  <li>
                    <strong>{n(c.seguimientos.pendientes)}</strong> pendientes
                  </li>
                  <li>
                    <strong>{n(c.seguimientos.omitidos)}</strong> omitidos (no cumplían las condiciones o la oportunidad ya no aplicaba)
                  </li>
                  <li>
                    <strong>{n(c.seguimientos.simulados)}</strong> simulados
                  </li>
                </ul>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
