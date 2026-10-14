import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import Interruptor from "../componentes/Interruptor";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Omitido = { motivo: string; texto: string; n: number };
type Campana = {
  campana: string;
  etiqueta: string;
  activa: boolean;
  plantilla_id: string | null;
  dias_semana: number[];
  hora: string;
  telefonos_prueba: string[];
  plantillas: { id: string; nombre: string; de_la_campana: boolean }[];
  sin_primer_mensaje: number;
  proximo: { fecha: string; hora: string } | null;
  esperando_base: boolean;
  ultima: {
    fecha: string;
    enviados: number;
    en_cola: number;
    fallidos: number;
    omitidos: number;
    omitidos_resumen: Omitido[];
    nota: string | null;
  } | null;
};
type Datos = { horario: { inicio: string; fin: string }; hora_sin_base: string; campanas: Campana[] };
type Borrador = Pick<Campana, "activa" | "plantilla_id" | "dias_semana" | "hora"> & { prueba: string };

const DIAS = [
  { n: 1, corto: "L", nombre: "Lunes" },
  { n: 2, corto: "M", nombre: "Martes" },
  { n: 3, corto: "X", nombre: "Miércoles" },
  { n: 4, corto: "J", nombre: "Jueves" },
  { n: 5, corto: "V", nombre: "Viernes" },
  { n: 6, corto: "S", nombre: "Sábado" },
  { n: 7, corto: "D", nombre: "Domingo" },
];

const hoyLocal = () => new Date().toLocaleDateString("en-CA");

/** «hoy», «mañana» o «lunes 20 de octubre». */
function cuando(fecha: string): string {
  const hoy = hoyLocal();
  const manana = new Date(`${hoy}T12:00:00`);
  manana.setDate(manana.getDate() + 1);
  if (fecha === hoy) return "hoy";
  if (fecha === manana.toLocaleDateString("en-CA")) return "mañana";
  return new Date(`${fecha}T12:00:00`).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
}

const n = (v: number) => v.toLocaleString("es-MX");

/**
 * Primer mensaje automático: lo único de WhatsApp que sale solo. Por campaña se elige la plantilla, los días de la semana y la
 * hora a partir de la cual sale; cada día permitido le llega a los leads de esa campaña que aún no lo reciben.
 */
