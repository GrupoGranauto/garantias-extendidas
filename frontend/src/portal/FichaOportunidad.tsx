import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";

type Entrada = { tipo: string; titulo: string; detalle: Record<string, unknown> | null; autor: string | null; creado_en: string };
type TareaPendiente = { id: string; tipo: "tarea" | "pregunta"; titulo: string; descripcion: string | null; vence_en: string | null };
type Ficha = {
  oportunidad: Record<string, unknown>;
  etiquetas: Record<string, string>;
  contrato: { estado: string; folio: string | null };
  exigir_evidencia_venta: boolean;
  tareas: TareaPendiente[];
  linea_tiempo: Entrada[];
  estados_contrato: string[];
};

type Props = {
  sucursalId: string;
  oportunidadId: string;
  onCerrar: () => void;
  /** Avisa a la tabla/embudo que algo cambió para que se recarguen. */
  onCambio: () => void;
};

const CANALES = [
  { valor: "llamada", texto: "Llamada" },
  { valor: "whatsapp", texto: "WhatsApp" },
];
const RESULTADOS = [
  { valor: "contesto", texto: "Contestó" },
  { valor: "no_contesto", texto: "No contestó" },
  { valor: "buzon", texto: "Buzón de voz" },
  { valor: "numero_equivocado", texto: "Número equivocado" },
];

const ETIQUETA_CONTRATO: Record<string, string> = {
  sin_contrato: "Sin contrato",
  cotizado: "Cotizado",
  aceptado: "Aceptado por el cliente",
  orden_pago: "Orden de pago generada",
  pago_confirmado: "Pago confirmado",
  certificado_entregado: "Certificado entregado",
  cobertura_iniciada: "Cobertura iniciada",
  cancelado: "Cancelado",
};

/** Columnas que se muestran como datos, en este orden (solo las que la ficha recibió). */
const DATOS = [
  "telefono_principal", "correo", "vin", "agencia", "linea", "version_vehiculo", "anio_vin", "campana", "fase_campana",
  "inicio_campana", "fin_campana", "proxima_campania", "fecha_proxima_campania", "estado_fuente", "intentos",
  "fecha_ultimo_contacto", "fecha_compra", "comentarios", "motivo_perdida",
];

function formato(valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "—";
  const s = String(valor);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00").toLocaleDateString();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
  }
  return s;
}

