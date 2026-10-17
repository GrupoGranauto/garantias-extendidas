import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import Interruptor from "../componentes/Interruptor";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Campana = {
  campana: string;
  etiqueta: string;
  activa: boolean;
  plantilla_id: string | null;
  intentos: number;
  resultados: string[];
  telefonos_prueba: string[];
  plantillas: { id: string; nombre: string; de_la_campana: boolean }[];
  esperando: number;
  enviados_hoy: number;
};
type Datos = { horario: { inicio: string; fin: string }; resultados: { valor: string; texto: string }[]; campanas: Campana[] };
type Borrador = Pick<Campana, "activa" | "plantilla_id" | "intentos" | "resultados"> & { prueba: string };

const n = (v: number) => v.toLocaleString("es-MX");
const aBorrador = (c: Campana): Borrador => ({
  activa: c.activa,
  plantilla_id: c.plantilla_id,
  intentos: c.intentos,
  resultados: c.resultados,
  prueba: c.telefonos_prueba.join(", "),
});

/**
 * Mensaje por llamadas sin respuesta: por campaña se elige la plantilla, cuántas llamadas sin respuesta lo disparan y qué
 * resultados de llamada cuentan. Le llega una sola vez por campaña a cada lead, con el mismo freno que cualquier masivo.
 */
