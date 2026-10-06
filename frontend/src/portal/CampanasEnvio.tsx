import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import Interruptor from "../componentes/Interruptor";
import { IconoCheck, IconoReloj, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Paso = {
  id?: string;
  clave: string;
  plantilla_id: string | null;
  dias_despues: number;
  hora: string | null;
  vigencia_dias: number;
  solo_sin_respuesta: boolean;
  solo_sin_contacto: boolean;
  etapas: string[];
};
type Campana = {
  campana: string;
  /** La regla de la campaña en una frase (solo cuando la web es la fuente de campañas). */
  detalle: string | null;
  activa: boolean;
  modo: "simulacion" | "real";
  dias_semana: number[];
  hora_inicio: string;
  hora_fin: string;
  max_por_dia: number;
  dias_entre_mensajes: number;
  piloto_agencias: string[];
  rampa_activa: boolean;
  rampa_inicial: number;
  rampa_incremento: number;
  oportunidades_activas: number;
  inicio: string | null;
  fin: string | null;
  pasos: Omit<Paso, "clave">[];
};
type Plantilla = { id: string; nombre: string | null; nombre_tecnico: string; estado: string; variables: number; mapeadas: number };
type Respuesta = {
  campanas: Campana[];
  plantillas: Plantilla[];
  etapas: string[];
  agencias: string[];
  whatsapp_listo: boolean;
  motor_encendido: boolean;
};
type Activacion = {
  checks: { clave: string; ok: boolean; bloqueante: boolean; texto: string }[];
  bloqueos: number;
  listo_para_real: boolean;
  modo: "apagada" | "simulacion" | "real";
  tope_hoy: number;
  primer_envio_real: string | null;
};
type Borrador = Omit<Campana, "pasos"> & { pasos: Paso[] };

type VistaPrevia = {
  oportunidades: number;
  bajas: number;
  sin_telefono: number;
  alcanzables: number;
  pasos: { orden: number; plantilla_id: string | null; programacion: { fecha: string; hora: string; oportunidades: number; vigente: boolean }[] }[];
};
type Registro = {
  por_estado: { estado: string; n: number }[];
  por_motivo: { motivo: string; estado: string; n: number }[];
  recientes: { id: string; campana: string; estado: string; motivo: string | null; programado_para: string; enviado_en: string | null; error: string | null; orden: number | null; seguimiento: string | null; cliente: string | null; plantilla: string | null }[];
};

const NOMBRES: Record<string, { titulo: string; detalle: string }> = {
  "48H": { titulo: "48 horas", detalle: "Ventas recién reportadas. La ventana dura 2 días." },
  "5M": { titulo: "5 meses", detalle: "Facturados hace 5 meses. Cohorte mensual." },
  "12M_NURTURING": { titulo: "12 meses (nurturing)", detalle: "Facturados hace 11 a 12 meses. Entran día a día." },
  "28M": { titulo: "28 meses", detalle: "Facturados hace 28 meses. Cohorte mensual." },
};

const DIAS = [
  { v: 1, t: "L", n: "Lunes" },
  { v: 2, t: "M", n: "Martes" },
  { v: 3, t: "X", n: "Miércoles" },
  { v: 4, t: "J", n: "Jueves" },
  { v: 5, t: "V", n: "Viernes" },
  { v: 6, t: "S", n: "Sábado" },
  { v: 7, t: "D", n: "Domingo" },
];

const MOTIVOS: Record<string, string> = {
  baja: "Pidió la baja",
  ahora_no: "Respondió «Ahora no» (vuelve en la siguiente campaña)",
  sin_telefono: "Sin teléfono",
  sin_celular: "El número no es celular",
  etapa_no_permitida: "Estado del lead no permitido",
  respondio: "Ya respondió",
  ya_contactado: "Ya fue contactado",
  fuera_de_ventana: "Fuera del horario",
  tope_diario: "Tope diario alcanzado",
  descanso_entre_campanas: "Descanso entre campañas",
  plantilla_no_disponible: "Plantilla no disponible",
  whatsapp_no_configurado: "WhatsApp sin configurar",
  campana_apagada: "Campaña apagada",
  ya_no_aplica: "Ya no aplica",
  fuera_de_vigencia: "Pasó su vigencia",
  fuera_del_piloto: "Fuera del piloto",
  variable_vacia: "Falta un dato para el mensaje",
  enviando: "Enviando",
  reintento: "Reintentando",
};
const ESTADOS: Record<string, string> = {
  pendiente: "Pendiente",
  simulado: "Simulado",
  enviado: "Enviado",
  entregado: "Entregado",
  leido: "Leído",
  fallido: "Fallido",
  omitido: "Omitido",
};

let contador = 0;
const clave = () => `p${++contador}`;

const aBorrador = (c: Campana): Borrador => ({ ...c, pasos: c.pasos.map((p) => ({ ...p, clave: p.id ?? clave() })) });

const fechaCorta = (f: string) => new Date(`${f}T00:00:00`).toLocaleDateString("es-MX", { weekday: "short", day: "2-digit", month: "short" });
const cuando = (v: string | null) =>
  v ? new Date(v).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

/**
 * Envíos automáticos de WhatsApp por campaña: qué plantilla sale, cuántos días después de que empieza
 * la campaña, a qué hora y bajo qué condiciones; el horario permitido, el tope por día y el descanso
 * entre campañas. Una campaña nace apagada y en simulación: primero se revisa qué haría.
 */
export default function CampanasEnvio() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const base = `/api/admin/sucursales/${sucursalId}/crm`;

  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [borradores, setBorradores] = useState<Record<string, Borrador>>({});
  const [sucias, setSucias] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [previa, setPrevia] = useState<VistaPrevia | null>(null);
  const [registro, setRegistro] = useState<Registro | null>(null);
  const [activacion, setActivacion] = useState<Activacion | null>(null);

  const cargar = useCallback(() => {
    apiFetch<Respuesta>(`${base}/campanas`)
      .then((d) => {
        setDatos(d);
        setBorradores(Object.fromEntries(d.campanas.map((c) => [c.campana, aBorrador(c)])));
        setSucias(new Set());
        setSel((actual) => actual ?? d.campanas[0]?.campana ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar."));
  }, [base]);
  useEffect(cargar, [cargar]);

  const c = sel ? borradores[sel] : null;

  const cargarRegistro = useCallback(() => {
    if (!sel) return;
    apiFetch<Registro>(`${base}/envios?campana=${sel}`)
      .then(setRegistro)
      .catch(() => setRegistro(null));
  }, [base, sel]);
  useEffect(() => {
    setPrevia(null);
    setRegistro(null);
    cargarRegistro();
  }, [cargarRegistro]);

  // La lista de verificación se vuelve a pedir al cambiar de campaña y al guardar (datos cambia con cada carga).
  useEffect(() => {
    if (!sel) return;
    setActivacion(null);
    apiFetch<Activacion>(`${base}/campanas/${sel}/activacion`)
      .then(setActivacion)
      .catch(() => setActivacion(null));
  }, [base, sel, datos]);

  function cambiar(fn: (b: Borrador) => Borrador) {
    if (!sel) return;
    setBorradores((b) => ({ ...b, [sel]: fn(b[sel]) }));
    setSucias((s) => new Set(s).add(sel));
    setAviso(null);
    setPrevia(null);
  }
  const cambiarPaso = (k: string, cambios: Partial<Paso>) => cambiar((b) => ({ ...b, pasos: b.pasos.map((p) => (p.clave === k ? { ...p, ...cambios } : p)) }));

  async function guardar() {
    if (!c || !sel) return;
    setGuardando(true);
    setAviso(null);
    try {
      await apiFetch(`${base}/campanas/${sel}`, {
        method: "PUT",
        body: JSON.stringify({
          activa: c.activa,
          modo: c.modo,
          dias_semana: c.dias_semana,
          hora_inicio: c.hora_inicio,
          hora_fin: c.hora_fin,
          max_por_dia: c.max_por_dia,
          dias_entre_mensajes: c.dias_entre_mensajes,
          piloto_agencias: c.piloto_agencias,
          rampa_activa: c.rampa_activa,
          rampa_inicial: c.rampa_inicial,
          rampa_incremento: c.rampa_incremento,
          pasos: c.pasos.map((p) => ({
            ...(p.id ? { id: p.id } : {}),
            plantilla_id: p.plantilla_id,
            dias_despues: p.dias_despues,
            hora: p.hora || null,
            vigencia_dias: p.vigencia_dias,
            solo_sin_respuesta: p.solo_sin_respuesta,
            solo_sin_contacto: p.solo_sin_contacto,
            etapas: p.etapas,
          })),
        }),
      });
      setAviso({ tipo: "ok", texto: "Campaña guardada." });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  async function verPrevia() {
    if (!sel) return;
    setAviso(null);
    try {
      setPrevia(await apiFetch<VistaPrevia>(`${base}/campanas/${sel}/vista-previa`));
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo calcular la vista previa." });
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!datos) return <Cargador />;

  const sucia = sel ? sucias.has(sel) : false;
  const nombrePlantilla = (id: string | null) => {
    const p = datos.plantillas.find((x) => x.id === id);
    return p ? (p.nombre ?? p.nombre_tecnico) : "Sin plantilla";
  };

  return (
    <>
      <p className="pestana-descripcion">
        Define qué mensaje de WhatsApp recibe cada campaña, en qué día y hora, y bajo qué condiciones. Quien pide la baja deja de
        recibir mensajes para siempre.
      </p>
      {!datos.motor_encendido && (
        <Alerta tipo="info">
          El servidor todavía no tiene encendido el envío automático: aunque una campaña esté activa, no sale ningún mensaje hasta que se
          encienda (variable <strong>CRM_ENVIOS=on</strong> en el servidor).
        </Alerta>
      )}
      {!datos.whatsapp_listo && <Alerta tipo="error">WhatsApp no está configurado o activo en esta sucursal: no se podrá enviar.</Alerta>}

      <div className="auto">
        <nav className="auto-etapas" aria-label="Campañas">
          {datos.campanas.map((k) => {
            const b = borradores[k.campana] ?? k;
            const n = NOMBRES[k.campana] ?? { titulo: k.campana, detalle: "" };
            return (
              <button
                key={k.campana}
                type="button"
                className={`auto-etapa camp-item${k.campana === sel ? " auto-etapa-activa" : ""}`}
                onClick={() => setSel(k.campana)}
              >
                <span className="camp-item-texto">
                  <strong>{n.titulo}</strong>
                  <small>{k.oportunidades_activas.toLocaleString("es-MX")} activas</small>
                </span>
                <span className={`camp-chip camp-chip-${!b.activa ? "apagada" : b.modo}`}>{!b.activa ? "Apagada" : b.modo === "real" ? "Real" : "Simulación"}</span>
                {sucias.has(k.campana) && <span className="auto-etapa-sucia" title="Cambios sin guardar" />}
              </button>
            );
          })}
        </nav>

        {c && sel && (
          <section className="auto-panel">
            <header className="auto-panel-cab">
              <div>
                <h2>{NOMBRES[sel]?.titulo ?? sel}</h2>
                <p>
                  {c.detalle ?? NOMBRES[sel]?.detalle}
                  {c.inicio ? ` Empieza ${new Date(`${c.inicio}T00:00:00`).toLocaleDateString("es-MX", { day: "2-digit", month: "short" })}.` : ""}
                </p>
              </div>
              <button type="button" className="boton-guardar" disabled={!sucia || guardando} onClick={guardar}>
                {guardando ? "Guardando…" : "Guardar campaña"}
              </button>
            </header>

            {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

            {/* ---- Estado ---- */}
            <div className="camp-bloque">
              <h3>Estado</h3>
              <Interruptor etiqueta={c.activa ? "Campaña encendida" : "Campaña apagada"} activo={c.activa} onChange={(v) => cambiar((b) => ({ ...b, activa: v }))} />
              <div className="camp-modos" role="radiogroup" aria-label="Modo de envío">
                <label className={`camp-modo${c.modo === "simulacion" ? " camp-modo-activo" : ""}`}>
                  <input type="radio" name="modo" checked={c.modo === "simulacion"} onChange={() => cambiar((b) => ({ ...b, modo: "simulacion" }))} />
                  <span>
                    <strong>Simulación</strong>
                    <small>No manda nada: solo registra qué habría enviado, para revisarlo.</small>
                  </span>
                </label>
                <label className={`camp-modo${c.modo === "real" ? " camp-modo-activo camp-modo-real" : ""}`}>
                  <input
                    type="radio"
                    name="modo"
                    checked={c.modo === "real"}
                    onChange={() => {
                      if (window.confirm("En modo real los mensajes se envían por WhatsApp a clientes. ¿Cambiar a modo real?")) cambiar((b) => ({ ...b, modo: "real" }));
                    }}
                  />
                  <span>
                    <strong>Real</strong>
                    <small>Envía las plantillas por WhatsApp a los clientes de la campaña.</small>
                  </span>
                </label>
              </div>
            </div>

            {/* ---- Horario ---- */}
            <div className="camp-bloque">
              <h3>Cuándo se puede enviar</h3>
              <div className="camp-dias" role="group" aria-label="Días de envío">
                {DIAS.map((d) => (
                  <button
                    key={d.v}
                    type="button"
                    title={d.n}
                    aria-pressed={c.dias_semana.includes(d.v)}
                    className={`camp-dia${c.dias_semana.includes(d.v) ? " camp-dia-activo" : ""}`}
                    onClick={() =>
                      cambiar((b) => ({ ...b, dias_semana: b.dias_semana.includes(d.v) ? b.dias_semana.filter((x) => x !== d.v) : [...b.dias_semana, d.v].sort() }))
                    }
                  >
                    {d.t}
                  </button>
                ))}
              </div>
              <div className="auto-cuerpo">
                <label className="auto-campo">
                  <span>Desde las</span>
                  <input type="time" className="auto-input" value={c.hora_inicio} onChange={(e) => cambiar((b) => ({ ...b, hora_inicio: e.target.value }))} />
                </label>
                <label className="auto-campo">
                  <span>Hasta las</span>
                  <input type="time" className="auto-input" value={c.hora_fin} onChange={(e) => cambiar((b) => ({ ...b, hora_fin: e.target.value }))} />
                </label>
                <label className="auto-campo">
                  <span>Máximo de mensajes por día</span>
                  <input
                    type="number"
                    min={1}
                    className="auto-input"
                    value={c.max_por_dia}
                    onChange={(e) => cambiar((b) => ({ ...b, max_por_dia: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))}
                  />
                </label>
                <label className="auto-campo">
                  <span>Días de descanso entre campañas</span>
                  <input
                    type="number"
                    min={0}
                    className="auto-input"
                    value={c.dias_entre_mensajes}
                    onChange={(e) => cambiar((b) => ({ ...b, dias_entre_mensajes: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
                  />
                  <small>Si a esa persona le llegó un mensaje de otra campaña hace menos días, este espera. 0 = sin descanso.</small>
                </label>
              </div>
              <p className="rep-ayuda">Horario de Hermosillo. Fuera de estos días y horas, los mensajes esperan a que abra la ventana.</p>
            </div>

            {/* ---- Activación gradual ---- */}
            <div className="camp-bloque">
              <h3>Activación gradual</h3>
              <p className="rep-ayuda">
                Para salir sin sorpresas: prueba en simulación, empieza con una o dos agencias y deja que el tope diario crezca solo. Plan sugerido: 1) simulación uno o dos días; 2) real con
                piloto y rampa; 3) quitar el piloto cuando todo salga bien.
              </p>

              <div className="camp-grad">
                <div>
                  <strong>Piloto por agencia</strong>
                  <small className="camp-grad-nota">
                    {c.piloto_agencias.length === 0 ? "Sin piloto: se manda a todas las agencias." : `Solo se manda a ${c.piloto_agencias.length} agencia(s). Las demás esperan y, si pasa su vigencia, se omiten.`}
                  </small>
                  <div className="camp-agencias">
                    {datos.agencias.map((a) => (
                      <label key={a} className="camp-agencia">
                        <input
                          type="checkbox"
                          checked={c.piloto_agencias.includes(a)}
                          onChange={(e) => cambiar((b) => ({ ...b, piloto_agencias: e.target.checked ? [...b.piloto_agencias, a] : b.piloto_agencias.filter((x) => x !== a) }))}
                        />{" "}
                        {a}
                      </label>
                    ))}
                    {datos.agencias.length === 0 && <span className="rep-ayuda">Todavía no hay agencias en la cartera.</span>}
                  </div>
                  {c.piloto_agencias.length > 0 && (
                    <button type="button" className="boton-secundario-claro auto-agregar" onClick={() => cambiar((b) => ({ ...b, piloto_agencias: [] }))}>
                      Quitar el piloto (todas las agencias)
                    </button>
                  )}
                </div>

                <div>
                  <strong>Rampa del tope diario</strong>
                  <Interruptor etiqueta={c.rampa_activa ? "Rampa encendida" : "Rampa apagada"} activo={c.rampa_activa} onChange={(v) => cambiar((b) => ({ ...b, rampa_activa: v }))} />
                  {c.rampa_activa && (
                    <div className="auto-cuerpo">
                      <label className="auto-campo">
                        <span>El primer día manda hasta</span>
                        <input type="number" min={1} max={5000} className="auto-input" value={c.rampa_inicial} onChange={(e) => cambiar((b) => ({ ...b, rampa_inicial: Math.min(5000, Math.max(1, Math.floor(Number(e.target.value) || 1))) }))} />
                      </label>
                      <label className="auto-campo">
                        <span>Y cada día suma</span>
                        <input type="number" min={0} max={5000} className="auto-input" value={c.rampa_incremento} onChange={(e) => cambiar((b) => ({ ...b, rampa_incremento: Math.min(5000, Math.max(0, Math.floor(Number(e.target.value) || 0))) }))} />
                      </label>
                    </div>
                  )}
                  <small className="camp-grad-nota">
                    {c.rampa_activa
                      ? `Sin pasar de ${c.max_por_dia} por día (el máximo de arriba). La rampa cuenta desde el primer envío real: la simulación no la hace avanzar.`
                      : `Sin rampa: manda hasta ${c.max_por_dia} por día desde el primer día.`}
                  </small>
                  {activacion && sucia === false && (
                    <small className="camp-grad-nota">
                      <strong>Hoy el tope es {activacion.tope_hoy}.</strong>
                      {activacion.primer_envio_real ? ` Primer envío real: ${activacion.primer_envio_real}.` : " Todavía no hay envíos reales."}
                    </small>
                  )}
                </div>
              </div>

              <h4 className="camp-def-sub">Antes de encender en real</h4>
              {!activacion ? (
                <p className="rep-ayuda">Revisando…</p>
              ) : (
                <>
                  <ul className="camp-checks">
                    {activacion.checks.map((k) => (
                      <li key={k.clave} className={k.ok ? "camp-check-ok" : k.bloqueante ? "camp-check-mal" : "camp-check-aviso"}>
                        {k.ok ? <IconoCheck className="camp-check-icono" /> : k.bloqueante ? <IconoXMarca className="camp-check-icono" /> : <IconoReloj className="camp-check-icono" />} {k.texto}
                        {!k.ok && <small>{k.bloqueante ? " Pendiente: sin esto no puede salir." : " Recomendado."}</small>}
                      </li>
                    ))}
                  </ul>
                  <p className="rep-ayuda">
                    {activacion.listo_para_real
                      ? "Todo lo indispensable está listo para enviar de verdad."
                      : `Faltan ${activacion.bloqueos} cosa(s) indispensable(s) antes de poder enviar de verdad.`}
                    {sucia ? " Guarda la campaña para actualizar esta lista." : ""}
                  </p>
                </>
              )}
            </div>

            {/* ---- Mensajes ---- */}
            <div className="camp-bloque">
              <h3>Mensajes de la campaña</h3>
              {c.pasos.length === 0 && <p className="auto-vacio">Esta campaña aún no tiene mensajes.</p>}
              {c.pasos.map((p, i) => (
                <article key={p.clave} className="auto-tarjeta">
                  <div className="auto-tarjeta-cab">
                    <strong>Mensaje {i + 1}</strong>
                    <select
                      className="auto-input camp-plantilla"
                      value={p.plantilla_id ?? ""}
                      onChange={(e) => cambiarPaso(p.clave, { plantilla_id: e.target.value || null })}
                      aria-label="Plantilla"
                    >
                      <option value="">Elige una plantilla</option>
                      {datos.plantillas.map((t) => (
                        <option key={t.id} value={t.id} disabled={t.estado !== "aprobada"}>
                          {t.nombre ?? t.nombre_tecnico}
                          {t.estado !== "aprobada" ? ` (${t.estado})` : t.mapeadas < t.variables ? ` (faltan ${t.variables - t.mapeadas} variable(s) por ligar)` : ""}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="auto-quitar" aria-label={`Quitar el mensaje ${i + 1}`} onClick={() => cambiar((b) => ({ ...b, pasos: b.pasos.filter((x) => x.clave !== p.clave) }))}>
                      <IconoXMarca className="icono-inline" />
                    </button>
                  </div>

                  <div className="auto-cuerpo">
                    <label className="auto-campo">
                      <span>Días después de que empieza la campaña</span>
                      <input
                        type="number"
                        min={0}
                        className="auto-input"
                        value={p.dias_despues}
                        onChange={(e) => cambiarPaso(p.clave, { dias_despues: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                      />
                      <small>0 = el mismo día que empieza.</small>
                    </label>
                    <label className="auto-campo">
                      <span>A las (hora)</span>
                      <input type="time" className="auto-input" value={p.hora ?? ""} onChange={(e) => cambiarPaso(p.clave, { hora: e.target.value || null })} />
                      <small>Vacío = en cuanto abra el horario.</small>
                    </label>
                    <label className="auto-campo">
                      <span>Sigue vigente (días)</span>
                      <input
                        type="number"
                        min={1}
                        className="auto-input"
                        value={p.vigencia_dias}
                        onChange={(e) => cambiarPaso(p.clave, { vigencia_dias: Math.max(1, Math.floor(Number(e.target.value) || 0)) })}
                      />
                      <small>Si no pudo salir en ese plazo, se descarta en vez de mandarse tarde.</small>
                    </label>
                  </div>

                  <div className="camp-condiciones">
                    <Interruptor etiqueta="Solo si el cliente no ha respondido" activo={p.solo_sin_respuesta} onChange={(v) => cambiarPaso(p.clave, { solo_sin_respuesta: v })} />
                    <Interruptor etiqueta="Solo si nadie lo ha contactado ya" activo={p.solo_sin_contacto} onChange={(v) => cambiarPaso(p.clave, { solo_sin_contacto: v })} />
                  </div>
                  <div className="camp-etapas">
                    <span>Solo si la oportunidad está en:</span>
                    {datos.etapas.map((e) => (
                      <button
                        key={e}
                        type="button"
                        aria-pressed={p.etapas.includes(e)}
                        className={`camp-etapa${p.etapas.includes(e) ? " camp-etapa-activa" : ""}`}
                        onClick={() => cambiarPaso(p.clave, { etapas: p.etapas.includes(e) ? p.etapas.filter((x) => x !== e) : [...p.etapas, e] })}
                      >
                        {e}
                      </button>
                    ))}
                    <small>{p.etapas.length === 0 ? "Cualquier estado abierto." : ""}</small>
                  </div>
                </article>
              ))}
              {c.pasos.length < 6 && (
                <button
                  type="button"
                  className="boton-secundario-claro auto-agregar"
                  onClick={() =>
                    cambiar((b) => ({
                      ...b,
                      pasos: [
                        ...b.pasos,
                        {
                          clave: clave(),
                          plantilla_id: null,
                          dias_despues: b.pasos.length === 0 ? 0 : (b.pasos[b.pasos.length - 1]?.dias_despues ?? 0) + 1,
                          hora: null,
                          vigencia_dias: 2,
                          solo_sin_respuesta: b.pasos.length > 0,
                          solo_sin_contacto: false,
                          etapas: [],
                        },
                      ],
                    }))
                  }
                >
                  Agregar mensaje
                </button>
              )}
            </div>

            {/* ---- Vista previa ---- */}
            <div className="camp-bloque">
              <h3>Vista previa</h3>
              <p className="rep-ayuda">Lo que pasaría con la configuración guardada. No manda ni cambia nada.</p>
              {(sucia || c.pasos.length === 0) && (
                <p className="rep-ayuda">
                  {c.pasos.length === 0 ? "Agrega al menos un mensaje a la campaña para ver la vista previa." : "Guarda la campaña primero para que la vista previa refleje tus cambios."}
                </p>
              )}
              <button type="button" className="boton-secundario-claro" onClick={verPrevia} disabled={sucia || c.pasos.length === 0}>
                Ver qué pasaría
              </button>
              {previa && (
                <div className="camp-previa">
                  <ul className="camp-cifras">
                    <li><strong>{previa.oportunidades}</strong> oportunidades activas</li>
                    <li><strong>{previa.alcanzables}</strong> con celular y sin baja</li>
                    <li><strong>{previa.sin_telefono}</strong> sin celular válido</li>
                    <li><strong>{previa.bajas}</strong> en baja</li>
                  </ul>
                  {previa.pasos.map((p) => (
                    <div key={p.orden} className="camp-previa-paso">
                      <strong>
                        Mensaje {p.orden} · {nombrePlantilla(p.plantilla_id)}
                      </strong>
                      {p.programacion.length === 0 ? (
                        <span className="rep-ayuda">Sin oportunidades.</span>
                      ) : (
                        <ul>
                          {p.programacion.map((x) => (
                            <li key={`${x.fecha}${x.hora}`} className={x.vigente ? undefined : "camp-vencido"}>
                              {fechaCorta(x.fecha)} a las {x.hora}: {x.oportunidades} oportunidades{x.vigente ? "" : " (ya pasó su vigencia: se descartarían)"}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ---- Registro ---- */}
            <div className="camp-bloque">
              <div className="inicio-cab">
                <h3>Registro de envíos (últimos 30 días)</h3>
                <button type="button" className="boton-tenue" onClick={cargarRegistro}>
                  Actualizar
                </button>
              </div>
              {!registro || registro.recientes.length === 0 ? (
                <p className="auto-vacio">Todavía no hay envíos registrados para esta campaña.</p>
              ) : (
                <>
                  <ul className="camp-cifras">
                    {registro.por_estado.map((e) => (
                      <li key={e.estado}>
                        <strong>{e.n}</strong> {ESTADOS[e.estado]?.toLowerCase() ?? e.estado}
                      </li>
                    ))}
                  </ul>
                  {registro.por_motivo.length > 0 && (
                    <p className="rep-ayuda">
                      {registro.por_motivo.map((m) => `${m.n} ${MOTIVOS[m.motivo]?.toLowerCase() ?? m.motivo}`).join(" · ")}
                    </p>
                  )}
                  <div className="tabla-envoltura">
                    <table className="tabla">
                      <thead>
                        <tr>
                          <th>Cliente</th>
                          <th>Mensaje</th>
                          <th>Estado</th>
                          <th>Motivo</th>
                          <th>Programado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {registro.recientes.map((r) => (
                          <tr key={r.id} title={r.error ?? undefined}>
                            <td>{r.cliente ?? "—"}</td>
                            <td>
                              {r.seguimiento ? `Seguimiento «${r.seguimiento}»` : (r.orden ?? 0) + 1} · {r.plantilla ?? "—"}
                            </td>
                            <td>{ESTADOS[r.estado] ?? r.estado}</td>
                            <td>{r.motivo ? (MOTIVOS[r.motivo] ?? r.motivo) : "—"}</td>
                            <td>{cuando(r.programado_para)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

