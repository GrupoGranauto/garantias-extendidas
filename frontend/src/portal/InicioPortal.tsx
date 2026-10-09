import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import {
  IconoCalendario,
  IconoChat,
  IconoCheck,
  IconoDocumento,
  IconoLlamada,
  IconoReloj,
  IconoTareas,
  IconoUsuarios,
  IconoVistaEmbudo,
} from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { supabase } from "../lib/supabase";
import FichaOportunidad from "./FichaOportunidad";
import { usePortal } from "./PortalProvider";

type Lead = {
  id: string;
  cliente: string | null;
  campana: string | null;
  estado: string;
  color: string;
  ejecutivo: string | null;
  entro_a_etapa_en: string | null;
  fuera_sla: boolean;
};
type Actividad = {
  tipo: string;
  titulo: string;
  creado_en: string;
  oportunidad_id: string;
  cliente: string | null;
  autor: string | null;
};
type Resumen = {
  cartera_abierta: number;
  sin_intentar: number;
  fuera_sla: number;
  tareas_pendientes: number;
  tareas_vencidas: number;
  tareas_vencen_hoy: number;
  contactos_hoy: number;
  contactos_efectivos_hoy: number;
  ventas_mes: number;
  atender: Lead[];
  atender_total: number;
  embudo: { nombre: string; color: string; total: number }[];
  campanas: { campana: string; total: number }[];
  actividad: Actividad[];
};
type Tarea = {
  id: string;
  tipo: "tarea" | "pregunta";
  titulo: string;
  vence_en: string | null;
  cliente: string | null;
  asignado_a: string | null;
  oportunidad_id: string;
};

function vencimiento(valor: string | null): { texto: string; tarde: boolean } | null {
  if (!valor) return null;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return {
    texto: d.toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
    tarde: d.getTime() < Date.now(),
  };
}

