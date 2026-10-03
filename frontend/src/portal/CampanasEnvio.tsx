import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import Interruptor from "../componentes/Interruptor";
import { IconoXMarca } from "../componentes/Iconos";
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
  activa: boolean;
  modo: "simulacion" | "real";
  dias_semana: number[];
  hora_inicio: string;
  hora_fin: string;
  max_por_dia: number;
  dias_entre_mensajes: number;
  oportunidades_activas: number;
  inicio: string | null;
  fin: string | null;
  pasos: Omit<Paso, "clave">[];
};
type Plantilla = { id: string; nombre: string | null; nombre_tecnico: string; estado: string; variables: number; mapeadas: number };
type Consentimiento = { automatico: boolean; fuente: string | null; confirmado_en: string | null; confirmado_por: string | null; registrados: number };
type Respuesta = {
  campanas: Campana[];
  plantillas: Plantilla[];
  consentimiento: Consentimiento;
  etapas: string[];
  whatsapp_listo: boolean;
  motor_encendido: boolean;
};
type Borrador = Omit<Campana, "pasos"> & { pasos: Paso[] };

type VistaPrevia = {
  oportunidades: number;
  bajas: number;
  sin_telefono: number;
  alcanzables: number;
  con_consentimiento: number;
  sin_consentimiento: number;
  pasos: { orden: number; plantilla_id: string | null; programacion: { fecha: string; hora: string; oportunidades: number; vigente: boolean }[] }[];
};
type Registro = {
  por_estado: { estado: string; n: number }[];
  por_motivo: { motivo: string; estado: string; n: number }[];
  recientes: { id: string; campana: string; estado: string; motivo: string | null; programado_para: string; enviado_en: string | null; error: string | null; orden: number; cliente: string | null; plantilla: string | null }[];
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
  sin_consentimiento: "Sin consentimiento registrado",
  baja: "Pidió la baja",
  sin_telefono: "Sin teléfono",
  sin_celular: "El número no es celular",
  etapa_no_permitida: "Etapa no permitida",
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
  const [fuente, setFuente] = useState("Contrato de venta");
  const [confirmo, setConfirmo] = useState(false);
  const [retirar, setRetirar] = useState(false);
  const [guardandoConsentimiento, setGuardandoConsentimiento] = useState(false);
  const [avisoConsentimiento, setAvisoConsentimiento] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

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

  async function cambiarConsentimiento(activo: boolean) {
    setGuardandoConsentimiento(true);
    setAvisoConsentimiento(null);
    try {
      const r = await apiFetch<{ contactos: number }>(`${base}/consentimiento-automatico`, {
        method: "PUT",
        body: JSON.stringify(activo ? { activo: true, fuente: fuente.trim(), confirmo } : { activo: false, retirar_registrado: retirar }),
      });
      setAvisoConsentimiento({
        tipo: "ok",
        texto: activo
          ? `Listo: ${r.contactos.toLocaleString("es-MX")} contactos quedaron con consentimiento («${fuente.trim()}»). Los que lleguen después también.`
          : retirar
            ? `Regla apagada y se retiró el consentimiento de ${r.contactos.toLocaleString("es-MX")} contactos.`
            : "Regla apagada. Lo ya registrado se conserva; los contactos nuevos ya no se registran solos.",
      });
      setConfirmo(false);
      setRetirar(false);
      setPrevia(null);
      cargar();
    } catch (err) {
      setAvisoConsentimiento({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardandoConsentimiento(false);
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
        Define qué mensaje de WhatsApp recibe cada campaña, en qué día y hora, y bajo qué condiciones. Solo se escribe a quien tiene
        consentimiento registrado, y quien pide la baja deja de recibir mensajes para siempre.
      </p>
      {!datos.motor_encendido && (
        <Alerta tipo="info">
          El servidor todavía no tiene encendido el envío automático: aunque una campaña esté activa, no sale ningún mensaje hasta que se
          encienda (variable <strong>CRM_ENVIOS=on</strong> en el servidor).
        </Alerta>
      )}
      {!datos.whatsapp_listo && <Alerta tipo="error">WhatsApp no está configurado o activo en esta sucursal: no se podrá enviar.</Alerta>}

      <section className="rep-tarjeta camp-consentimiento">
        <h3>Consentimiento de los clientes</h3>
        {datos.consentimiento.automatico ? (
          <>
            <Alerta tipo="ok">
              Activo: los clientes aceptan ser contactados en su <strong>{datos.consentimiento.fuente}</strong>. Cada lead que llega a la base queda con
              consentimiento registrado
              {datos.consentimiento.confirmado_en
                ? ` (confirmado${datos.consentimiento.confirmado_por ? ` por ${datos.consentimiento.confirmado_por}` : ""} el ${new Date(datos.consentimiento.confirmado_en).toLocaleDateString("es-MX")})`
                : ""}
              . Registrados por esta regla: {datos.consentimiento.registrados.toLocaleString("es-MX")}.
            </Alerta>
            <p className="rep-ayuda">Quien pida la baja, o a quien se le retire el consentimiento a mano, no recibe mensajes aunque esta regla esté activa.</p>
            <label className="vistas-compartir">
              <input type="checkbox" checked={retirar} onChange={(e) => setRetirar(e.target.checked)} /> Al apagarla, retirar también el consentimiento que esta regla registró
            </label>
            <button type="button" className="boton-secundario-claro" disabled={guardandoConsentimiento} onClick={() => cambiarConsentimiento(false)}>
              Apagar regla
            </button>
          </>
        ) : (
          <>
            <p className="rep-ayuda">
              Para escribirle a un cliente por primera vez, Meta exige que haya aceptado recibir mensajes. Si ese permiso lo da en su contrato de venta,
              actívalo aquí y todos los leads de la base quedarán con consentimiento registrado, con su fuente y fecha. Sin esto, cada persona necesita
              su consentimiento registrado a mano.
            </p>
            <label className="auto-campo">
              <span>Fuente del consentimiento</span>
              <input type="text" className="auto-input" maxLength={80} value={fuente} onChange={(e) => setFuente(e.target.value)} />
            </label>
            <label className="vistas-compartir">
              <input type="checkbox" checked={confirmo} onChange={(e) => setConfirmo(e.target.checked)} /> Confirmo que el contrato de venta incluye la autorización del cliente para ser contactado por WhatsApp
            </label>
            <button type="button" className="boton-guardar" disabled={guardandoConsentimiento || !confirmo || fuente.trim().length < 3} onClick={() => cambiarConsentimiento(true)}>
              {guardandoConsentimiento ? "Registrando…" : "Activar consentimiento por contrato de venta"}
            </button>
          </>
        )}
        {avisoConsentimiento && <Alerta tipo={avisoConsentimiento.tipo}>{avisoConsentimiento.texto}</Alerta>}
      </section>

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
                  {NOMBRES[sel]?.detalle}
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
                    <small>Envía las plantillas por WhatsApp a quien tenga consentimiento.</small>
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
                        min={0}
                        className="auto-input"
                        value={p.vigencia_dias}
                        onChange={(e) => cambiarPaso(p.clave, { vigencia_dias: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
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
                    <small>{p.etapas.length === 0 ? "Cualquier etapa abierta." : ""}</small>
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
              <p className="rep-ayuda">Lo que pasaría con la configuración guardada. No manda ni cambia nada. {sucia ? "Guarda primero para que refleje tus cambios." : ""}</p>
              <button type="button" className="boton-secundario-claro" onClick={verPrevia} disabled={sucia || c.pasos.length === 0}>
                Ver qué pasaría
              </button>
              {previa && (
                <div className="camp-previa">
                  <ul className="camp-cifras">
                    <li><strong>{previa.oportunidades}</strong> oportunidades activas</li>
                    <li><strong>{previa.alcanzables}</strong> con celular y sin baja</li>
                    <li className={previa.con_consentimiento === 0 ? "camp-cifra-alerta" : undefined}><strong>{previa.con_consentimiento}</strong> con consentimiento registrado</li>
                    <li><strong>{previa.sin_consentimiento}</strong> sin consentimiento (no recibirían nada)</li>
                    <li><strong>{previa.sin_telefono}</strong> sin celular válido</li>
                    <li><strong>{previa.bajas}</strong> en baja</li>
                  </ul>
                  {previa.con_consentimiento === 0 && (
                    <Alerta tipo="info">
                      Hoy nadie tiene consentimiento registrado, así que no saldría ningún mensaje. Se registra desde la tabla (elige filas y usa
                      «Consentimiento de WhatsApp») o desde la ficha de cada oportunidad.
                    </Alerta>
                  )}
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
                              {r.orden + 1} · {r.plantilla ?? "—"}
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

