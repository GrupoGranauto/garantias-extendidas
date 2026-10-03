import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import Interruptor from "../componentes/Interruptor";
import { IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type TipoAuto = "tarea" | "pregunta" | "whatsapp";
type Cfg = Record<string, unknown>;

type Automatizacion = { id?: string; clave: string; tipo: TipoAuto; nombre: string; activa: boolean; config: Cfg };
type EtapaApi = {
  id: string;
  nombre: string;
  color: string;
  tipo: "abierta" | "ganada" | "perdida";
  automatizaciones: { id: string; tipo: TipoAuto; nombre: string; activa: boolean; config: Cfg }[];
};
type Respuesta = {
  etapas: EtapaApi[];
  plantillas: { id: string; nombre: string | null; nombre_tecnico: string; estado: string }[];
  destinos: { nombre_tecnico: string; nombre_visible: string; tipo: string }[];
  tipos_respuesta: string[];
};

const PESTANAS: { tipo: TipoAuto; titulo: string; ayuda: string; vacio: string }[] = [
  {
    tipo: "tarea",
    titulo: "Tareas",
    ayuda: "Se crea una tarea para el ejecutivo encargado en cuanto la oportunidad entra a esta etapa.",
    vacio: "Sin tareas automáticas en esta etapa.",
  },
  {
    tipo: "pregunta",
    titulo: "Preguntas",
    ayuda: "Preguntas que el ejecutivo debe hacerle al cliente. La respuesta puede quedar registrada en una columna de la tabla.",
    vacio: "Sin preguntas en esta etapa.",
  },
  {
    tipo: "whatsapp",
    titulo: "WhatsApp",
    ayuda: "Envío de una plantilla al entrar a la etapa (mensajes masivos).",
    vacio: "Sin envíos de WhatsApp en esta etapa.",
  },
];

const ETIQUETA_RESPUESTA: Record<string, string> = {
  texto: "Texto libre",
  opcion: "Una opción de una lista",
  fecha: "Fecha",
  numero: "Número",
  si_no: "Sí / No",
};

let contador = 0;
const nuevaClave = () => `n${++contador}`;

function configInicial(tipo: TipoAuto): Cfg {
  if (tipo === "tarea") return { titulo: "", descripcion: "", vence_horas: 24 };
  if (tipo === "pregunta")
    return { texto: "", tipo_respuesta: "texto", opciones: [], campo_destino: null, obligatoria: false, vence_horas: null };
  return { plantilla_id: null, retraso_horas: 0 };
}

function aLocal(a: EtapaApi["automatizaciones"][number]): Automatizacion {
  return { ...a, clave: a.id };
}

/**
 * Automatizaciones por etapa: "Cuando una oportunidad entra a esta etapa → entonces…".
 * Lo que se guarda aquí lo ejecuta el motor del servidor: tareas y preguntas para el
 * ejecutivo encargado. Los envíos de WhatsApp se configuran, pero el motor aún no los
 * manda: falta definir de dónde sale el consentimiento del cliente.
 */
export default function Automatizaciones() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [etapaId, setEtapaId] = useState<string | null>(null);
  const [pestana, setPestana] = useState<TipoAuto>("tarea");
  const [borradores, setBorradores] = useState<Record<string, Automatizacion[]>>({});
  const [sucias, setSucias] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  function cargar() {
    apiFetch<Respuesta>(`/api/admin/sucursales/${sucursalId}/crm/automatizaciones`)
      .then((d) => {
        setDatos(d);
        setBorradores(Object.fromEntries(d.etapas.map((e) => [e.id, e.automatizaciones.map(aLocal)])));
        setSucias(new Set());
        setEtapaId((actual) => actual ?? d.etapas[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar."));
  }
  useEffect(cargar, [sucursalId]);

  const etapa = datos?.etapas.find((e) => e.id === etapaId) ?? null;
  const items = etapaId ? (borradores[etapaId] ?? []) : [];
  const delTipo = useMemo(() => items.filter((i) => i.tipo === pestana), [items, pestana]);
  const sucia = etapaId ? sucias.has(etapaId) : false;

  function cambiar(fn: (prev: Automatizacion[]) => Automatizacion[]) {
    if (!etapaId) return;
    setBorradores((b) => ({ ...b, [etapaId]: fn(b[etapaId] ?? []) }));
    setSucias((s) => new Set(s).add(etapaId));
    setAviso(null);
  }
  const actualizar = (clave: string, cambios: Partial<Automatizacion>) =>
    cambiar((prev) => prev.map((i) => (i.clave === clave ? { ...i, ...cambios } : i)));
  const actualizarCfg = (clave: string, cambios: Cfg) =>
    cambiar((prev) => prev.map((i) => (i.clave === clave ? { ...i, config: { ...i.config, ...cambios } } : i)));

  function agregar() {
    cambiar((prev) => [...prev, { clave: nuevaClave(), tipo: pestana, nombre: "", activa: false, config: configInicial(pestana) }]);
  }

  async function guardar() {
    if (!etapaId) return;
    setGuardando(true);
    setAviso(null);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/crm/automatizaciones/${etapaId}`, {
        method: "PUT",
        body: JSON.stringify({
          items: items.map((i) => ({ ...(i.id ? { id: i.id } : {}), tipo: i.tipo, nombre: i.nombre, activa: i.activa, config: i.config })),
        }),
      });
      cargar();
      setAviso({ tipo: "ok", texto: "Cambios guardados." });
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!datos) return <Cargador />;

  const info = PESTANAS.find((p) => p.tipo === pestana)!;
  const cuenta = (e: EtapaApi) => (borradores[e.id] ?? []).length;

  return (
    <div className="pagina-formulario">
      <p className="pestana-descripcion">
        Define qué pasa cuando una oportunidad entra a cada etapa del embudo. Las tareas y preguntas se asignan solas al ejecutivo
        encargado de esa oportunidad.
      </p>

      <div className="auto">
        <nav className="auto-etapas" aria-label="Etapas del embudo">
          {datos.etapas.map((e) => (
            <button
              key={e.id}
              type="button"
              className={`auto-etapa${e.id === etapaId ? " auto-etapa-activa" : ""}`}
              style={{ "--etapa": e.color } as CSSProperties}
              onClick={() => setEtapaId(e.id)}
            >
              <span className="auto-etapa-punto" />
              <span className="auto-etapa-nombre">{e.nombre}</span>
              {cuenta(e) > 0 && <span className="auto-etapa-cuenta">{cuenta(e)}</span>}
              {sucias.has(e.id) && <span className="auto-etapa-sucia" title="Cambios sin guardar" />}
            </button>
          ))}
        </nav>

        {etapa && (
          <section className="auto-panel">
            <header className="auto-panel-cab">
              <div>
                <h2>
                  Cuando entra a <span style={{ color: etapa.color }}>{etapa.nombre}</span>
                </h2>
                <p>{info.ayuda}</p>
              </div>
              <button type="button" className="boton-guardar" disabled={!sucia || guardando} onClick={guardar}>
                {guardando ? "Guardando…" : "Guardar cambios"}
              </button>
            </header>

            {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

            <div className="auto-pestanas" role="tablist">
              {PESTANAS.map((p) => {
                const n = items.filter((i) => i.tipo === p.tipo).length;
                return (
                  <button
                    key={p.tipo}
                    type="button"
                    role="tab"
                    aria-selected={pestana === p.tipo}
                    className={`auto-pestana${pestana === p.tipo ? " auto-pestana-activa" : ""}`}
                    onClick={() => setPestana(p.tipo)}
                  >
                    {p.titulo}
                    {n > 0 && <span className="auto-pestana-n">{n}</span>}
                  </button>
                );
              })}
            </div>

            {pestana === "whatsapp" && (
              <Alerta tipo="info">
                Aquí solo se deja configurado el envío. El motor todavía no manda mensajes: antes hay que definir de dónde sale el
                consentimiento del cliente y el control de frecuencia.
              </Alerta>
            )}

            {delTipo.length === 0 && <p className="auto-vacio">{info.vacio}</p>}

            {delTipo.map((a) => (
              <article key={a.clave} className="auto-tarjeta">
                <div className="auto-tarjeta-cab">
                  <input
                    type="text"
                    className="auto-input auto-nombre"
                    placeholder="Nombre de la automatización"
                    value={a.nombre}
                    maxLength={120}
                    onChange={(e) => actualizar(a.clave, { nombre: e.target.value })}
                  />
                  <Interruptor etiqueta={a.activa ? "Activa" : "Apagada"} activo={a.activa} onChange={(v) => actualizar(a.clave, { activa: v })} />
                  <button
                    type="button"
                    className="auto-quitar"
                    aria-label="Quitar automatización"
                    onClick={() => cambiar((prev) => prev.filter((i) => i.clave !== a.clave))}
                  >
                    <IconoXMarca className="icono-inline" />
                  </button>
                </div>

                {a.tipo === "tarea" && <EditorTarea cfg={a.config} onCambio={(c) => actualizarCfg(a.clave, c)} />}
                {a.tipo === "pregunta" && (
                  <EditorPregunta cfg={a.config} destinos={datos.destinos} onCambio={(c) => actualizarCfg(a.clave, c)} />
                )}
                {a.tipo === "whatsapp" && (
                  <EditorWhatsapp cfg={a.config} plantillas={datos.plantillas} onCambio={(c) => actualizarCfg(a.clave, c)} />
                )}
              </article>
            ))}

            <button type="button" className="boton-secundario-claro auto-agregar" onClick={agregar}>
              Agregar {pestana === "tarea" ? "tarea" : pestana === "pregunta" ? "pregunta" : "envío de WhatsApp"}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

function CampoHoras({ valor, onChange, etiqueta }: { valor: unknown; onChange: (v: number | null) => void; etiqueta: string }) {
  return (
    <label className="auto-campo">
      <span>{etiqueta}</span>
      <input
        type="number"
        min={0}
        className="auto-input"
        placeholder="Sin vencimiento"
        value={typeof valor === "number" ? valor : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))))}
      />
    </label>
  );
}

function EditorTarea({ cfg, onCambio }: { cfg: Cfg; onCambio: (c: Cfg) => void }) {
  return (
    <div className="auto-cuerpo">
      <label className="auto-campo auto-campo-ancho">
        <span>Título de la tarea</span>
        <input
          type="text"
          className="auto-input"
          placeholder="Ej. Llamar a {cliente}"
          maxLength={160}
          value={String(cfg.titulo ?? "")}
          onChange={(e) => onCambio({ titulo: e.target.value })}
        />
        <small>Puedes usar {"{cliente}"}, {"{vin}"}, {"{campana}"} y {"{agencia}"}.</small>
      </label>
      <label className="auto-campo auto-campo-ancho">
        <span>Descripción (opcional)</span>
        <textarea
          className="auto-input"
          rows={2}
          maxLength={1000}
          value={String(cfg.descripcion ?? "")}
          onChange={(e) => onCambio({ descripcion: e.target.value })}
        />
      </label>
      <CampoHoras etiqueta="Vence a las (horas)" valor={cfg.vence_horas} onChange={(v) => onCambio({ vence_horas: v })} />
    </div>
  );
}

function EditorPregunta({
  cfg,
  destinos,
  onCambio,
}: {
  cfg: Cfg;
  destinos: Respuesta["destinos"];
  onCambio: (c: Cfg) => void;
}) {
  const tipo = String(cfg.tipo_respuesta ?? "texto");
  const opciones = Array.isArray(cfg.opciones) ? (cfg.opciones as string[]) : [];
  const esFecha = tipo === "fecha";
  // Una respuesta de fecha solo va a columnas de fecha, y el resto a las de texto.
  const posibles = destinos.filter((d) => (d.tipo === "fecha") === esFecha);

  return (
    <div className="auto-cuerpo">
      <label className="auto-campo auto-campo-ancho">
        <span>Pregunta para el cliente</span>
        <input
          type="text"
          className="auto-input"
          placeholder="Ej. ¿Qué cobertura le interesa?"
          maxLength={300}
          value={String(cfg.texto ?? "")}
          onChange={(e) => onCambio({ texto: e.target.value })}
        />
      </label>
      <label className="auto-campo">
        <span>Tipo de respuesta</span>
        <select
          className="auto-input"
          value={tipo}
          onChange={(e) => {
            const nuevo = e.target.value;
            // Cambiar de fecha a otro tipo (o al revés) invalida la columna elegida.
            onCambio({ tipo_respuesta: nuevo, campo_destino: (nuevo === "fecha") === esFecha ? cfg.campo_destino : null });
          }}
        >
          {Object.entries(ETIQUETA_RESPUESTA).map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="auto-campo">
        <span>Guardar la respuesta en</span>
        <select
          className="auto-input"
          value={String(cfg.campo_destino ?? "")}
          onChange={(e) => onCambio({ campo_destino: e.target.value || null })}
        >
          <option value="">No guardar en la tabla</option>
          {posibles.map((d) => (
            <option key={d.nombre_tecnico} value={d.nombre_tecnico}>
              {d.nombre_visible}
            </option>
          ))}
        </select>
      </label>
      {tipo === "opcion" && (
        <label className="auto-campo auto-campo-ancho">
          <span>Opciones (una por línea)</span>
          <textarea
            className="auto-input"
            rows={3}
            value={opciones.join("\n")}
            onChange={(e) =>
              onCambio({ opciones: e.target.value.split("\n").map((o) => o.trim()).filter((o) => o !== "").slice(0, 20) })
            }
          />
        </label>
      )}
      <CampoHoras etiqueta="Vence a las (horas)" valor={cfg.vence_horas} onChange={(v) => onCambio({ vence_horas: v })} />
      <div className="auto-campo auto-campo-casilla">
        <Interruptor etiqueta="Respuesta obligatoria" activo={cfg.obligatoria === true} onChange={(v) => onCambio({ obligatoria: v })} />
      </div>
    </div>
  );
}

function EditorWhatsapp({
  cfg,
  plantillas,
  onCambio,
}: {
  cfg: Cfg;
  plantillas: Respuesta["plantillas"];
  onCambio: (c: Cfg) => void;
}) {
  return (
    <div className="auto-cuerpo">
      <label className="auto-campo auto-campo-ancho">
        <span>Plantilla de WhatsApp</span>
        <select
          className="auto-input"
          value={String(cfg.plantilla_id ?? "")}
          onChange={(e) => onCambio({ plantilla_id: e.target.value || null })}
        >
          <option value="">Elige una plantilla</option>
          {plantillas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nombre ?? p.nombre_tecnico} ({p.estado})
            </option>
          ))}
        </select>
      </label>
      <CampoHoras etiqueta="Enviar después de (horas)" valor={cfg.retraso_horas} onChange={(v) => onCambio({ retraso_horas: v ?? 0 })} />
    </div>
  );
}