/** Tiempo transcurrido corto: «12 min», «7 h», «3 d». */
function hace(valor: string | null): string {
  if (!valor) return "";
  const min = Math.max(0, Math.round((Date.now() - new Date(valor).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const horas = Math.round(min / 60);
  return horas < 48 ? `${horas} h` : `${Math.round(horas / 24)} d`;
}

function saludo(): string {
  const h = new Date().getHours();
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}

function hoy(): string {
  const texto = new Date().toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Hermosillo" });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function iniciales(nombre: string | null): string {
  const partes = (nombre ?? "").trim().split(/\s+/).filter(Boolean);
  return ((partes[0]?.[0] ?? "") + (partes[1]?.[0] ?? "")).toUpperCase() || "?";
}

function iconoActividad(tipo: string): ReactNode {
  if (tipo === "llamada") return <IconoLlamada />;
  if (tipo === "whatsapp" || tipo === "mensaje_entrante" || tipo === "ahora_no") return <IconoChat />;
  if (tipo === "estado") return <IconoVistaEmbudo />;
  if (tipo === "tarea") return <IconoTareas />;
  return <IconoDocumento />;
}

type Indicador = { etiqueta: string; valor: number; nota?: string; alerta?: boolean; a: string; icono: ReactNode };

/**
 * Inicio del portal. Arriba, los números del día; a la izquierda lo que hay que atender ahora (tareas y leads sin
 * intentar o fuera de tiempo, que abren su ficha) y lo último que pasó; a la derecha, la cartera por estado y campaña.
 */
export default function InicioPortal() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const base = `/api/admin/sucursales/${sucursalId}/crm`;

  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [nombre, setNombre] = useState<string | null>(null);
  const [fichaId, setFichaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(() => {
    Promise.all([apiFetch<Resumen>(`${base}/resumen`), apiFetch<{ tareas: Tarea[] }>(`${base}/tareas?estado=pendiente`)])
      .then(([r, t]) => {
        setResumen(r);
        setTareas(t.tareas.slice(0, 4));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el resumen."));
  }, [base]);

  useEffect(cargar, [cargar]);

  useEffect(() => {
    apiFetch<{ nombre: string | null }>("/api/perfil")
      .then((p) => setNombre(p.nombre?.split(" ")[0] ?? null))
      .catch(() => {});
  }, []);

  const cargarRef = useRef(cargar);
  cargarRef.current = cargar;
  useEffect(() => {
    const canal = supabase
      .channel(`datos:${sucursalId}`)
      .on("broadcast", { event: "tareas" }, () => cargarRef.current())
      .on("broadcast", { event: "refresh" }, () => cargarRef.current())
      .subscribe();
    return () => {
      void supabase.removeChannel(canal);
    };
  }, [sucursalId]);

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!resumen) return <Cargador />;

  const indicadores: Indicador[] = [
    { etiqueta: "Tareas vencidas", valor: resumen.tareas_vencidas, alerta: resumen.tareas_vencidas > 0, a: "/tareas", icono: <IconoTareas /> },
    {
      etiqueta: "Tareas pendientes",
      valor: resumen.tareas_pendientes,
      nota: resumen.tareas_vencen_hoy > 0 ? `${resumen.tareas_vencen_hoy} vencen en 24 h` : undefined,
      a: "/tareas",
      icono: <IconoCalendario />,
    },
    { etiqueta: "Sin intentar contactar", valor: resumen.sin_intentar, a: "/base-datos", icono: <IconoUsuarios /> },
    { etiqueta: "Fuera de tiempo", valor: resumen.fuera_sla, alerta: resumen.fuera_sla > 0, a: "/base-datos", icono: <IconoReloj /> },
    { etiqueta: "Contactos de hoy", valor: resumen.contactos_hoy, nota: `${resumen.contactos_efectivos_hoy} efectivos`, a: "/reportes", icono: <IconoLlamada /> },
    { etiqueta: "Ventas del mes", valor: resumen.ventas_mes, a: "/reportes", icono: <IconoCheck /> },
  ];
  const abiertos = resumen.embudo.reduce((n, e) => n + e.total, 0);
  const porAtender = tareas.length + resumen.atender_total;
  const n = (v: number) => v.toLocaleString("es-MX");

  return (
    <div className="pagina-formulario inicio">
      <header className="inicio-encabezado">
        <h1 className="inicio-titulo">
          {saludo()}
          {nombre ? `, ${nombre}` : ""}
        </h1>
        <p>
          {hoy()} ·{" "}
          {resumen.atender_total > 0
            ? `${n(resumen.atender_total)} ${resumen.atender_total === 1 ? "lead espera" : "leads esperan"} atención`
            : "Todo al día"}
        </p>
      </header>

      <section className="inicio-indicadores" aria-label="Indicadores del día">
        {indicadores.map((i) => (
          <Link key={i.etiqueta} to={i.a} className={`inicio-ind${i.alerta ? " inicio-ind-alerta" : ""}`}>
            <span className="inicio-ind-icono">{i.icono}</span>
            <span className="inicio-ind-texto">
              <span>{i.etiqueta}</span>
              <strong>{n(i.valor)}</strong>
              {i.nota && <small>{i.nota}</small>}
            </span>
          </Link>
        ))}
      </section>

      <div className="inicio-rejilla">
        <div className="inicio-columna">
          <section className="inicio-tarjeta">
            <div className="inicio-cab">
              <h3>
                Atender ahora
                {porAtender > 0 && <span className="inicio-contador">{n(porAtender)}</span>}
              </h3>
              <Link to="/base-datos" className="boton-tenue">
                Ver base de datos
              </Link>
            </div>

            {porAtender === 0 && (
              <div className="inicio-vacio">
                <IconoCheck />
                <p>Todo al día: no hay tareas pendientes ni leads esperando contacto.</p>
              </div>
            )}

            {tareas.length > 0 && (
              <ul className="inicio-tareas">
                {tareas.map((t) => {
                  const v = vencimiento(t.vence_en);
                  return (
                    <li key={t.id}>
                      <button type="button" onClick={() => setFichaId(t.oportunidad_id)}>
                        <IconoTareas className="inicio-tarea-icono" />
                        <span className="inicio-tarea-texto">
                          <strong>{t.titulo}</strong>
                          <small>
                            {t.cliente ?? "Sin nombre"}
                            {t.tipo === "pregunta" ? " · Pregunta" : ""}
                          </small>
                        </span>
                        {v && <span className={`tarea-vence${v.tarde ? " tarea-vence-tarde" : ""}`}>{v.texto}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {resumen.atender.length > 0 && (
              <div className="inicio-tabla">
                <div className="inicio-tabla-cab" aria-hidden="true">
                  <span>Cliente</span>
                  <span>Campaña</span>
                  <span>Estado del lead</span>
                  <span>Ejecutivo</span>
                  <span>Esperando</span>
                </div>
                {resumen.atender.map((l) => (
                  <button key={l.id} type="button" className="inicio-tabla-fila" onClick={() => setFichaId(l.id)}>
                    <span className="inicio-cliente">
                      <span className="inicio-avatar">{iniciales(l.cliente)}</span>
                      <strong>{l.cliente ?? "Sin nombre"}</strong>
                    </span>
                    <span>{l.campana ? <span className="embudo-mini">{l.campana}</span> : "—"}</span>
                    <span className="inicio-estado" style={{ "--etapa": l.color } as CSSProperties}>
                      {l.estado}
                    </span>
                    <span className="inicio-ejecutivo">{l.ejecutivo ?? "Sin asignar"}</span>
                    <span className="inicio-espera">
                      <span className={`inicio-pill${l.fuera_sla ? " inicio-pill-alerta" : ""}`}>{l.fuera_sla ? "Fuera de tiempo" : "Sin intentar"}</span>
                      <small>{hace(l.entro_a_etapa_en)}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {resumen.atender_total > resumen.atender.length && (
              <p className="rep-ayuda">Y {n(resumen.atender_total - resumen.atender.length)} leads más esperando contacto en la base de datos.</p>
            )}
          </section>

          <section className="inicio-tarjeta">
            <div className="inicio-cab">
              <h3>Actividad reciente</h3>
              <span className="inicio-total">Últimos 7 días</span>
            </div>
            {resumen.actividad.length === 0 ? (
              <p className="auto-vacio">Sin movimiento en la cartera esta semana. Aquí aparecerán las llamadas, los WhatsApp y los cambios de estado.</p>
            ) : (
              <ul className="inicio-actividad">
                {resumen.actividad.map((a, i) => (
                  <li key={`${a.oportunidad_id}-${a.creado_en}-${i}`}>
                    <button type="button" onClick={() => setFichaId(a.oportunidad_id)}>
                      <span className="inicio-actividad-icono">{iconoActividad(a.tipo)}</span>
                      <span className="inicio-actividad-texto">
                        <strong>{a.cliente ?? "Sin nombre"}</strong> · {a.titulo}
                        {a.autor && <small>{a.autor}</small>}
                      </span>
                      <span className="inicio-actividad-cuando">{hace(a.creado_en)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="inicio-columna">
          <section className="inicio-tarjeta">
            <div className="inicio-cab">
              <h3>Embudo</h3>
              <span className="inicio-total">{n(abiertos)} abiertos</span>
            </div>
            <div className="inicio-segmentos" role="img" aria-label="Leads abiertos por estado">
              {abiertos === 0 ? (
                <span className="inicio-segmento-vacio" />
              ) : (
                resumen.embudo
                  .filter((e) => e.total > 0)
                  .map((e) => <span key={e.nombre} style={{ flexGrow: e.total, background: e.color }} title={`${e.nombre}: ${e.total}`} />)
              )}
            </div>
            <ul className="inicio-leyenda">
              {resumen.embudo.map((e) => (
                <li key={e.nombre} className={e.total === 0 ? "inicio-leyenda-cero" : undefined}>
                  <span className="inicio-leyenda-punto" style={{ background: e.total === 0 ? undefined : e.color }} />
                  <span className="inicio-leyenda-nombre">{e.nombre}</span>
                  <strong>{n(e.total)}</strong>
                  <small>{abiertos > 0 ? `${Math.round((e.total / abiertos) * 100)}%` : "—"}</small>
                </li>
              ))}
            </ul>
          </section>

          <section className="inicio-tarjeta">
            <div className="inicio-cab">
              <h3>Leads por campaña</h3>
            </div>
            {resumen.campanas.length === 0 ? (
              <p className="auto-vacio">No hay leads abiertos en campaña.</p>
            ) : (
              <div className="inicio-campanas">
                {resumen.campanas.map((c) => (
                  <div key={c.campana} className="inicio-campana">
                    <span>{c.campana}</span>
                    <strong>{n(c.total)}</strong>
                    <small>{c.total === 1 ? "lead abierto" : "leads abiertos"}</small>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {fichaId && <FichaOportunidad sucursalId={sucursalId} oportunidadId={fichaId} onCerrar={() => setFichaId(null)} onCambio={cargar} />}
    </div>
  );
}