export default function PrimerMensajeAutomatico() {
  const { portal } = usePortal();
  const base = `/api/admin/sucursales/${portal!.id}/crm/masivos/primer-mensaje`;
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [borradores, setBorradores] = useState<Record<string, Borrador>>({});
  const [guardando, setGuardando] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<Record<string, { tipo: "ok" | "error"; texto: string } | undefined>>({});

  const recibir = (d: Datos) => {
    setDatos(d);
    setBorradores(
      Object.fromEntries(
        d.campanas.map((c) => [c.campana, { activa: c.activa, plantilla_id: c.plantilla_id, dias_semana: c.dias_semana, hora: c.hora, prueba: c.telefonos_prueba.join(", ") }]),
      ),
    );
  };

  useEffect(() => {
    apiFetch<Datos>(base)
      .then(recibir)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar."));
  }, [base]);

  async function guardar(campana: string) {
    setGuardando(campana);
    setAvisos((a) => ({ ...a, [campana]: undefined }));
    try {
      const { prueba, ...resto } = borradores[campana];
      const telefonos_prueba = prueba.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
      const d = await apiFetch<Datos>(`${base}/${campana}`, { method: "PUT", body: JSON.stringify({ ...resto, telefonos_prueba }) });
      recibir(d);
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
        <h2>Primer mensaje automático</h2>
        <p>
          Lo único de WhatsApp que sale solo. Cada día marcado, a partir de su hora, le llega el primer mensaje de la campaña a los
          leads que aún no lo reciben y cumplen las reglas de la plantilla (por ejemplo, «Por contactar»). A cada lead le llega una
          sola vez por campaña, aunque la base se reemplace cada día.
        </p>
        <p className="campo-ayuda">
          Espera a que la base del día se actualice; si a las {datos.hora_sin_base} no se ha actualizado, sale con la que haya (si la
          base lleva más de 36 horas sin actualizarse, no la espera). Nunca
          sale fuera del horario de {datos.horario.inicio} a {datos.horario.fin}. Si Meta no lo entrega por su límite de mensajes de
          marketing, se reintenta una sola vez el siguiente día permitido.
        </p>
      </header>

      <div className="pm-tarjetas">
        {datos.campanas.map((c) => {
          const b = borradores[c.campana];
          if (!b) return null;
          const sucia =
            b.activa !== c.activa ||
            b.plantilla_id !== c.plantilla_id ||
            b.hora !== c.hora ||
            b.dias_semana.join() !== c.dias_semana.join() ||
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
                <label htmlFor={`pm-plantilla-${c.campana}`}>Plantilla del primer mensaje</label>
                <select
                  id={`pm-plantilla-${c.campana}`}
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

              <div className="campo-formulario">
                <span className="pm-etiqueta">Días que se puede enviar</span>
                <div className="reglas-opciones">
                  {DIAS.map((d) => {
                    const marcado = b.dias_semana.includes(d.n);
                    return (
                      <label key={d.n} className={`reglas-opcion${marcado ? " reglas-opcion-activa" : ""}`} title={d.nombre}>
                        <input
                          type="checkbox"
                          checked={marcado}
                          onChange={() =>
                            cambiar({ dias_semana: marcado ? b.dias_semana.filter((x) => x !== d.n) : [...b.dias_semana, d.n].sort((x, y) => x - y) })
                          }
                        />
                        {d.nombre}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="campo-formulario pm-hora">
                <label htmlFor={`pm-hora-${c.campana}`}>A partir de las</label>
                <input
                  id={`pm-hora-${c.campana}`}
                  type="time"
                  min={datos.horario.inicio}
                  max="19:59"
                  step={300}
                  value={b.hora}
                  onChange={(e) => cambiar({ hora: e.target.value })}
                />
              </div>

              <div className="campo-formulario">
                <label htmlFor={`pm-prueba-${c.campana}`}>Solo para probar: teléfonos (10 dígitos)</label>
                <input
                  id={`pm-prueba-${c.campana}`}
                  type="text"
                  inputMode="numeric"
                  placeholder="Vacío = a todos los leads de la campaña"
                  value={b.prueba}
                  onChange={(e) => cambiar({ prueba: e.target.value })}
                />
                <p className="campo-ayuda">Mientras haya alguno, el envío automático solo le llega a esos teléfonos. Sepáralos con coma.</p>
              </div>

              <div className="pm-estado">
                {!c.activa ? (
                  <span>Apagado: no sale nada solo.</span>
                ) : c.esperando_base ? (
                  <span>Hoy espera a que se actualice la base; a más tardar sale a las {datos.hora_sin_base}.</span>
                ) : c.proximo ? (
                  <span>
                    Próximo envío: <strong>{cuando(c.proximo.fecha)}</strong> desde las {c.proximo.hora}.
                  </span>
                ) : null}
                <span>
                  Leads sin primer mensaje en esta campaña: <strong>{n(c.sin_primer_mensaje)}</strong>
                </span>
              </div>

              {b.activa && !c.activa && c.sin_primer_mensaje > 0 && !b.prueba.trim() && (
                <Alerta tipo="info">
                  Al encenderla, en el próximo envío le llega a los {n(c.sin_primer_mensaje)} leads que hoy están sin primer mensaje, si
                  cumplen las reglas de la plantilla.
                </Alerta>
              )}

              {c.ultima && (
                <div className="pm-ultima">
                  <span>
                    Última vez ({cuando(c.ultima.fecha)}): {n(c.ultima.enviados)} enviados
                    {c.ultima.en_cola > 0 && ` · ${n(c.ultima.en_cola)} en cola`}
                    {c.ultima.fallidos > 0 && ` · ${n(c.ultima.fallidos)} no entregados`} · {n(c.ultima.omitidos)} omitidos
                  </span>
                  {c.ultima.omitidos_resumen.length > 0 && (
                    <ul>
                      {c.ultima.omitidos_resumen.map((o) => (
                        <li key={o.motivo}>
                          {n(o.n)}: {o.texto}
                        </li>
                      ))}
                    </ul>
                  )}
                  {c.ultima.nota && <Alerta tipo="error">No se pudo enviar: {c.ultima.nota}</Alerta>}
                </div>
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
