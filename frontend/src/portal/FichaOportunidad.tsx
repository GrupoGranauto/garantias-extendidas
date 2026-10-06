import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoCheck, IconoReloj, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";

type Entrada = { tipo: string; titulo: string; detalle: Record<string, unknown> | null; autor: string | null; creado_en: string };
type TareaPendiente = { id: string; tipo: "tarea" | "pregunta"; titulo: string; descripcion: string | null; vence_en: string | null };
type Emision = {
  datos: Record<CampoEmision, string | number | null> & { direccion: string | null };
  completitud: {
    semaforo: "verde" | "ambar" | "rojo";
    faltan: { campo: string; etiqueta: string; capturable: boolean }[];
    bloqueos: string[];
    total: number;
    completos: number;
    producto: { nombre: string; banda: string; cobertura: { inicio: string; fin: string } | null } | null;
  };
  opciones: { nombre: string; plazos_meses: number[]; msi_meses: number[]; estados_circulacion: string[]; vendedores: string[]; liga_pago_horas: number };
};
type Ficha = {
  oportunidad: Record<string, unknown>;
  etiquetas: Record<string, string>;
  contrato: { estado: string; folio: string | null };
  emision: Emision | null;
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

const SEMAFORO: Record<string, { texto: string; clase: string }> = {
  verde: { texto: "Listo para emitir", clase: "ficha-semaforo-verde" },
  ambar: { texto: "Faltan datos", clase: "ficha-semaforo-ambar" },
  rojo: { texto: "No se puede emitir", clase: "ficha-semaforo-rojo" },
};

type CampoEmision =
  | "numero_factura" | "valor_factura" | "numero_motor" | "estado_circulacion"
  | "dir_cp" | "dir_estado" | "dir_municipio" | "dir_colonia" | "dir_calle" | "dir_num_ext" | "dir_num_int"
  | "plazo_meses" | "metodo_pago" | "msi_meses" | "vendedor";
type Lista = "estados" | "plazos" | "metodo" | "msi" | "vendedores";
type DefCampo = { campo: CampoEmision; etiqueta: string; ayuda?: string; max: number; ancho?: boolean; lista?: Lista; numerico?: boolean };

/** Los campos del portal de Assurant, en el orden en que los pide: vehículo, información del programa y dirección del cliente. */
const GRUPOS_EMISION: { titulo: string; campos: DefCampo[] }[] = [
  {
    titulo: "Vehículo",
    campos: [
      { campo: "numero_factura", etiqueta: "Número de factura", max: 40 },
      { campo: "valor_factura", etiqueta: "Valor de la factura", ayuda: "Con IVA, en pesos", max: 14 },
      { campo: "numero_motor", etiqueta: "Número de motor", max: 30 },
      { campo: "estado_circulacion", etiqueta: "Estado de circulación", max: 60, lista: "estados" },
    ],
  },
  {
    titulo: "Producto y pago",
    campos: [
      { campo: "plazo_meses", etiqueta: "Plazo de la extensión", max: 3, lista: "plazos" },
      { campo: "metodo_pago", etiqueta: "Método de pago", max: 20, lista: "metodo" },
      { campo: "msi_meses", etiqueta: "Meses sin intereses", max: 2, lista: "msi" },
      { campo: "vendedor", etiqueta: "Vendedor", max: 120, lista: "vendedores" },
    ],
  },
  {
    titulo: "Dirección del cliente",
    campos: [
      { campo: "dir_cp", etiqueta: "Código postal", max: 5, numerico: true },
      { campo: "dir_estado", etiqueta: "Estado", max: 60, lista: "estados" },
      { campo: "dir_municipio", etiqueta: "Municipio", max: 120 },
      { campo: "dir_colonia", etiqueta: "Colonia", max: 120 },
      { campo: "dir_calle", etiqueta: "Calle", max: 160, ancho: true },
      { campo: "dir_num_ext", etiqueta: "Número exterior", max: 20 },
      { campo: "dir_num_int", etiqueta: "Número interior (opcional)", max: 20 },
    ],
  },
];
const CAMPOS_EMISION = GRUPOS_EMISION.flatMap((g) => g.campos);

const anos = (meses: number) => (meses % 12 === 0 ? ` (+${meses / 12} ${meses === 12 ? "año" : "años"})` : "");

/** Opciones de una lista (valor guardado, texto visible). Si el programa no tiene lista, el campo es texto libre (null). */
function opcionesDe(lista: Lista | undefined, o: Emision["opciones"]): { valor: string; texto: string }[] | null {
  if (lista === "plazos") return o.plazos_meses.map((m) => ({ valor: String(m), texto: `${m} meses${anos(m)}` }));
  if (lista === "metodo") return [{ valor: "financiado", texto: "Financiado (meses sin intereses)" }, { valor: "contado", texto: "Contado" }];
  if (lista === "msi") return o.msi_meses.map((m) => ({ valor: String(m), texto: `${m} meses` }));
  if (lista === "estados" && o.estados_circulacion.length > 0) return o.estados_circulacion.map((e) => ({ valor: e, texto: e }));
  if (lista === "vendedores" && o.vendedores.length > 0) return o.vendedores.map((v) => ({ valor: v, texto: v }));
  return null;
}

/** Columnas que se muestran como datos, en este orden (solo las que la ficha recibió). */
const DATOS = [
  "telefono_principal", "correo", "vin", "agencia", "linea", "version_vehiculo", "anio_vin", "campana", "fase_campana",
  "inicio_campana", "fin_campana", "proxima_campania", "fecha_proxima_campania", "estado_fuente", "intentos",
  "fecha_ultimo_contacto", "fecha_factura", "fecha_compra", "kilometraje", "etapa_vehiculo", "comentarios", "motivo_perdida",
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
  if (e.tipo === "emision" && Array.isArray(d.campos)) return `Campos: ${d.campos.map(String).join(", ")}`;
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
  const [km, setKm] = useState("");
  const [emision, setEmision] = useState<Record<string, string>>({});

  const base = `/api/admin/sucursales/${sucursalId}/crm/oportunidades/${oportunidadId}`;

  const cargar = useCallback(() => {
    apiFetch<Ficha>(base)
      .then((f) => {
        setFicha(f);
        setEstadoContrato(f.contrato.estado);
        setFolio(f.contrato.folio ?? "");
        const kmActual = f.oportunidad.kilometraje;
        setKm(kmActual === null || kmActual === undefined ? "" : String(kmActual));
        setEmision(Object.fromEntries(CAMPOS_EMISION.map((c) => [c.campo, f.emision?.datos[c.campo] === null || f.emision?.datos[c.campo] === undefined ? "" : String(f.emision.datos[c.campo])])));
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

  /** El kilometraje lo captura el ejecutivo: se guarda al salir del campo (o con Enter) y recalcula la etapa del vehículo. */
  async function guardarKm() {
    const anterior = ficha?.oportunidad.kilometraje;
    const previo = anterior === null || anterior === undefined ? "" : String(anterior);
    const nuevo = km.replace(/[,\s]/g, "");
    if (nuevo === previo) return;
    setEnviando(true);
    setAviso(null);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/entidad/registros/${oportunidadId}`, {
        method: "PATCH",
        body: JSON.stringify({ kilometraje: nuevo }),
      });
      setAviso({ tipo: "ok", texto: "Kilometraje guardado." });
      cargar();
      onCambio();
    } catch (err) {
      setKm(previo);
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar el kilometraje." });
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
                    <dd>
                      {c === "kilometraje" ? (
                        <input
                          type="text"
                          inputMode="numeric"
                          className="auto-input ficha-km"
                          placeholder="Capturar km"
                          maxLength={9}
                          value={km}
                          disabled={enviando}
                          onChange={(e) => setKm(e.target.value.replace(/[^\d]/g, ""))}
                          onBlur={guardarKm}
                          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                          aria-label="Kilometraje"
                        />
                      ) : (
                        formato(op[c])
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            {ficha.emision && (
              <section className="ficha-sec">
                <h3>Datos para emitir</h3>
                {(() => {
                  const c = ficha.emision.completitud;
                  const s = SEMAFORO[c.semaforo];
                  const faltanAqui = c.faltan.filter((f) => !f.capturable);
                  return (
                    <>
                      <div className={`ficha-semaforo ${s.clase}`} role="status">
                        {c.semaforo === "verde" ? <IconoCheck className="icono-inline" /> : c.semaforo === "ambar" ? <IconoReloj className="icono-inline" /> : <IconoXMarca className="icono-inline" />}
                        <strong>{s.texto}</strong>
                        <span>
                          {c.completos} de {c.total} datos
                        </span>
                      </div>
                      {c.bloqueos.map((b) => (
                        <p key={b} className="ficha-ayuda ficha-ayuda-alerta">
                          {b}
                        </p>
                      ))}
                      {faltanAqui.length > 0 && (
                        <p className="ficha-ayuda">Faltan en la ficha del cliente: {faltanAqui.map((f) => f.etiqueta.toLowerCase()).join(", ")}.</p>
                      )}
                    </>
                  );
                })()}
                {GRUPOS_EMISION.map((g) => (
                  <div key={g.titulo} className="ficha-grupo">
                    <h4>{g.titulo}</h4>
                    <div className="ficha-datos">
                      {g.campos
                        // Los meses sin intereses solo aplican con pago financiado.
                        .filter((c) => c.campo !== "msi_meses" || emision.metodo_pago === "financiado")
                        .map((c) => {
                          const opciones = opcionesDe(c.lista, ficha.emision!.opciones);
                          const valor = emision[c.campo] ?? "";
                          const poner = (v: string) =>
                            setEmision((prev) => ({ ...prev, [c.campo]: v, ...(c.campo === "metodo_pago" && v !== "financiado" ? { msi_meses: "" } : {}) }));
                          return (
                            <label key={c.campo} className={`ficha-campo${c.ancho ? " ficha-campo-ancho" : ""}`}>
                              <span>{c.etiqueta}</span>
                              {opciones ? (
                                <select className="auto-input" value={valor} disabled={enviando} onChange={(e) => poner(e.target.value)}>
                                  <option value="">Elegir</option>
                                  {/* Un valor guardado que ya no está en la lista se conserva visible. */}
                                  {valor && !opciones.some((o) => o.valor === valor) && <option value={valor}>{valor}</option>}
                                  {opciones.map((o) => (
                                    <option key={o.valor} value={o.valor}>
                                      {o.texto}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  className="auto-input"
                                  inputMode={c.campo === "valor_factura" ? "decimal" : c.numerico ? "numeric" : undefined}
                                  maxLength={c.max}
                                  placeholder={c.ayuda}
                                  value={valor}
                                  disabled={enviando}
                                  onChange={(e) => poner(e.target.value)}
                                />
                              )}
                            </label>
                          );
                        })}
                    </div>
                  </div>
                ))}
                {ficha.emision.datos.direccion && <p className="ficha-ayuda">Dirección anterior (texto libre): {ficha.emision.datos.direccion}</p>}
                {ficha.emision.completitud.producto && (
                  <p className="ficha-ayuda">
                    <strong>Producto:</strong> {ficha.emision.completitud.producto.nombre}
                    {ficha.emision.completitud.producto.cobertura &&
                      `. Cobertura del ${formato(ficha.emision.completitud.producto.cobertura.inicio)} al ${formato(ficha.emision.completitud.producto.cobertura.fin)}`}
                    .
                  </p>
                )}
                <button
                  type="button"
                  className="boton-secundario-claro"
                  disabled={enviando}
                  onClick={() => accion("datos-emision", "PUT", Object.fromEntries(CAMPOS_EMISION.map((c) => [c.campo, (emision[c.campo] ?? "").trim() || null])), "Datos para emitir guardados.")}
                >
                  Guardar datos
                </button>
                <p className="ficha-ayuda">
                  Son los que pide el portal de Assurant ({ficha.emision.opciones.nombre}). La orden de pago le llega al cliente por correo y su liga dura{" "}
                  {ficha.emision.opciones.liga_pago_horas} h.
                </p>
              </section>
            )}

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
