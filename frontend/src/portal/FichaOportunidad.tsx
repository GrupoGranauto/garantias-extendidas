import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoCheck, IconoReloj, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import GestionBdc, { FECHA_HORA_MAX, RESPUESTA_CON_PROXIMO, aLocal, proximoDesdeLocal, type Gestion } from "./GestionBdc";

type Entrada = { tipo: string; titulo: string; detalle: Record<string, unknown> | null; autor: string | null; creado_en: string };
type TareaPendiente = { id: string; tipo: "tarea" | "pregunta"; titulo: string; descripcion: string | null; vence_en: string | null };
type Emision = {
  datos: Record<CampoEmision, string | number | null> & { direccion: string | null; vendedor: string | null };
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
type OpcionResultado = { valor: string; estado: string; color: string };
/** Una vez que el VIN estuvo en una campaña (la en curso trae los datos de hoy; las cerradas, la foto al cerrarse). */
type PasoCampana = {
  id: string;
  clave: string;
  campana: string;
  fase_campana: string | null;
  abierta_en: string;
  cerrada_en: string | null;
  motivo_cierre: string | null;
  primer_contacto_en: string | null;
  resultado_bdc: string | null;
  estado: string | null;
  ejecutivo: string | null;
  llamadas: number;
  whatsapp: number;
  respuestas: number;
  masivos: number;
};
type Ficha = {
  oportunidad: Record<string, unknown>;
  resultado: { actual: string; opciones: OpcionResultado[] };
  etiquetas: Record<string, string>;
  contrato: { estado: string; folio: string | null };
  emision: Emision | null;
  exigir_evidencia_venta: boolean;
  tareas: TareaPendiente[];
  linea_tiempo: Entrada[];
  campanas: PasoCampana[];
  gestion: Gestion;
  estados_contrato: string[];
};

type Props = {
  sucursalId: string;
  oportunidadId: string;
  onCerrar: () => void;
  /** Avisa a la tabla/embudo que algo cambió para que se recarguen. */
  onCambio: () => void;
};

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
  | "plazo_meses" | "metodo_pago" | "msi_meses";
type Lista = "estados" | "plazos" | "metodo" | "msi";
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
      { campo: "metodo_pago", etiqueta: "Forma de pago", max: 20, lista: "metodo" },
      { campo: "msi_meses", etiqueta: "Plazo de meses sin intereses", max: 2, lista: "msi" },
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
  if (lista === "metodo") return [{ valor: "contado", texto: "Contado" }, { valor: "financiado", texto: "Meses sin intereses" }];
  if (lista === "msi") return o.msi_meses.map((m) => ({ valor: String(m), texto: `${m} meses` }));
  if (lista === "estados" && o.estados_circulacion.length > 0) return o.estados_circulacion.map((e) => ({ valor: e, texto: e }));
  return null;
}

/** Estados del lead en el orden del embudo, para agrupar los resultados. */
const ESTADOS_RESULTADO: [string, string][] = [
  ["por_contactar", "Por contactar"],
  ["contactado", "Contactado"],
  ["interesado", "Interesado"],
  ["cotizado", "Cotizado"],
  ["vendido", "Vendido"],
  ["perdido", "Perdido"],
];

/** «NO INTERESADO» → «No interesado»: los valores del Sheet van en mayúsculas. */
const textoResultado = (r: string) => (r.charAt(0) + r.slice(1).toLowerCase()).replace("whatsapp", "WhatsApp");

const NOMBRE_CAMPANA: Record<string, string> = {
  "48H": "48 horas",
  "5M": "5 meses",
  "12M_NURTURING": "12 meses (nurturing)",
  "28M": "28 meses",
};
const nombreCampana = (c: string) => NOMBRE_CAMPANA[c] ?? c.replace(/_/g, " ");
const FASE: Record<string, string> = { ETAPA_1: "Etapa 1", ETAPA_2: "Etapa 2", NURTURING: "Nurturing", POR_DIAS: "Por días" };
const textoFase = (f: string) => FASE[f] ?? (f.charAt(0) + f.slice(1).toLowerCase()).replace(/_/g, " ");

const MOTIVO_CIERRE: Record<string, string> = {
  CAMBIO_CAMPANA: "Pasó a la siguiente campaña",
  FUERA_DE_VENTANA: "Terminó la ventana de la campaña",
  YA_TIENE_GE: "Ya tiene garantía extendida",
  NO_CONTACTABLE_FUENTE: "Quedó como no contactable en la cartera",
  NO_EN_MAESTRA: "Salió de la cartera",
};