function cuando(valor: string): string {
  const d = new Date(valor);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function detalleEntrada(e: Entrada): string | null {
  const d = e.detalle ?? {};
  if (e.tipo === "nota" && d.texto) return String(d.texto);
  if ((e.tipo === "llamada" || e.tipo === "whatsapp") && d.nota) return String(d.nota);
  if (e.tipo === "edicion" || e.tipo === "reasignacion") {
    const a = d.anterior === null || d.anterior === undefined || d.anterior === "" ? "vacío" : formato(d.anterior);
    const n = d.nuevo === null || d.nuevo === undefined || d.nuevo === "" ? "vacío" : formato(d.nuevo);
    return `${a} → ${n}`;
  }
  if (e.tipo === "etapa" && d.motivo) return `Motivo: ${String(d.motivo)}`;
  if (e.tipo === "tarea" && d.respuesta) return `Respuesta: ${String(d.respuesta)}`;
  return null;
}

/**
 * Ficha de una oportunidad: quién es, qué falta hacer y qué ha pasado. Desde aquí se registra cada
 * contacto (llamada o WhatsApp), se dejan notas y se lleva el contrato, que es la evidencia de una venta.
 */
export default function FichaOportunidad({ sucursalId, oportunidadId, onCerrar, onCambio }: Props) {
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const [canal, setCanal] = useState("llamada");
  const [resultado, setResultado] = useState("contesto");
  const [nota, setNota] = useState("");
  const [textoNota, setTextoNota] = useState("");
  const [estadoContrato, setEstadoContrato] = useState("sin_contrato");
  const [folio, setFolio] = useState("");

  const base = `/api/admin/sucursales/${sucursalId}/crm/oportunidades/${oportunidadId}`;

  const cargar = useCallback(() => {
    apiFetch<Ficha>(base)
      .then((f) => {
        setFicha(f);
        setEstadoContrato(f.contrato.estado);
        setFolio(f.contrato.folio ?? "");
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la ficha."));
  }, [base]);

  useEffect(cargar, [cargar]);

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  async function accion(ruta: string, metodo: "POST" | "PUT", cuerpo: unknown, exito: string, despues?: () => void) {
    setEnviando(true);
    setAviso(null);
    try {
      await apiFetch(`${base}/${ruta}`, { method: metodo, body: JSON.stringify(cuerpo) });
      setAviso({ tipo: "ok", texto: exito });
      despues?.();
      cargar();
      onCambio();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setEnviando(false);
    }
  }

  async function completarTarea(t: TareaPendiente) {
    setEnviando(true);
    setAviso(null);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/crm/tareas/${t.id}/completar`, { method: "POST", body: JSON.stringify({}) });
      cargar();
      onCambio();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo completar." });
    } finally {
      setEnviando(false);
    }
  }

  const op = ficha?.oportunidad;
  const eti = ficha?.etiquetas ?? {};

  return (
    <div className="ficha-fondo" onClick={onCerrar}>
      <aside className="ficha" role="dialog" aria-modal="true" aria-label="Ficha de la oportunidad" onClick={(e) => e.stopPropagation()}>
        <header className="ficha-cab">
          <div>
            <h2>{op ? String(op.cliente ?? "Sin nombre") : "Oportunidad"}</h2>
            {op && (
              <p className="ficha-sub">
                {[op.etapa_embudo, op.estado_contacto, op.ejecutivo].filter(Boolean).map(String).join(" · ")}
              </p>
            )}
          </div>
          <button type="button" className="ficha-cerrar" aria-label="Cerrar" onClick={onCerrar}>
            <IconoXMarca className="icono-inline" />
          </button>
        </header>

        {error && <Alerta tipo="error">{error}</Alerta>}
        {!ficha && !error && <Cargador />}

        {ficha && op && (
          <div className="ficha-cuerpo">
            {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

            <section className="ficha-sec">
              <h3>Registrar contacto</h3>
              <div className="ficha-fila">
                <select className="auto-input" value={canal} onChange={(e) => setCanal(e.target.value)} aria-label="Canal">
                  {CANALES.map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {c.texto}
                    </option>
                  ))}
                </select>
                <select className="auto-input" value={resultado} onChange={(e) => setResultado(e.target.value)} aria-label="Resultado">
                  {RESULTADOS.filter((r) => !(canal === "whatsapp" && r.valor === "buzon")).map((r) => (
                    <option key={r.valor} value={r.valor}>
                      {canal === "whatsapp" && r.valor === "contesto" ? "Respondió" : canal === "whatsapp" && r.valor === "no_contesto" ? "Sin respuesta" : r.texto}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                className="auto-input"
                placeholder="Nota breve (opcional)"
                maxLength={500}
                value={nota}
                onChange={(e) => setNota(e.target.value)}
              />
              <button
                type="button"
                className="boton-guardar"
                disabled={enviando}
                onClick={() =>
                  accion("contacto", "POST", { canal, resultado: canal === "whatsapp" && resultado === "buzon" ? "no_contesto" : resultado, nota: nota.trim() || null }, "Contacto registrado.", () => setNota(""))
                }
              >
                Registrar
              </button>
              <p className="ficha-ayuda">Suma un intento, pone hoy como último contacto y actualiza el estado de contacto. La etapa no se mueve sola.</p>
            </section>

            {ficha.tareas.length > 0 && (
              <section className="ficha-sec">
                <h3>Pendientes</h3>
                {ficha.tareas.map((t) => (
                  <div key={t.id} className="ficha-tarea">
                    <div>
                      <strong>{t.titulo}</strong>
                      {t.descripcion && <p>{t.descripcion}</p>}
                      {t.vence_en && <small>Vence {cuando(t.vence_en)}</small>}
                    </div>
                    {t.tipo === "tarea" ? (
                      <button type="button" className="boton-secundario-claro" disabled={enviando} onClick={() => completarTarea(t)}>
                        Hecha
                      </button>
                    ) : (
                      <small>Se responde en Tareas</small>
                    )}
                  </div>
                ))}
              </section>
            )}

            <section className="ficha-sec">
              <h3>Datos</h3>
              <dl className="ficha-datos">
                {DATOS.filter((c) => c in op).map((c) => (
                  <div key={c}>
                    <dt>{eti[c] ?? c}</dt>
                    <dd>{formato(op[c])}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="ficha-sec">
              <h3>Contrato</h3>
              {ficha.exigir_evidencia_venta && (
                <p className="ficha-ayuda">Para marcar la venta se necesita llegar a «Certificado entregado»: una venta es pago y certificado, no interés.</p>
              )}
              <div className="ficha-fila">
                <select className="auto-input" value={estadoContrato} onChange={(e) => setEstadoContrato(e.target.value)} aria-label="Estado del contrato">
                  {ficha.estados_contrato.map((e) => (
                    <option key={e} value={e}>
                      {ETIQUETA_CONTRATO[e] ?? e}
                    </option>
                  ))}
                </select>
                <input type="text" className="auto-input" placeholder="Folio" maxLength={60} value={folio} onChange={(e) => setFolio(e.target.value)} />
              </div>
              <button
                type="button"
                className="boton-secundario-claro"
                disabled={enviando}
                onClick={() => accion("contrato", "PUT", { estado: estadoContrato, folio: folio.trim() || null }, "Contrato guardado.")}
              >
                Guardar contrato
              </button>
            </section>

            <section className="ficha-sec">
              <h3>Nota</h3>
              <textarea className="auto-input" rows={2} maxLength={1000} placeholder="Escribe una nota para el equipo" value={textoNota} onChange={(e) => setTextoNota(e.target.value)} />
              <button
                type="button"
                className="boton-secundario-claro"
                disabled={enviando || textoNota.trim() === ""}
                onClick={() => accion("notas", "POST", { texto: textoNota }, "Nota agregada.", () => setTextoNota(""))}
              >
                Agregar nota
              </button>
            </section>

            <section className="ficha-sec">
              <h3>Historial</h3>
              {ficha.linea_tiempo.length === 0 && <p className="ficha-ayuda">Todavía no hay actividad.</p>}
              <ol className="ficha-linea">
                {ficha.linea_tiempo.map((e, i) => {
                  const d = detalleEntrada(e);
                  return (
                    <li key={i} className={`ficha-evento ficha-evento-${e.tipo}`}>
                      <span className="ficha-evento-punto" />
                      <div>
                        <strong>{e.titulo}</strong>
                        {d && <p>{d}</p>}
                        <small>
                          {cuando(e.creado_en)}
                          {e.autor ? ` · ${e.autor}` : ""}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
