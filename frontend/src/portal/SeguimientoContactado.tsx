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
  espera_horas: number;
  telefonos_prueba: string[];
  plantillas: { id: string; nombre: string; de_la_campana: boolean }[];
  en_contactado: number;
  ya_toca: number;
  enviados_hoy: number;
};
type Datos = { horario: { inicio: string; fin: string }; campanas: Campana[] };
type Unidad = "horas" | "dias";
type Borrador = Pick<Campana, "activa" | "plantilla_id"> & { cantidad: string; unidad: Unidad; prueba: string };

const n = (v: number) => v.toLocaleString("es-MX");

/** La espera guardada en horas, mostrada en días cuando es un número exacto de días. */
const aBorrador = (c: Campana): Borrador => {
  const enDias = c.espera_horas % 24 === 0;
  return {
    activa: c.activa,
    plantilla_id: c.plantilla_id,
    cantidad: String(enDias ? c.espera_horas / 24 : c.espera_horas),
    unidad: enDias ? "dias" : "horas",
    prueba: c.telefonos_prueba.join(", "),
  };
};
const horasDe = (b: Borrador) => Math.round(Number(b.cantidad) * (b.unidad === "dias" ? 24 : 1));

/**
 * Seguimiento de leads «Contactado»: por campaña se elige la plantilla y cuánto tiempo después de la última interacción
 * (llamada o mensaje de WhatsApp) sale. Le llega una sola vez por campaña a cada lead, con el mismo freno que cualquier masivo.
 */
export default function SeguimientoContactado() {
  const { portal } = usePortal();
  const base = `/api/admin/sucursales/${portal!.id}/crm/masivos/seguimiento`;
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
    const b = borradores[campana];
    const horas = horasDe(b);
    if (!Number.isInteger(horas) || horas < 1 || horas > 720) {
      setAvisos((a) => ({ ...a, [campana]: { tipo: "error", texto: "El tiempo de espera va de 1 hora a 30 días." } }));
      return;
    }
    setGuardando(campana);
    setAvisos((a) => ({ ...a, [campana]: undefined }));
    try {
      const telefonos_prueba = b.prueba.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
      const d = await apiFetch<Datos>(`${base}/${campana}`, {
        method: "PUT",
        body: JSON.stringify({ activa: b.activa, plantilla_id: b.plantilla_id, espera_horas: horas, telefonos_prueba }),
      });
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
        <h2>Seguimiento</h2>
        <p>
          A los leads que siguen en «Contactado» les llega solo el mensaje de seguimiento cuando pasa el tiempo que elijas desde su
          última interacción: la última llamada registrada, el último mensaje de WhatsApp (enviado o recibido) o su «Fecha último
          contacto». A cada lead le llega una sola vez por campaña.
        </p>
        <p className="campo-ayuda">
          Pasa por el mismo freno que cualquier mensaje: no le llega a quien pidió la baja, ya tiene GE o ya pagó; si ese día ya
          recibió otro mensaje, se vuelve a intentar después. Se revisa cada 15 minutos y nunca sale fuera del horario de{" "}
          {datos.horario.inicio} a {datos.horario.fin}.
        </p>
      </header>

      <div className="pm-tarjetas">
        {datos.campanas.map((c) => {
          const b = borradores[c.campana];
          if (!b) return null;
          const horas = horasDe(b);
          const sucia =
            b.activa !== c.activa ||
            b.plantilla_id !== c.plantilla_id ||
            horas !== c.espera_horas ||
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
                <label htmlFor={`sg-plantilla-${c.campana}`}>Plantilla que se manda</label>
                <select
                  id={`sg-plantilla-${c.campana}`}
                  value={b.plantilla_id ?? ""}
                  onChange={(e) => cambiar({ plantilla_id: e.target.value || null })}
                >
                  <option value="">Elige una plantilla</option>
                  {b.plantilla_id && !c.plantillas.some((p) => p.id === b.plantilla_id) && (
                    <option value={b.plantilla_id} disabled>
                      La plantilla guardada ya no se puede usar
                    </option>
                  )}
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
                <label htmlFor={`sg-espera-${c.campana}`}>Sale después de la última interacción</label>
                <div className="sg-espera">
                  <input
                    id={`sg-espera-${c.campana}`}
                    type="number"
                    min={1}
                    max={b.unidad === "dias" ? 30 : 720}
                    step={1}
                    value={b.cantidad}
                    onChange={(e) => cambiar({ cantidad: e.target.value })}
                  />
                  <select aria-label="Unidad" value={b.unidad} onChange={(e) => cambiar({ unidad: e.target.value as Unidad })}>
                    <option value="horas">horas</option>
                    <option value="dias">días</option>
                  </select>
                </div>
              </div>

              <div className="campo-formulario">
                <label htmlFor={`sg-prueba-${c.campana}`}>Solo para probar: teléfonos (10 dígitos)</label>
                <input
                  id={`sg-prueba-${c.campana}`}
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
                  Leads en «Contactado» sin su seguimiento: <strong>{n(c.en_contactado)}</strong>
                </span>
                <span>
                  Ya les toca: <strong>{n(c.ya_toca)}</strong>
                </span>
                <span>
                  Mandados hoy: <strong>{n(c.enviados_hoy)}</strong>
                </span>
              </div>

              {b.activa && !c.activa && c.ya_toca > 0 && !b.prueba.trim() && (
                <Alerta tipo="info">
                  Al encenderla le llega a los {n(c.ya_toca)} leads a los que ya les toca, si cumplen las reglas de la plantilla.
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
