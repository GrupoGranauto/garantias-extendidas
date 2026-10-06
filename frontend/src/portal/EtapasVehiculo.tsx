import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Etapa = { id?: string; nombre: string; meses_desde: number; meses_hasta: number; km_max: number };
type Ciclo = {
  columna_fecha: string;
  columnas_disponibles: { valor: string; etiqueta: string }[];
  etapas: (Etapa & { id: string })[];
  ultimo_calculo: string | null;
  resumen: {
    vehiculos_activos: number;
    con_kilometraje: number;
    por_etapa: { etapa_id: string; total: number; por_km: number }[];
    excluidos_por_km: number;
    excluidos_por_fecha: number;
    aun_no_entran: number;
    sin_datos: number;
  };
};
type Fila = Etapa & { clave: string };

const MOTIVO: Record<string, string> = {
  fecha: "por la fecha",
  km: "por el kilometraje (se pasó del máximo de la etapa que marca la fecha)",
  excluido_km: "excluido: el kilometraje excede el máximo de la última etapa",
  excluido_fecha: "excluido: la fecha ya pasó de la última etapa",
  aun_no: "todavía no entra a la primera etapa",
  sin_datos: "faltan la fecha y el kilometraje",
  sin_configurar: "aún no hay etapas definidas",
};

let contador = 0;
const clave = () => `e${++contador}`;

/** Deja los meses seguidos: cada etapa empieza un mes después de que termina la anterior. */
function encadenar(filas: Fila[]): Fila[] {
  return filas.map((f, i) => {
    if (i === 0) return f;
    const desde = filas[i - 1].meses_hasta + 1;
    return { ...f, meses_desde: desde, meses_hasta: Math.max(f.meses_hasta, desde) };
  });
}

/**
 * Etapas del vehículo: en qué punto de su vida está un vehículo vendido. Se calcula por los meses desde una fecha
 * (la que elijas) y por el kilometraje que captura el ejecutivo; si el kilometraje se pasa del máximo de la etapa
 * que marca la fecha, manda el kilometraje.
 */
