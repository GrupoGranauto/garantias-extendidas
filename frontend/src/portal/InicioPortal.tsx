import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { supabase } from "../lib/supabase";
import { usePortal } from "./PortalProvider";

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
};
type Tarea = {
  id: string;
  tipo: "tarea" | "pregunta";
  titulo: string;
  vence_en: string | null;
  cliente: string | null;
  asignado_a: string | null;
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

function saludo(): string {
  const h = new Date().getHours();
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}

type Tarjeta = { etiqueta: string; valor: number | string; nota?: string; alerta?: boolean; a?: string };

/** Inicio del portal: lo que hay que atender hoy, de un vistazo y con acceso directo a cada cosa. */
export default function InicioPortal() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const base = `/api/admin/sucursales/${sucursalId}/crm`;

  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(() => {
    Promise.all([apiFetch<Resumen>(`${base}/resumen`), apiFetch<{ tareas: Tarea[] }>(`${base}/tareas?estado=pendiente`)])
      .then(([r, t]) => {
        setResumen(r);
        setTareas(t.tareas.slice(0, 6));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el resumen."));
  }, [base]);

  useEffect(cargar, [cargar]);

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

  const tarjetas: Tarjeta[] = [
    { etiqueta: "Tareas vencidas", valor: resumen.tareas_vencidas, alerta: resumen.tareas_vencidas > 0, a: "/tareas" },
    { etiqueta: "Tareas pendientes", valor: resumen.tareas_pendientes, nota: resumen.tareas_vencen_hoy > 0 ? `${resumen.tareas_vencen_hoy} vencen en 24 h` : undefined, a: "/tareas" },
    { etiqueta: "Sin intentar contactar", valor: resumen.sin_intentar, a: "/base-datos" },
    { etiqueta: "Fuera de tiempo (SLA)", valor: resumen.fuera_sla, alerta: resumen.fuera_sla > 0, a: "/base-datos" },
    { etiqueta: "Contactos de hoy", valor: resumen.contactos_hoy, nota: `${resumen.contactos_efectivos_hoy} efectivos`, a: "/reportes" },
    { etiqueta: "Ventas del mes", valor: resumen.ventas_mes, a: "/reportes" },
    { etiqueta: "Cartera abierta", valor: resumen.cartera_abierta.toLocaleString("es-MX"), a: "/base-datos" },
  ];

  return (
    <div className="pagina-formulario">
      <h1 className="inicio-titulo">{saludo()}</h1>
      <p className="pestana-descripcion">Esto es lo que necesita tu atención hoy.</p>

      <div className="rep-kpis">
        {tarjetas.map((t) => (
          <Link key={t.etiqueta} to={t.a ?? "/"} className={`rep-kpi inicio-kpi${t.alerta ? " rep-kpi-alerta" : ""}`}>
            <span>{t.etiqueta}</span>
            <strong>{t.valor}</strong>
            {t.nota && <small>{t.nota}</small>}
          </Link>
        ))}
      </div>

      <section className="rep-tarjeta">
        <div className="inicio-cab">
          <h3>Siguientes tareas</h3>
          <Link to="/tareas" className="boton-tenue">
            Ver todas
          </Link>
        </div>
        {tareas.length === 0 ? (
          <p className="auto-vacio">No tienes tareas pendientes.</p>
        ) : (
          <ul className="inicio-tareas">
            {tareas.map((t) => {
              const v = vencimiento(t.vence_en);
              return (
                <li key={t.id}>
                  <div>
                    <strong>{t.titulo}</strong>
                    <small>
                      {t.cliente ?? "Sin nombre"}
                      {t.tipo === "pregunta" ? " · Pregunta" : ""}
                    </small>
                  </div>
                  {v && <span className={`tarea-vence${v.tarde ? " tarea-vence-tarde" : ""}`}>{v.texto}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
