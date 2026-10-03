import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Tipo = "dias" | "meses";
type Def = {
  nombre: string;
  tipo: Tipo;
  columna_fecha: string;
  dias_desde: number | null;
  dias_hasta: number | null;
  meses_atras: number | null;
  dia_envio: number | null;
  hora_envio: string | null;
  etapa_orden: number | null;
  activa: boolean;
};
type Fila = Def & { clave: string };

type Comparacion = {
  por_campana: { campana: string; web: number; bigquery: number; coinciden: number; solo_web: number; solo_bigquery: number }[];
  cruces: { web: string | null; bigquery: string | null; total: number }[];
  sin_campana: number;
  ejemplos: { cliente: string; fecha_factura: string | null; fecha_reporte: string | null; web: string | null; bigquery: string | null }[];
};
type Respuesta = {
  campanas: Def[];
  etapas_vehiculo: { orden: number; nombre: string }[];
  columnas_fecha: { valor: string; etiqueta: string }[];
  hora_calculo: string;
  ultimo_calculo: string | null;
  ultima_corrida: { fecha: string; origen: string; evaluadas: number; asignadas: number; traslapes: number; ejecutado_en: string } | null;
  comparacion: Comparacion | null;
  fuente: "bigquery" | "web";
};

const n = (v: number) => v.toLocaleString("es-MX");
let contador = 0;
const clave = () => `c${++contador}`;

const NUEVA_DIAS: Def = { nombre: "", tipo: "dias", columna_fecha: "fecha_factura", dias_desde: 0, dias_hasta: 8, meses_atras: null, dia_envio: null, hora_envio: null, etapa_orden: null, activa: true };
const NUEVA_MESES: Def = { nombre: "", tipo: "meses", columna_fecha: "fecha_factura", dias_desde: null, dias_hasta: null, meses_atras: 6, dia_envio: 1, hora_envio: "09:00", etapa_orden: null, activa: true };

function describir(d: Def): string {
  const fecha = d.columna_fecha === "fecha_reporte" ? "la fecha de reporte" : "la fecha de factura";
  const etapa = d.etapa_orden !== null ? ` y el vehículo está en la etapa ${d.etapa_orden}` : "";
  if (d.tipo === "dias") {
    return `Entra cuando han pasado de ${d.dias_desde ?? 0} a ${(d.dias_hasta ?? 1) - 1} días desde ${fecha}${etapa}. Se recalcula todos los días: los leads entran y salen solos.`;
  }
  const cuando = d.meses_atras === 0 ? "del mes actual" : d.meses_atras === 1 ? "del mes pasado" : `de hace ${d.meses_atras ?? 0} meses`;
  return `Entra todo lo que tenga ${fecha} ${cuando}, sin importar el día${etapa}. Se envía el día ${d.dia_envio ?? 1} de cada mes a las ${d.hora_envio ?? "09:00"}.`;
}

const entero = (v: string, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(Number(v) || 0)));

/**
 * Campañas que define el usuario: quién entra a cada una, según la fecha de su vehículo. La web las calcula una vez al día
 * a la hora elegida y, por ahora, solo las compara con las de BigQuery (modo sombra): los envíos no cambian.
 */