export default function SinRespuestaLlamada() {
  const { portal } = usePortal();
  const base = `/api/admin/sucursales/${portal!.id}/crm/masivos/sin-respuesta`;
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [borradores, setBorradores] = useState<Record<string, Borrador>>({});
  const [guardando, setGuardando] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<Record<string, { tipo: "ok" | "error"; texto: string } | undefined>>({});

  useEffect(() => {
    apiFetch<Datos>(base)
      .then((d) => {
        setDatos(d);
        setBorradores(Object.fromEntries(d.campanas.map((c) => [c.campana, aBorrador(c)])));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar."));
  }, [base]);

  async function guardar(campana: string) {
    setGuardando(campana);
    setAvisos((a) => ({ ...a, [campana]: undefined }));
    try {
      const { prueba, ...resto } = borradores[campana];
      const telefonos_prueba = prueba.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
      const d = await apiFetch<Datos>(`${base}/${campana}`, { method: "PUT", body: JSON.stringify({ ...resto, telefonos_prueba }) });
      setDatos(d);
      // Solo se reinicia la tarjeta guardada: lo que se esté editando en las demás no se pierde.
      const guardada = d.campanas.find((c) => c.campana === campana);
      if (guardada) setBorradores((x) => ({ ...x, [campana]: aBorrador(guardada) }));
      setAvisos((a) => ({ ...a, [campana]: { tipo: "ok", texto: "Guardado." } }));
    } catch (err) {
      setAvisos((a) => ({ ...a, [campana]: { tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." } }));
    } finally {
      setGuardando(null);
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!datos) return <Cargador />;

  return (
    <section className="pm">
      <header className="pm-cabecera">
        <h2>Sin respuesta a la llamada</h2>
        <p>
          Cuando a un lead se le registran las llamadas sin respuesta que elijas en su campaña actual, le llega solo el mensaje de
          sin respuesta a la llamada. A cada lead le llega una sola vez por campaña.
        </p>
        <p className="campo-ayuda">
          Sale al registrar la llamada que completa el número. Pasa por el mismo freno que cualquier mensaje: no le llega a quien
          pidió la baja, ya tiene GE o ya pagó; si ese día ya recibió otro mensaje, se vuelve a intentar después. Nunca sale fuera
          del horario de {datos.horario.inicio} a {datos.horario.fin}: lo que se registre fuera de horario sale en la siguiente apertura.
        </p>
      </header>

      <div className="pm-tarjetas">
        {datos.campanas.map((c) => {
          const b = borradores[c.campana];
          if (!b) return null;
          const sucia =
            b.activa !== c.activa ||
            b.plantilla_id !== c.plantilla_id ||
            b.intentos !== c.intentos ||
            [...b.resultados].sort().join() !== [...c.resultados].sort().join() ||
            b.prueba.replace(/\s/g, "") !== c.telefonos_prueba.join(",");
          const enPrueba = c.telefonos_prueba.length > 0;
          const cambiar = (cambios: Partial<Borrador>) => {
            setBorradores((x) => ({ ...x, [c.campana]: { ...x[c.campana], ...cambios } }));
            setAvisos((a) => ({ ...a, [c.campana]: undefined }));
          };
          const propias = c.plantillas.filter((p) => p.de_la_campana);
          const generales = c.plantillas.filter((p) => !p.de_la_campana);
          const aviso = avisos[c.campana];
          return (
            <article key={c.campana} className={`pm-tarjeta${c.activa ? " pm-tarjeta-activa" : ""}`}>
              <div className="pm-tarjeta-titulo">
                <h3>
                  {c.etiqueta} {enPrueba && <span className="pm-prueba">Modo prueba</span>}
                </h3>
                <Interruptor etiqueta={b.activa ? "Encendido" : "Apagado"} activo={b.activa} onChange={(v) => cambiar({ activa: v })} />
              </div>

              <div className="campo-formulario">
                <label htmlFor={`sr-plantilla-${c.campana}`}>Plantilla que se manda</label>
                <select
                  id={`sr-plantilla-${c.campana}`}
                  value={b.plantilla_id ?? ""}
                  onChange={(e) => cambiar({ plantilla_id: e.target.value || null })}
                >
                  <option value="">Elige una plantilla</option>
                  {propias.length > 0 && (
                    <optgroup label={`De ${c.etiqueta}`}>
                      {propias.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nombre}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {generales.length > 0 && (
                    <optgroup label="Generales">
                      {generales.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nombre}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              <div className="campo-formulario pm-hora">
                <label htmlFor={`sr-intentos-${c.campana}`}>Se manda al llegar a estas llamadas</label>
                <input
                  id={`sr-intentos-${c.campana}`}
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={b.intentos}
                  onChange={(e) => cambiar({ intentos: Math.trunc(Number(e.target.value)) })}
                />
              </div>

              <div className="campo-formulario">
                <span className="pm-etiqueta">Resultados de llamada que cuentan</span>
                <div className="reglas-opciones">
                  {datos.resultados.map((r) => {
                    const marcado = b.resultados.includes(r.valor);
                    return (
                      <label key={r.valor} className={`reglas-opcion${marcado ? " reglas-opcion-activa" : ""}`}>
                        <input
                          type="checkbox"
                          checked={marcado}
                          onChange={() =>
                            cambiar({ resultados: marcado ? b.resultados.filter((x) => x !== r.valor) : [...b.resultados, r.valor] })
                          }
                        />
                        {r.texto}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="campo-formulario">
                <label htmlFor={`sr-prueba-${c.campana}`}>Solo para probar: teléfonos (10 dígitos)</label>
                <input
                  id={`sr-prueba-${c.campana}`}
                  type="text"
                  inputMode="numeric"
                  placeholder="Vacío = a todos los leads de la campaña"
                  value={b.prueba}
                  onChange={(e) => cambiar({ prueba: e.target.value })}
                />
                <p className="campo-ayuda">Mientras haya alguno, el mensaje solo le llega a esos teléfonos. Sepáralos con coma.</p>
              </div>

              <div className="pm-estado">
                {!c.activa && <span>Apagado: no sale nada solo.</span>}
                <span>
                  Leads que ya llegaron al número de llamadas y esperan el mensaje: <strong>{n(c.esperando)}</strong>
                </span>
                <span>
                  Mandados hoy: <strong>{n(c.enviados_hoy)}</strong>
                </span>
              </div>

              {b.activa && !c.activa && c.esperando > 0 && !b.prueba.trim() && (
                <Alerta tipo="info">
                  Al encenderla le llega a los {n(c.esperando)} leads que ya llegaron al número de llamadas, si cumplen las reglas de
                  la plantilla.
                </Alerta>
              )}

              {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}
              <div className="pm-acciones">
                <button type="button" className="boton-guardar" disabled={!sucia || guardando === c.campana} onClick={() => guardar(c.campana)}>
                  {guardando === c.campana ? "Guardando…" : "Guardar"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
