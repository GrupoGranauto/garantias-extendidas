import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoChevron, IconoXMarca } from "../componentes/Iconos";
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

type Respuesta = {
  campanas: Def[];
  etapas_vehiculo: { orden: number; nombre: string }[];
  columnas_fecha: { valor: string; etiqueta: string }[];
  hora_calculo: string;
  ultimo_calculo: string | null;
  ultima_corrida: { fecha: string; origen: string; evaluadas: number; asignadas: number; traslapes: number; ejecutado_en: string } | null;
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
 * a la hora elegida, y de ellas salen las oportunidades de cada campaña y sus envíos.
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
  const etapas = datos.etapas_vehiculo;

  return (
    <>
      <p className="pestana-descripcion">
        Tú decides quién entra a cada campaña. Hay dos tipos: <strong>por días</strong> (una ventana de días desde la fecha del vehículo; se recalcula todos
        los días) y <strong>por meses</strong> (una cohorte: todo lo que tenga la fecha en el mes de hace N meses, sin importar el día). La web calcula las campañas todos los días a la hora que definas.
      </p>
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
          Si una oportunidad cumple las reglas de varias campañas, se queda con la que esté primero en la lista.
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
                <IconoChevron className="icono-inline icono-arriba" />
              </button>
              <button type="button" className="auto-quitar" aria-label="Bajar" disabled={i === filas.length - 1} onClick={() => mover(i, 1)}>
                <IconoChevron className="icono-inline" />
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