const DIA_MS = 86_400_000;
/** Días completos entre dos momentos (hasta ahora si no hay fin). */
const diasEntre = (desde: string, hasta: string | null) =>
  Math.max(0, Math.floor(((hasta ? new Date(hasta) : new Date()).getTime() - new Date(desde).getTime()) / DIA_MS));
const textoDias = (n: number) => (n === 0 ? "menos de un día" : n === 1 ? "1 día" : `${n} días`);
/** Días de calendario (en Hermosillo) entre dos momentos: 23:00 de un día y 09:00 del siguiente es «al día siguiente». */
const diaHermosillo = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Hermosillo" });
const diasCalendario = (desde: string, hasta: string) =>
  Math.max(0, Math.round((Date.parse(`${diaHermosillo(hasta)}T00:00:00Z`) - Date.parse(`${diaHermosillo(desde)}T00:00:00Z`)) / DIA_MS));
const cuenta = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

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

/** Un valor anterior o nuevo de una edición, legible: sí/no, fecha y hora del próximo contacto, montos en pesos. */
function valorEdicion(campo: unknown, v: unknown): string {
  if (v === null || v === undefined || v === "") return "vacío";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (campo === "proximo_contacto_en") return cuando(String(v)) || formato(v);
  if (campo === "monto_cotizado" && Number.isFinite(Number(v))) return Number(v).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  return formato(v);
}