export default function EtapasVehiculo() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const base = `/api/admin/sucursales/${sucursalId}/crm/ciclo`;

  const [ciclo, setCiclo] = useState<Ciclo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [columna, setColumna] = useState("fecha_factura");
  const [filas, setFilas] = useState<Fila[]>([]);
  const [sucio, setSucio] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [pruebaFecha, setPruebaFecha] = useState("");
  const [pruebaKm, setPruebaKm] = useState("");
  const [prueba, setPrueba] = useState<{ etapa: string | null; motivo: string } | null>(null);

  const cargar = useCallback(() => {
    apiFetch<Ciclo>(base)
      .then((c) => {
        setCiclo(c);
        setColumna(c.columna_fecha);
        setFilas(c.etapas.map((e) => ({ ...e, clave: e.id })));
        setSucio(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar."));
  }, [base]);
  useEffect(cargar, [cargar]);

  function cambiar(fn: (f: Fila[]) => Fila[]) {
    setFilas((f) => encadenar(fn(f)));
    setSucio(true);
    setAviso(null);
    setPrueba(null);
  }
  const editar = (k: string, cambios: Partial<Etapa>) => cambiar((f) => f.map((x) => (x.clave === k ? { ...x, ...cambios } : x)));

  function agregar() {
    cambiar((f) => {
      const ultima = f[f.length - 1];
      const desde = ultima ? ultima.meses_hasta + 1 : 0;
      return [
        ...f,
        { clave: clave(), nombre: `Etapa ${f.length + 1}`, meses_desde: desde, meses_hasta: desde + 11, km_max: (ultima?.km_max ?? 0) + 15000 },
      ];
    });
  }

  async function guardar() {
    setGuardando(true);
    setAviso(null);
    try {
      const r = await apiFetch<{ revisados: number; cambiaron: number }>(base, {
        method: "PUT",
        body: JSON.stringify({
          columna_fecha: columna,
          etapas: filas.map((f) => ({ nombre: f.nombre, meses_desde: f.meses_desde, meses_hasta: f.meses_hasta, km_max: f.km_max })),
        }),
      });
      setAviso({ tipo: "ok", texto: `Guardado. Se revisaron ${r.revisados.toLocaleString("es-MX")} vehículos y ${r.cambiaron.toLocaleString("es-MX")} cambiaron de etapa.` });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  async function probar() {
    setAviso(null);
    try {
      setPrueba(
        await apiFetch<{ etapa: string | null; motivo: string }>(`${base}/probar`, {
          method: "POST",
          body: JSON.stringify({ fecha: pruebaFecha || null, km: pruebaKm.trim() === "" ? null : Math.floor(Number(pruebaKm)) }),
        }),
      );
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo probar." });
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!ciclo) return <Cargador />;
  const r = ciclo.resumen;

  return (
    <>
      <p className="pestana-descripcion">
        Define en qué etapa está cada vehículo vendido. El kilometraje es el primer parámetro: si se conoce (de la base de clientes o capturado por el
        ejecutivo), la etapa es la que lo cubre, o el vehículo queda excluido si excede la última. Sin kilometraje, la etapa sale de los meses
        transcurridos desde la fecha. La fecha siempre limita: pasado el último mes, el vehículo queda excluido aunque tenga pocos km.
      </p>
      {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

      <section className="rep-tarjeta">
        <div className="inicio-cab">
          <h3>Cómo se calcula</h3>
          <button type="button" className="boton-guardar" disabled={!sucio || guardando || filas.length === 0} onClick={guardar}>
            {guardando ? "Guardando…" : "Guardar y recalcular"}
          </button>
        </div>

        <label className="auto-campo ciclo-columna">
          <span>Fecha que se usa para contar los meses</span>
          <select className="auto-input" value={columna} onChange={(e) => { setColumna(e.target.value); setSucio(true); setAviso(null); }}>
            {ciclo.columnas_disponibles.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.etiqueta}
              </option>
            ))}
          </select>
        </label>

        <div className="tabla-envoltura">
          <table className="tabla ciclo-tabla">
            <thead>
              <tr>
                <th>Etapa</th>
                <th>Desde el mes</th>
                <th>Hasta el mes</th>
                <th>Hasta (km)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => (
                <tr key={f.clave}>
                  <td>
                    <input type="text" className="auto-input" maxLength={60} value={f.nombre} onChange={(e) => editar(f.clave, { nombre: e.target.value })} aria-label="Nombre de la etapa" />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      className="auto-input"
                      disabled={i > 0}
                      title={i > 0 ? "Empieza justo después de la etapa anterior" : undefined}
                      value={f.meses_desde}
                      onChange={(e) => editar(f.clave, { meses_desde: Math.max(0, Math.floor(Number(e.target.value) || 0)), meses_hasta: Math.max(f.meses_hasta, Math.floor(Number(e.target.value) || 0)) })}
                      aria-label="Desde el mes"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={f.meses_desde}
                      className="auto-input"
                      value={f.meses_hasta}
                      onChange={(e) => editar(f.clave, { meses_hasta: Math.max(f.meses_desde, Math.floor(Number(e.target.value) || 0)) })}
                      aria-label="Hasta el mes"
                    />
                  </td>
                  <td>
                    <input type="number" min={1} step={1000} className="auto-input" value={f.km_max} onChange={(e) => editar(f.clave, { km_max: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} aria-label="Kilometraje máximo" />
                  </td>
                  <td>
                    <button type="button" className="auto-quitar" aria-label={`Quitar ${f.nombre}`} onClick={() => cambiar((x) => x.filter((y) => y.clave !== f.clave))}>
                      <IconoXMarca className="icono-inline" />
                    </button>
                  </td>
                </tr>
              ))}
              {filas.length === 0 && (
                <tr>
                  <td colSpan={5} className="auto-vacio">
                    Todavía no hay etapas. Agrega la primera.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <button type="button" className="boton-secundario-claro auto-agregar" onClick={agregar} disabled={filas.length >= 10}>
          Agregar etapa
        </button>
        <p className="rep-ayuda">
          Los meses van seguidos: cada etapa empieza un mes después de que termina la anterior. El kilometraje es el máximo permitido de cada etapa
          (inclusive) y debe crecer de una etapa a la siguiente. Pasado el último mes de la última etapa, el vehículo queda excluido.
        </p>
      </section>

      <section className="rep-tarjeta">
        <h3>Cómo está la cartera</h3>
        {ciclo.etapas.length === 0 ? (
          <p className="auto-vacio">Define y guarda las etapas para ver cuántos vehículos cae en cada una.</p>
        ) : (
          <>
            <div className="rep-kpis">
              {ciclo.etapas.map((e) => {
                const x = r.por_etapa.find((p) => p.etapa_id === e.id);
                return (
                  <div key={e.id} className="rep-kpi">
                    <span>{e.nombre}</span>
                    <strong>{(x?.total ?? 0).toLocaleString("es-MX")}</strong>
                    {(x?.por_km ?? 0) > 0 && <small>{x?.por_km} por kilometraje</small>}
                  </div>
                );
              })}
              <div className={`rep-kpi${r.excluidos_por_km > 0 ? " rep-kpi-alerta" : ""}`}>
                <span>Excluidos por km</span>
                <strong>{r.excluidos_por_km.toLocaleString("es-MX")}</strong>
              </div>
              <div className="rep-kpi">
                <span>Excluidos por fecha</span>
                <strong>{r.excluidos_por_fecha.toLocaleString("es-MX")}</strong>
              </div>
              {(r.aun_no_entran > 0 || r.sin_datos > 0) && (
                <div className="rep-kpi">
                  <span>Aún no entran / sin datos</span>
                  <strong>{(r.aun_no_entran + r.sin_datos).toLocaleString("es-MX")}</strong>
                </div>
              )}
            </div>
            <p className="rep-ayuda">
              {r.con_kilometraje.toLocaleString("es-MX")} de {r.vehiculos_activos.toLocaleString("es-MX")} vehículos con oportunidad abierta ya tienen kilometraje
              capturado. Los demás se ubican solo por la fecha. {ciclo.ultimo_calculo ? `Último cálculo: ${ciclo.ultimo_calculo}. ` : ""}Se recalcula solo cada día y en cuanto
              alguien captura un kilometraje.
            </p>
          </>
        )}
      </section>

      <section className="rep-tarjeta">
        <h3>Probar una combinación</h3>
        <p className="rep-ayuda">Escribe una fecha y un kilometraje y mira en qué etapa caería, sin tocar ningún dato.</p>
        <div className="auto-cuerpo">
          <label className="auto-campo">
            <span>Fecha</span>
            <input type="date" className="auto-input" value={pruebaFecha} onChange={(e) => { setPruebaFecha(e.target.value); setPrueba(null); }} />
          </label>
          <label className="auto-campo">
            <span>Kilometraje (opcional)</span>
            <input type="number" min={0} className="auto-input" value={pruebaKm} onChange={(e) => { setPruebaKm(e.target.value); setPrueba(null); }} />
          </label>
        </div>
        <button type="button" className="boton-secundario-claro auto-agregar" onClick={probar} disabled={sucio || ciclo.etapas.length === 0}>
          Ver la etapa
        </button>
        {sucio && <p className="rep-ayuda">Guarda primero para probar con las etapas nuevas.</p>}
        {prueba && (
          <Alerta tipo={prueba.etapa ? "ok" : "info"}>
            {prueba.etapa ? <strong>{prueba.etapa}</strong> : <strong>Sin etapa</strong>} — {MOTIVO[prueba.motivo] ?? prueba.motivo}.
          </Alerta>
        )}
      </section>
    </>
  );
}
