import { useCallback, useEffect, useRef, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { supabase } from "../lib/supabase";
import { usePortal } from "./PortalProvider";

type Tarea = {
  id: string;
  tipo: "tarea" | "pregunta";
  titulo: string;
  descripcion: string | null;
  config: Record<string, unknown>;
  asignado_a: string | null;
  vence_en: string | null;
  estado: "pendiente" | "hecha" | "cancelada";
  respuesta: string | null;
  completada_en: string | null;
  cliente: string | null;
  telefono_principal: string | null;
  etapa_embudo: string | null;
};

type Filtro = "pendiente" | "hecha";

function vencimiento(valor: string | null): { texto: string; vencida: boolean } | null {
  if (!valor) return null;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return { texto: d.toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }), vencida: d.getTime() < Date.now() };
}

/** Bandeja de tareas y preguntas del ejecutivo (las crean las automatizaciones por etapa). */
export default function Tareas() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [filtro, setFiltro] = useState<Filtro>("pendiente");
  const [tareas, setTareas] = useState<Tarea[] | null>(null);
  const [pendientes, setPendientes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [respuestas, setRespuestas] = useState<Record<string, string>>({});
  const [enviando, setEnviando] = useState<string | null>(null);
  const [errorTarea, setErrorTarea] = useState<{ id: string; texto: string } | null>(null);

  const cargar = useCallback(() => {
    apiFetch<{ tareas: Tarea[]; pendientes: number }>(`/api/admin/sucursales/${sucursalId}/crm/tareas?estado=${filtro}`)
      .then((d) => {
        setTareas(d.tareas);
        setPendientes(d.pendientes);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las tareas."));
  }, [sucursalId, filtro]);

  useEffect(cargar, [cargar]);

  const cargarRef = useRef(cargar);
  cargarRef.current = cargar;
  useEffect(() => {
    const canal = supabase
      .channel(`datos:${sucursalId}`)
      .on("broadcast", { event: "tareas" }, () => cargarRef.current())
      .subscribe();
    return () => {
      void supabase.removeChannel(canal);
    };
  }, [sucursalId]);

  async function accion(t: Tarea, tipo: "completar" | "cancelar") {
    setEnviando(t.id);
    setErrorTarea(null);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/crm/tareas/${t.id}/${tipo}`, {
        method: "POST",
        body: JSON.stringify(tipo === "completar" ? { respuesta: respuestas[t.id] ?? null } : {}),
      });
      setTareas((prev) => prev?.filter((x) => x.id !== t.id) ?? prev);
      setPendientes((n) => Math.max(0, n - 1));
    } catch (err) {
      setErrorTarea({ id: t.id, texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setEnviando(null);
    }
  }

  function entradaRespuesta(t: Tarea) {
    const tipo = String(t.config.tipo_respuesta ?? "texto");
    const valor = respuestas[t.id] ?? "";
    const poner = (v: string) => setRespuestas((r) => ({ ...r, [t.id]: v }));
    if (tipo === "opcion") {
      const opciones = Array.isArray(t.config.opciones) ? (t.config.opciones as string[]) : [];
      return (
        <select className="tarea-input" value={valor} onChange={(e) => poner(e.target.value)}>
          <option value="">Elige una opción</option>
          {opciones.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    if (tipo === "si_no") {
      return (
        <select className="tarea-input" value={valor} onChange={(e) => poner(e.target.value)}>
          <option value="">Elige</option>
          <option value="Sí">Sí</option>
          <option value="No">No</option>
        </select>
      );
    }
    if (tipo === "fecha") {
      return (
        <input type="date" className="tarea-input" min="2000-01-01" max={new Date().toISOString().slice(0, 10)} value={valor} onChange={(e) => poner(e.target.value)} />
      );
    }
    return (
      <input
        type={tipo === "numero" ? "number" : "text"}
        className="tarea-input"
        placeholder="Respuesta del cliente"
        value={valor}
        onChange={(e) => poner(e.target.value)}
      />
    );
  }

  return (
    <div className="pagina-formulario">
      <div className="pf-barra">
        <div className="vista-selector" role="group" aria-label="Estado">
          <button type="button" className={`vista-opcion${filtro === "pendiente" ? " vista-opcion-activa" : ""}`} onClick={() => setFiltro("pendiente")}>
            Pendientes{pendientes > 0 ? ` (${pendientes})` : ""}
          </button>
          <button type="button" className={`vista-opcion${filtro === "hecha" ? " vista-opcion-activa" : ""}`} onClick={() => setFiltro("hecha")}>
            Hechas
          </button>
        </div>
      </div>

      {error && <Alerta tipo="error">{error}</Alerta>}
      {!tareas && !error && <Cargador />}

      {tareas && tareas.length === 0 && (
        <div className="marcador">
          <strong>{filtro === "pendiente" ? "No tienes tareas pendientes" : "Todavía no hay tareas hechas"}</strong>
          <span>Las tareas aparecen cuando una oportunidad entra a una etapa con automatizaciones activas.</span>
        </div>
      )}

      <div className="tareas-lista">
        {tareas?.map((t) => {
          const v = vencimiento(t.vence_en);
          const esPregunta = t.tipo === "pregunta";
          return (
            <article key={t.id} className="tarea">
              <div className="tarea-cuerpo">
                <span className="tarea-tipo">{esPregunta ? "Pregunta" : "Tarea"}</span>
                <strong className="tarea-titulo">{t.titulo}</strong>
                {t.descripcion && <p className="tarea-desc">{t.descripcion}</p>}
                <p className="tarea-meta">
                  {t.cliente ?? "Sin nombre"}
                  {t.telefono_principal ? ` · ${t.telefono_principal}` : ""}
                  {t.etapa_embudo ? ` · ${t.etapa_embudo}` : ""}
                  {t.asignado_a ? ` · ${t.asignado_a}` : ""}
                </p>
                {filtro === "hecha" && t.respuesta && <p className="tarea-respuesta">Respuesta: {t.respuesta}</p>}
                {errorTarea?.id === t.id && <Alerta tipo="error">{errorTarea.texto}</Alerta>}
              </div>

              <div className="tarea-lado">
                {v && <span className={`tarea-vence${v.vencida && filtro === "pendiente" ? " tarea-vence-tarde" : ""}`}>{v.texto}</span>}
                {filtro === "pendiente" && (
                  <>
                    {esPregunta && entradaRespuesta(t)}
                    <div className="tarea-acciones">
                      <button type="button" className="boton-guardar" disabled={enviando === t.id} onClick={() => accion(t, "completar")}>
                        {esPregunta ? "Registrar" : "Hecha"}
                      </button>
                      <button type="button" className="boton-secundario-claro" disabled={enviando === t.id} onClick={() => accion(t, "cancelar")}>
                        Descartar
                      </button>
                    </div>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