function detalleEntrada(e: Entrada): string | null {
  const d = e.detalle ?? {};
  if (e.tipo === "nota" && d.texto) return String(d.texto);
  if ((e.tipo === "llamada" || e.tipo === "whatsapp") && d.nota) return String(d.nota);
  if (e.tipo === "edicion" || e.tipo === "reasignacion") return `${valorEdicion(d.campo, d.anterior)} → ${valorEdicion(d.campo, d.nuevo)}`;
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

  const [resultado, setResultado] = useState("CONTESTA_TITULAR");
  const [respuesta, setRespuesta] = useState("");
  const [motivoNoInteres, setMotivoNoInteres] = useState("");
  const [proximo, setProximo] = useState("");
  const [nota, setNota] = useState("");
  const [textoNota, setTextoNota] = useState("");
  const [estadoContrato, setEstadoContrato] = useState("sin_contrato");
  const [folio, setFolio] = useState("");
  const [km, setKm] = useState("");
  const [emision, setEmision] = useState<Record<string, string>>({});

  const base = `/api/admin/sucursales/${sucursalId}/crm/oportunidades/${oportunidadId}`;

  // Solo un administrador puede quitar un «no contactar» (corrección de captura).
  const [esAdmin, setEsAdmin] = useState(false);
  useEffect(() => {
    apiFetch<{ rol: string }>("/api/perfil")
      .then((p) => setEsAdmin(p.rol === "admin"))
      .catch(() => setEsAdmin(false));
  }, []);

  /** Recarga la ficha. `soloFicha`: no toca lo que se está capturando en emisión, contrato y km (guardados de Gestión). */
  const cargar = useCallback((soloFicha = false) => {
    apiFetch<Ficha>(base)
      .then((f) => {
        setFicha(f);
        if (soloFicha) return;
        setEstadoContrato(f.contrato.estado);
        setFolio(f.contrato.folio ?? "");
        const kmActual = f.oportunidad.kilometraje;
        setKm(kmActual === null || kmActual === undefined ? "" : String(kmActual));
        setEmision(Object.fromEntries(CAMPOS_EMISION.map((c) => [c.campo, f.emision?.datos[c.campo] === null || f.emision?.datos[c.campo] === undefined ? "" : String(f.emision.datos[c.campo])])));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la ficha."));
  }, [base]);

  useEffect(() => cargar(), [cargar]);

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  /** Resuelve si se guardó (los campos de la sección de gestión regresan a lo guardado si no). */
  async function accion(
    ruta: string,
    metodo: "POST" | "PUT" | "DELETE",
    cuerpo: unknown,
    exito: string,
    despues?: () => void,
    soloFicha = false,
  ): Promise<boolean> {
    setEnviando(true);
    setAviso(null);
    try {
      await apiFetch(`${base}/${ruta}`, { method: metodo, ...(metodo === "DELETE" ? {} : { body: JSON.stringify(cuerpo) }) });
      setAviso({ tipo: "ok", texto: exito });
      despues?.();
      cargar(soloFicha);
      onCambio();
      return true;
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
      return false;
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

  // Campos condicionales de la llamada (Notion): la respuesta solo si contestó el titular; la fecha y el motivo, si la
  // respuesta los pide.
  const titular = resultado === "CONTESTA_TITULAR";
  const pideProximo = titular && RESPUESTA_CON_PROXIMO.has(respuesta);
  const pideMotivo = titular && respuesta === "NO_INTERESADO";
  const pideComentario = pideMotivo && motivoNoInteres === "OTRO";
  const faltaEnLlamada = (pideProximo && !proximo) || (pideMotivo && !motivoNoInteres) || (pideComentario && !nota.trim());

  function registrarLlamada() {
    let proximoIso: string | null = null;
    if (pideProximo) {
      const r = proximoDesdeLocal(proximo);
      if ("error" in r) {
        setAviso({ tipo: "error", texto: r.error });
        return;
      }
      proximoIso = r.iso;
    }
    accion(
      "contacto",
      "POST",
      {
        canal: "llamada",
        resultado,
        respuesta: titular && respuesta ? respuesta : null,
        motivo_no_interes: pideMotivo ? motivoNoInteres : null,
        proximo_contacto_en: proximoIso,
        nota: nota.trim() || null,
      },
      "Llamada registrada.",
      () => {
        setNota("");
        setRespuesta("");
        setMotivoNoInteres("");
        setProximo("");
      },
    );
  }

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

            {ficha.gestion.valores.respuesta_por_clasificar && (
              <section className="ficha-sec ficha-clasificar">
                <h3>Respuesta por clasificar</h3>
                <p className="ficha-ayuda">El cliente respondió por WhatsApp. ¿Quién respondió?</p>
                <div className="ficha-botones">
                  {ficha.gestion.catalogos.clasificacion_respuesta.map((o) => (
                    <button
                      key={o.clave}
                      type="button"
                      className="boton-secundario-claro"
                      disabled={enviando}
                      onClick={() => {
                        // «Pide baja» es definitivo: la persona deja de recibir mensajes y no se puede quitar.
                        if (o.clave === "BAJA" && !window.confirm("¿Confirmas que pidió no recibir más mensajes? No se puede deshacer.")) return;
                        accion("clasificacion", "PUT", { clasificacion: o.clave }, "Respuesta clasificada.");
                      }}
                    >
                      {o.etiqueta}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="ficha-sec">
              <h3>Resultado BDC</h3>
              <div className="ficha-resultado">
                <span
                  className="ficha-resultado-punto"
                  style={{ background: ficha.resultado.opciones.find((o) => o.valor === ficha.resultado.actual)?.color }}
                  aria-hidden="true"
                />
                <select
                  className="auto-input"
                  value={ficha.resultado.actual}
                  disabled={enviando}
                  aria-label="Resultado BDC"
                  onChange={(e) => accion("resultado", "PUT", { resultado: e.target.value }, "Resultado guardado.")}
                >
                  {ESTADOS_RESULTADO.map(([estado, nombre]) => (
                    <optgroup key={estado} label={nombre}>
                      {ficha.resultado.opciones
                        .filter((o) => o.estado === estado)
                        .map((o) => (
                          <option key={o.valor} value={o.valor}>
                            {textoResultado(o.valor)}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <p className="ficha-ayuda">El resultado mueve el lead al estado que le corresponde (por ejemplo, «Precio fuera de presupuesto» lo pasa a Perdido con ese motivo).</p>
            </section>

            <section className="ficha-sec">
              <h3>Registrar llamada</h3>
              <select className="auto-input" value={resultado} onChange={(e) => setResultado(e.target.value)} aria-label="Resultado de la llamada">
                {ficha.gestion.llamada.map((r) => (
                  <option key={r.valor} value={r.valor}>
                    {r.texto}
                  </option>
                ))}
              </select>
              {titular && (
                <select className="auto-input" value={respuesta} onChange={(e) => setRespuesta(e.target.value)} aria-label="Respuesta del titular">
                  <option value="">Respuesta del titular (opcional)</option>
                  {ficha.gestion.catalogos.respuesta_titular.map((o) => (
                    <option key={o.clave} value={o.clave}>
                      {o.etiqueta}
                    </option>
                  ))}
                </select>
              )}
              {pideProximo && (
                <label className="ficha-campo">
                  <span>¿Cuándo volver a contactarlo?</span>
                  <input
                    type="datetime-local"
                    className="auto-input"
                    value={proximo}
                    min={aLocal(new Date().toISOString())}
                    max={FECHA_HORA_MAX}
                    onChange={(e) => setProximo(e.target.value)}
                  />
                </label>
              )}
              {pideMotivo && (
                <select className="auto-input" value={motivoNoInteres} onChange={(e) => setMotivoNoInteres(e.target.value)} aria-label="Motivo de no interés">
                  <option value="">Motivo de no interés</option>
                  {ficha.gestion.catalogos.motivo_no_interes.map((o) => (
                    <option key={o.clave} value={o.clave}>
                      {o.etiqueta}
                    </option>
                  ))}
                </select>
              )}
              <input
                type="text"
                className="auto-input"
                placeholder={pideComentario ? "Comentario (obligatorio con «Otro»)" : "Nota breve (opcional)"}
                maxLength={500}
                value={nota}
                onChange={(e) => setNota(e.target.value)}
              />
              <button type="button" className="boton-guardar" disabled={enviando || faltaEnLlamada} onClick={registrarLlamada}>
                Registrar
              </button>
              <p className="ficha-ayuda">Suma un intento y pone hoy como último contacto. Solo hablar con el titular es contacto efectivo: si el lead estaba en «Por contactar», pasa a «Contactado». Su respuesta lo mueve (pide precio → Interesado; no interesado, ya tiene GE o flotilla → Perdido con ese motivo). Los mensajes de WhatsApp se registran solos.</p>
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

            <GestionBdc
              key={JSON.stringify(ficha.gestion.valores)}
              gestion={ficha.gestion}
              enviando={enviando}
              guardar={(valores, exito) => accion("gestion", "PUT", valores, exito, undefined, true)}
              noContactar={(canal) => accion("no-contactar", "PUT", { canal }, "Registrado: no contactar.")}
              quitarNoContactar={() => accion("no-contactar", "DELETE", null, "Se quitó «no contactar».")}
              esAdmin={esAdmin}
              avisar={(texto) => setAviso({ tipo: "error", texto })}
            />

            <section className="ficha-sec">
              <h3>Campañas</h3>
              {ficha.campanas.length === 0 && <p className="ficha-ayuda">Este vehículo todavía no ha estado en una campaña.</p>}
              <ol className="ficha-campanas">
                {ficha.campanas.map((p) => {
                  const abierta = !p.cerrada_en;
                  const color = ficha.resultado.opciones.find((o) => o.valor === p.resultado_bdc)?.color;
                  const primer = p.primer_contacto_en ? diasCalendario(p.abierta_en, p.primer_contacto_en) : null;
                  return (
                    <li key={p.id} className={`ficha-campana${abierta ? " ficha-campana-abierta" : ""}`} title={`ID ${p.clave}`}>
                      <div className="ficha-campana-cab">
                        <strong>{nombreCampana(p.campana)}</strong>
                        {p.fase_campana && <span className="ficha-campana-fase">{textoFase(p.fase_campana)}</span>}
                        <span className={`ficha-campana-chip${abierta ? " ficha-campana-chip-abierta" : ""}`}>{abierta ? "En curso" : "Cerrada"}</span>
                      </div>
                      <small className="ficha-campana-fechas">
                        {formato(p.abierta_en)} – {abierta ? "hoy" : formato(p.cerrada_en)} · {textoDias(diasEntre(p.abierta_en, p.cerrada_en))}
                      </small>
                      <dl className="ficha-campana-datos">
                        <div>
                          <dt>Resultado BDC</dt>
                          <dd>
                            <span className="ficha-resultado-punto" style={{ background: color }} aria-hidden="true" />
                            {p.resultado_bdc ? textoResultado(p.resultado_bdc) : "—"}
                          </dd>
                        </div>
                        <div>
                          <dt>Estado del lead</dt>
                          <dd>{p.estado ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Ejecutivo</dt>
                          <dd>{p.ejecutivo ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Primer contacto</dt>
                          <dd>{primer === null ? "Sin contacto efectivo" : primer === 0 ? "El mismo día" : primer === 1 ? "Al día siguiente" : `A los ${primer} días`}</dd>
                        </div>
                      </dl>
                      <div className="ficha-campana-conteos">
                        <span>{cuenta(p.llamadas, "llamada", "llamadas")}</span>
                        <span>{cuenta(p.whatsapp, "WhatsApp", "WhatsApp")}</span>
                        <span>{cuenta(p.masivos, "masivo", "masivos")}</span>
                        <span>{cuenta(p.respuestas, "respuesta", "respuestas")}</span>
                      </div>
                      {p.motivo_cierre && <small className="ficha-campana-cierre">{MOTIVO_CIERRE[p.motivo_cierre] ?? p.motivo_cierre}</small>}
                    </li>
                  );
                })}
              </ol>
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
                        // El plazo de MSI solo aplica si paga a meses sin intereses («Financiado» en el portal de Assurant).
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
                <p className="ficha-ayuda">
                  <strong>Vendedor:</strong> {ficha.emision.datos.vendedor ?? "sin ejecutivo asignado"} (el ejecutivo asignado al lead)
                </p>
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