export default function DefinirCampanas() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const base = `/api/admin/sucursales/${sucursalId}/crm/campanas-def`;

  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [hora, setHora] = useState("06:00");
  const [sucio, setSucio] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [calculando, setCalculando] = useState(false);
  const [cambiandoFuente, setCambiandoFuente] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [pruebaFecha, setPruebaFecha] = useState("");
  const [pruebaEtapa, setPruebaEtapa] = useState("");
  const [prueba, setPrueba] = useState<{ hoy: string; resultado: { nombre: string; activa: boolean; entra: boolean }[]; elegida: string | null } | null>(null);

  const cargar = useCallback(() => {
    apiFetch<Respuesta>(base)
      .then((r) => {
        setDatos(r);
        setFilas(r.campanas.map((c) => ({ ...c, clave: clave() })));
        setHora(r.hora_calculo);
        setSucio(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar."));
  }, [base]);
  useEffect(cargar, [cargar]);

  function cambiar(fn: (f: Fila[]) => Fila[]) {
    setFilas(fn);
    setSucio(true);
    setAviso(null);
    setPrueba(null);
  }
  const editar = (k: string, cambios: Partial<Def>) => cambiar((f) => f.map((x) => (x.clave === k ? { ...x, ...cambios } : x)));
  function mover(i: number, d: -1 | 1) {
    cambiar((f) => {
      const j = i + d;
      if (j < 0 || j >= f.length) return f;
      const c = [...f];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  }
  function cambiarTipo(k: string, tipo: Tipo) {
    const plantilla = tipo === "dias" ? NUEVA_DIAS : NUEVA_MESES;
    editar(k, { tipo, dias_desde: plantilla.dias_desde, dias_hasta: plantilla.dias_hasta, meses_atras: plantilla.meses_atras, dia_envio: plantilla.dia_envio, hora_envio: plantilla.hora_envio });
  }

  async function guardar() {
    setGuardando(true);
    setAviso(null);
    try {
      const r = await apiFetch<{ evaluadas: number; asignadas: number; traslapes: number }>(base, {
        method: "PUT",
        body: JSON.stringify({ hora_calculo: hora, campanas: filas.map(({ clave: _k, ...d }) => ({ ...d, nombre: d.nombre.trim() })) }),
      });
      setAviso({
        tipo: "ok",
        texto: `Guardado y calculado: de ${n(r.evaluadas)} oportunidades abiertas, ${n(r.asignadas)} cayeron en alguna campaña.${r.traslapes > 0 ? ` ${n(r.traslapes)} cumplían más de una regla; se quedó con la primera de la lista.` : ""}`,
      });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  async function calcularAhora() {
    setCalculando(true);
    setAviso(null);
    try {
      const r = await apiFetch<{ evaluadas: number; asignadas: number }>(`${base}/calcular`, { method: "POST", body: JSON.stringify({}) });
      setAviso({ tipo: "ok", texto: `Calculado: ${n(r.asignadas)} de ${n(r.evaluadas)} oportunidades abiertas cayeron en alguna campaña.` });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo calcular." });
    } finally {
      setCalculando(false);
    }
  }

  async function cambiarFuente(fuente: "bigquery" | "web") {
    const aviso =
      fuente === "web"
        ? "Los envíos de WhatsApp de esta sucursal van a usar las campañas definidas aquí en lugar de las de BigQuery.\n\nLo que estaba pendiente de enviar se cancela y se reprograma con las campañas de la web. Cada campaña sigue apagada o en simulación hasta que la enciendas en «Campañas de WhatsApp».\n\n¿Continuar?"
        : "Los envíos de WhatsApp van a volver a usar las campañas que manda BigQuery.\n\nLo que estaba pendiente de enviar se cancela y se reprograma. ¿Continuar?";
    if (!window.confirm(aviso)) return;
    setCambiandoFuente(true);
    setAviso(null);
    try {
      const r = await apiFetch<{ pendientes_cancelados: number }>(`${base}/fuente`, { method: "PUT", body: JSON.stringify({ fuente }) });
      setAviso({
        tipo: "ok",
        texto: `Ahora los envíos usan ${fuente === "web" ? "las campañas de la web" : "las campañas de BigQuery"}. Se cancelaron ${n(r.pendientes_cancelados)} envíos pendientes para reprogramarlos.`,
      });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo cambiar." });
    } finally {
      setCambiandoFuente(false);
    }
  }

  async function probar() {
    setAviso(null);
    try {
      setPrueba(
        await apiFetch(`${base}/probar`, {
          method: "POST",
          body: JSON.stringify({ fecha: pruebaFecha, etapa_orden: pruebaEtapa === "" ? null : Number(pruebaEtapa) }),
        }),
      );
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo probar." });
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!datos) return <Cargador />;
  const cmp = datos.comparacion;
  const etapas = datos.etapas_vehiculo;
  const hayDiferencias = cmp ? cmp.por_campana.some((c) => c.solo_web > 0 || c.solo_bigquery > 0) : false;

  return (
    <>
      <p className="pestana-descripcion">
        Tú decides quién entra a cada campaña. Hay dos tipos: <strong>por días</strong> (una ventana de días desde la fecha del vehículo; se recalcula todos
        los días) y <strong>por meses</strong> (una cohorte: todo lo que tenga la fecha en el mes de hace N meses, sin importar el día; se envía el día y la
        hora que elijas). La web calcula las campañas todos los días a la hora que definas.
      </p>
      <Alerta tipo="info">
        {datos.fuente === "web" ? (
          <>
            Los envíos de WhatsApp usan <strong>las campañas de la web</strong>. Cada campaña sigue apagada o en simulación hasta que la enciendas en «Campañas de WhatsApp».
          </>
        ) : (
          <>
            Los envíos de WhatsApp usan <strong>las campañas que manda BigQuery</strong>. La web calcula las suyas y las compara; cuando coincidan con lo que quieres, puedes
            pasar los envíos a la web más abajo.
          </>
        )}
      </Alerta>
      {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

      <section className="rep-tarjeta">
        <div className="inicio-cab">
          <h3>Cuándo se calcula</h3>
          <button type="button" className="boton-secundario-claro" disabled={calculando || sucio} onClick={calcularAhora}>
            {calculando ? "Calculando…" : "Calcular ahora"}
          </button>
        </div>
        <label className="auto-campo ciclo-columna">
          <span>Hora del cálculo diario (hora de Hermosillo)</span>
          <input type="time" className="auto-input" value={hora} onChange={(e) => { setHora(e.target.value); setSucio(true); setAviso(null); }} />
        </label>
        <p className="rep-ayuda">
          {datos.ultima_corrida
            ? `Último cálculo: ${datos.ultima_corrida.fecha} (${datos.ultima_corrida.origen === "programado" ? "automático" : datos.ultima_corrida.origen === "manual" ? "manual" : "al guardar"}). Se evaluaron ${n(datos.ultima_corrida.evaluadas)} oportunidades abiertas y ${n(datos.ultima_corrida.asignadas)} cayeron en una campaña.`
            : "Todavía no se ha calculado. Guarda las campañas para calcular por primera vez."}{" "}
          Solo se evalúan oportunidades abiertas, de vehículos sin garantía extendida y de clientes que no pidieron la baja de WhatsApp. Quien no tiene
          teléfono utilizable entra a la campaña, pero no recibe el mensaje.
        </p>
        {sucio && <p className="rep-ayuda">Guarda los cambios para poder calcular con las reglas nuevas.</p>}
      </section>

      <section className="rep-tarjeta">
        <div className="inicio-cab">
          <h3>Campañas</h3>
          <button type="button" className="boton-guardar" disabled={!sucio || guardando} onClick={guardar}>
            {guardando ? "Guardando…" : "Guardar y calcular"}
          </button>
        </div>
        <p className="rep-ayuda">
          Si una oportunidad cumple las reglas de varias campañas, se queda con la que esté primero en la lista. El nombre de la campaña es el que se usa en
          la pestaña «Campañas de WhatsApp».
        </p>

        {filas.map((f, i) => (
          <div key={f.clave} className={`camp-def${f.activa ? "" : " camp-def-apagada"}`}>
            <div className="camp-def-cab">
              <span className="camp-def-orden">{i + 1}</span>
              <input type="text" className="auto-input" maxLength={30} placeholder="Nombre (letras, números y _)" title="Solo letras, números y guion bajo, sin espacios" value={f.nombre} onChange={(e) => editar(f.clave, { nombre: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} aria-label="Nombre de la campaña" />
              <select className="auto-input" value={f.tipo} onChange={(e) => cambiarTipo(f.clave, e.target.value as Tipo)} aria-label="Tipo de campaña">
                <option value="dias">Por días</option>
                <option value="meses">Por meses</option>
              </select>
              <label className="camp-def-activa">
                <input type="checkbox" checked={f.activa} onChange={(e) => editar(f.clave, { activa: e.target.checked })} /> Activa
              </label>
              <button type="button" className="auto-quitar" aria-label="Subir" disabled={i === 0} onClick={() => mover(i, -1)}>
                ↑
              </button>
              <button type="button" className="auto-quitar" aria-label="Bajar" disabled={i === filas.length - 1} onClick={() => mover(i, 1)}>
                ↓
              </button>
              <button type="button" className="auto-quitar" aria-label={`Quitar ${f.nombre || "campaña"}`} onClick={() => cambiar((x) => x.filter((y) => y.clave !== f.clave))}>
                <IconoXMarca className="icono-inline" />
              </button>
            </div>

            <div className="camp-def-campos">
              <label className="auto-campo">
                <span>Fecha que se usa</span>
                <select className="auto-input" value={f.columna_fecha} onChange={(e) => editar(f.clave, { columna_fecha: e.target.value })}>
                  {datos.columnas_fecha.map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {c.etiqueta}
                    </option>
                  ))}
                </select>
              </label>
              {f.tipo === "dias" ? (
                <>
                  <label className="auto-campo">
                    <span>Desde (días)</span>
                    <input type="number" min={0} max={3650} className="auto-input" value={f.dias_desde ?? 0} onChange={(e) => editar(f.clave, { dias_desde: entero(e.target.value, 0, 3650) })} />
                  </label>
                  <label className="auto-campo">
                    <span>Hasta (días, sin incluir)</span>
                    <input type="number" min={1} max={3650} className="auto-input" value={f.dias_hasta ?? 1} onChange={(e) => editar(f.clave, { dias_hasta: entero(e.target.value, 1, 3650) })} />
                  </label>
                </>
              ) : (
                <>
                  <label className="auto-campo">
                    <span>Fecha de hace (meses)</span>
                    <input type="number" min={0} max={120} className="auto-input" value={f.meses_atras ?? 0} onChange={(e) => editar(f.clave, { meses_atras: entero(e.target.value, 0, 120) })} />
                  </label>
                  <label className="auto-campo">
                    <span>Día del mes del envío</span>
                    <input type="number" min={1} max={28} className="auto-input" value={f.dia_envio ?? 1} onChange={(e) => editar(f.clave, { dia_envio: entero(e.target.value, 1, 28) })} />
                  </label>
                  <label className="auto-campo">
                    <span>Hora del envío</span>
                    <input type="time" className="auto-input" value={f.hora_envio ?? "09:00"} onChange={(e) => editar(f.clave, { hora_envio: e.target.value })} />
                  </label>
                </>
              )}
              <label className="auto-campo">
                <span>Etapa del vehículo</span>
                <select
                  className="auto-input"
                  value={f.etapa_orden ?? ""}
                  disabled={etapas.length === 0}
                  title={etapas.length === 0 ? "Define las etapas del vehículo para poder elegir una" : undefined}
                  onChange={(e) => editar(f.clave, { etapa_orden: e.target.value === "" ? null : Number(e.target.value) })}
                >
                  <option value="">Cualquiera</option>
                  {etapas.map((e) => (
                    <option key={e.orden} value={e.orden}>
                      {e.nombre}
                    </option>
                  ))}
                  {f.etapa_orden !== null && !etapas.some((e) => e.orden === f.etapa_orden) && <option value={f.etapa_orden}>Etapa {f.etapa_orden} (ya no existe)</option>}
                </select>
              </label>
            </div>
            <p className="rep-ayuda">{describir(f)}</p>
          </div>
        ))}
        {filas.length === 0 && <p className="auto-vacio">Todavía no hay campañas. Agrega la primera.</p>}

        <div className="camp-def-agregar">
          <button type="button" className="boton-secundario-claro auto-agregar" disabled={filas.length >= 20} onClick={() => cambiar((f) => [...f, { ...NUEVA_DIAS, clave: clave() }])}>
            Agregar campaña por días
          </button>
          <button type="button" className="boton-secundario-claro auto-agregar" disabled={filas.length >= 20} onClick={() => cambiar((f) => [...f, { ...NUEVA_MESES, clave: clave() }])}>
            Agregar campaña por meses
          </button>
        </div>
      </section>

      <section className="rep-tarjeta">
        <h3>Comparación con BigQuery</h3>
        {!cmp ? (
          <p className="auto-vacio">Guarda las campañas para ver cuántas oportunidades coinciden con las de BigQuery.</p>
        ) : (
          <>
            <div className="tabla-envoltura">
              <table className="tabla">
                <thead>
                  <tr>
                    <th>Campaña</th>
                    <th>Web</th>
                    <th>BigQuery</th>
                    <th>Coinciden</th>
                    <th>Solo web</th>
                    <th>Solo BigQuery</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.por_campana.map((c) => (
                    <tr key={c.campana}>
                      <td>{c.campana}</td>
                      <td>{n(c.web)}</td>
                      <td>{n(c.bigquery)}</td>
                      <td>{n(c.coinciden)}</td>
                      <td className={c.solo_web > 0 ? "camp-def-dif" : undefined}>{n(c.solo_web)}</td>
                      <td className={c.solo_bigquery > 0 ? "camp-def-dif" : undefined}>{n(c.solo_bigquery)}</td>
                    </tr>
                  ))}
                  {cmp.por_campana.length === 0 && (
                    <tr>
                      <td colSpan={6} className="auto-vacio">
                        Ninguna oportunidad cayó en una campaña, ni en la web ni en BigQuery.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="rep-ayuda">
              {n(cmp.sin_campana)} oportunidades abiertas no tienen campaña ni en la web ni en BigQuery.{" "}
              {hayDiferencias
                ? "Donde hay diferencias, ajusta las reglas (por ejemplo los días de una campaña) hasta que la web coincida con lo que quieres."
                : "La web coincide con BigQuery en todas las campañas."}
            </p>
            {cmp.cruces.length > 0 && (
              <>
                <h4 className="camp-def-sub">Dónde difieren</h4>
                <ul className="camp-def-cruces">
                  {cmp.cruces.map((c, i) => (
                    <li key={i}>
                      <strong>{n(c.total)}</strong> — web: {c.web ?? "sin campaña"} · BigQuery: {c.bigquery ?? "sin campaña"}
                    </li>
                  ))}
                </ul>
                <details className="camp-def-ejemplos">
                  <summary>Ver ejemplos ({cmp.ejemplos.length})</summary>
                  <div className="tabla-envoltura">
                    <table className="tabla">
                      <thead>
                        <tr>
                          <th>Cliente</th>
                          <th>Fecha factura</th>
                          <th>Fecha reporte</th>
                          <th>Web</th>
                          <th>BigQuery</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cmp.ejemplos.map((e, i) => (
                          <tr key={i}>
                            <td>{e.cliente}</td>
                            <td>{e.fecha_factura ?? "—"}</td>
                            <td>{e.fecha_reporte ?? "—"}</td>
                            <td>{e.web ?? "—"}</td>
                            <td>{e.bigquery ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </>
        )}
      </section>

      <section className="rep-tarjeta">
        <div className="inicio-cab">
          <h3>Quién manda la campaña a los envíos</h3>
          {datos.fuente === "web" ? (
            <button type="button" className="boton-secundario-claro" disabled={cambiandoFuente || sucio} onClick={() => cambiarFuente("bigquery")}>
              {cambiandoFuente ? "Cambiando…" : "Volver a BigQuery"}
            </button>
          ) : (
            <button type="button" className="boton-guardar" disabled={cambiandoFuente || sucio || !datos.ultima_corrida || filas.length === 0} onClick={() => cambiarFuente("web")}>
              {cambiandoFuente ? "Cambiando…" : "Pasar los envíos a la web"}
            </button>
          )}
        </div>
        <p className="rep-ayuda">
          Hoy: <strong>{datos.fuente === "web" ? "la web" : "BigQuery"}</strong>. Con la web, los mensajes salen según las campañas de arriba: los días de cada paso se cuentan desde el inicio de la campaña
          del lead (en las campañas por meses, desde el día de envío del mes; la hora del primer mensaje es la de la campaña salvo que el paso tenga la suya). Si un lead llega a una cohorte
          mensual después del día de envío, recibe el mensaje en cuanto abra la ventana de envío siempre que siga dentro de la vigencia del paso; si no, se omite y queda registrado.
          Una vez que un lead empezó la cadencia, sigue aunque salga de la ventana de la campaña, y se corta si compra una garantía, pide la baja o la web lo pasa a otra campaña.
        </p>
        {!datos.ultima_corrida && <p className="rep-ayuda">Primero guarda y calcula las campañas.</p>}
        {sucio && <p className="rep-ayuda">Guarda los cambios antes de cambiar la fuente.</p>}
      </section>

      <section className="rep-tarjeta">
        <h3>Probar una fecha</h3>
        <p className="rep-ayuda">Escribe una fecha y mira en qué campaña caería hoy, con las reglas guardadas. No toca ningún dato.</p>
        <div className="auto-cuerpo">
          <label className="auto-campo">
            <span>Fecha del vehículo</span>
            <input type="date" className="auto-input" value={pruebaFecha} onChange={(e) => { setPruebaFecha(e.target.value); setPrueba(null); }} />
          </label>
          <label className="auto-campo">
            <span>Etapa del vehículo</span>
            <select className="auto-input" value={pruebaEtapa} disabled={etapas.length === 0} onChange={(e) => { setPruebaEtapa(e.target.value); setPrueba(null); }}>
              <option value="">Sin etapa</option>
              {etapas.map((e) => (
                <option key={e.orden} value={e.orden}>
                  {e.nombre}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="button" className="boton-secundario-claro auto-agregar" onClick={probar} disabled={sucio || !pruebaFecha}>
          Ver la campaña
        </button>
        {sucio && <p className="rep-ayuda">Guarda primero para probar con las reglas nuevas.</p>}
        {prueba && (
          <Alerta tipo={prueba.elegida ? "ok" : "info"}>
            {prueba.elegida ? (
              <>
                Hoy ({prueba.hoy}) caería en <strong>{prueba.elegida}</strong>.
              </>
            ) : (
              <>Hoy ({prueba.hoy}) no caería en ninguna campaña.</>
            )}{" "}
            {prueba.resultado.length > 0 && (
              <>Reglas que cumple: {prueba.resultado.filter((r) => r.entra).map((r) => r.nombre).join(", ") || "ninguna"}.</>
            )}
          </Alerta>
        )}
      </section>
    </>
  );
}
