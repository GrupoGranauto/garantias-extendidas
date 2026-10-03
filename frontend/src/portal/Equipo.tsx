import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import Interruptor from "../componentes/Interruptor";
import { IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Estado = {
  roster: string[];
  exigir_evidencia_venta: boolean;
  carga: { ejecutivo: string; abiertas: number; tareas_pendientes: number }[];
};
type Simulacion = { total: number; destinos: { ejecutivo: string; cantidad: number }[]; aplicado: boolean };

/**
 * Equipo comercial: quién recibe las oportunidades nuevas (roster), cuánta cartera lleva cada
 * ejecutivo, y reasignación de cartera cuando alguien se ausenta. También las reglas del embudo.
 */
export default function Equipo() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const base = `/api/admin/sucursales/${sucursalId}/crm/equipo`;

  const [estado, setEstado] = useState<Estado | null>(null);
  const [roster, setRoster] = useState<string[]>([]);
  const [nuevo, setNuevo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [de, setDe] = useState<string | null>(null);
  const [a, setA] = useState("");
  const [simulacion, setSimulacion] = useState<Simulacion | null>(null);

  function cargar() {
    apiFetch<Estado>(base)
      .then((e) => {
        setEstado(e);
        setRoster(e.roster);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el equipo."));
  }
  useEffect(cargar, [sucursalId]);

  const rosterSucio = estado ? JSON.stringify(estado.roster) !== JSON.stringify(roster) : false;

  async function guardar(cambios: { roster?: string[]; exigir_evidencia_venta?: boolean }, texto: string) {
    setGuardando(true);
    setAviso(null);
    try {
      await apiFetch(base, { method: "PUT", body: JSON.stringify(cambios) });
      setAviso({ tipo: "ok", texto });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  function agregar() {
    const n = nuevo.trim();
    if (n && !roster.includes(n)) setRoster([...roster, n]);
    setNuevo("");
  }

  async function reasignar(simular: boolean) {
    if (!de) return;
    setGuardando(true);
    setAviso(null);
    try {
      const r = await apiFetch<Simulacion>(`${base}/reasignar`, { method: "POST", body: JSON.stringify({ de, a: a || null, simular }) });
      if (simular) {
        setSimulacion(r);
      } else {
        setSimulacion(null);
        setDe(null);
        setAviso({ tipo: "ok", texto: `Se reasignaron ${r.total} oportunidades.` });
        cargar();
      }
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo reasignar." });
    } finally {
      setGuardando(false);
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!estado) return <Cargador />;

  return (
    <div className="pagina-formulario">
      <p className="pestana-descripcion">
        Define quién recibe las oportunidades nuevas, reparte la cartera cuando alguien se ausenta y fija las reglas del embudo.
      </p>
      {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

      <div className="rep-rejilla">
        <section className="rep-tarjeta">
          <h3>Ejecutivos que reciben oportunidades nuevas</h3>
          <p className="rep-ayuda">Cada oportunidad nueva se asigna al ejecutivo con menos cartera abierta de esta lista.</p>
          <ul className="equipo-roster">
            {roster.map((n) => (
              <li key={n}>
                <span>{n}</span>
                <button type="button" className="auto-quitar" aria-label={`Quitar a ${n}`} onClick={() => setRoster(roster.filter((x) => x !== n))}>
                  <IconoXMarca className="icono-inline" />
                </button>
              </li>
            ))}
            {roster.length === 0 && <li className="auto-vacio">Sin ejecutivos: las oportunidades nuevas no se podrán asignar.</li>}
          </ul>
          <div className="ficha-fila">
            <input
              type="text"
              className="auto-input"
              placeholder="Nombre exacto del ejecutivo"
              maxLength={80}
              value={nuevo}
              onChange={(e) => setNuevo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && agregar()}
            />
            <button type="button" className="boton-secundario-claro" onClick={agregar} disabled={nuevo.trim() === ""}>
              Agregar
            </button>
          </div>
          <button type="button" className="boton-guardar" disabled={!rosterSucio || guardando} onClick={() => guardar({ roster }, "Equipo guardado.")}>
            Guardar equipo
          </button>
        </section>

        <section className="rep-tarjeta">
          <h3>Reglas del embudo</h3>
          <Interruptor
            etiqueta="Exigir certificado entregado para marcar una venta"
            activo={estado.exigir_evidencia_venta}
            onChange={(v) => guardar({ exigir_evidencia_venta: v }, v ? "Ahora una venta exige evidencia." : "Ya no se exige evidencia para vender.")}
          />
          <p className="rep-ayuda">
            Con la regla activa, una oportunidad solo pasa a una etapa de venta si su contrato llegó a «Certificado entregado» (o «Cobertura
            iniciada»). Una venta es pago y certificado, no interés.
          </p>
        </section>
      </div>

      <section className="rep-tarjeta">
        <h3>Cartera por ejecutivo</h3>
        <div className="tabla-envoltura">
          <table className="tabla">
            <thead>
              <tr>
                <th>Ejecutivo</th>
                <th>Oportunidades abiertas</th>
                <th>Tareas pendientes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {estado.carga.map((c) => (
                <tr key={c.ejecutivo}>
                  <td>{c.ejecutivo}</td>
                  <td>{c.abiertas}</td>
                  <td>{c.tareas_pendientes}</td>
                  <td>
                    <button
                      type="button"
                      className="boton-secundario-claro"
                      disabled={c.abiertas === 0}
                      onClick={() => {
                        setDe(c.ejecutivo);
                        setA("");
                        setSimulacion(null);
                      }}
                    >
                      Reasignar cartera
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {de && (
          <div className="equipo-reasignar">
            <strong>Reasignar la cartera abierta de {de}</strong>
            <select
              className="auto-input"
              value={a}
              onChange={(e) => {
                setA(e.target.value);
                setSimulacion(null);
              }}
            >
              <option value="">Repartir de forma equilibrada entre el resto del equipo</option>
              {estado.roster
                .filter((n) => n !== de)
                .map((n) => (
                  <option key={n} value={n}>
                    Pasar todo a {n}
                  </option>
                ))}
            </select>
            <div className="ficha-fila">
              <button type="button" className="boton-secundario-claro" disabled={guardando} onClick={() => reasignar(true)}>
                Ver qué pasaría
              </button>
              <button type="button" className="boton-tenue" onClick={() => setDe(null)}>
                Cancelar
              </button>
            </div>
            {simulacion && (
              <div className="equipo-simulacion">
                <p>
                  Se moverían <strong>{simulacion.total}</strong> oportunidades (con sus tareas pendientes):
                </p>
                <ul>
                  {simulacion.destinos.map((d) => (
                    <li key={d.ejecutivo}>
                      {d.ejecutivo}: {d.cantidad}
                    </li>
                  ))}
                </ul>
                <button type="button" className="boton-guardar" disabled={guardando || simulacion.total === 0} onClick={() => reasignar(false)}>
                  Confirmar reasignación
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
