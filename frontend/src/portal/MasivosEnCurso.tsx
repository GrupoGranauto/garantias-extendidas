import { useEffect, useRef, useState } from "react";
import ModalConfirmar from "../componentes/ModalConfirmar";
import { IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";

export type Masivo = {
  id: string;
  plantilla_nombre: string;
  estado: "enviando" | "terminado" | "detenido";
  creado_en: string;
  terminado_en: string | null;
  creado_por: string | null;
  total: number;
  pendientes: number;
  enviados: number;
  entregados: number;
  leidos: number;
  fallidos: number;
  omitidos: number;
  proximo: string | null;
};

export const cuandoMasivo = (v: string | null) =>
  v ? new Date(v).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

/**
 * Cómo van los masivos que se están mandando: se consulta cada pocos segundos mientras haya uno en curso. Al terminar, el
 * aviso se queda con el resultado hasta que el admin lo cierra. Desde aquí se puede detener lo que falta.
 */
export default function MasivosEnCurso({ sucursalId, refresco }: { sucursalId: string; refresco: number }) {
  const base = `/api/admin/sucursales/${sucursalId}/crm/masivos`;
  const [masivos, setMasivos] = useState<Masivo[]>([]);
  const [cerrados, setCerrados] = useState<Set<string>>(new Set());
  const [detener, setDetener] = useState<Masivo | null>(null);
  const [deteniendo, setDeteniendo] = useState(false);
  const [vuelta, setVuelta] = useState(0);
  // Los que se vieron en curso en esta visita: al terminar se sigue mostrando su resultado.
  const seguidos = useRef(new Set<string>());

  useEffect(() => {
    let vivo = true;
    let espera: number | undefined;
    const cargar = () => {
      apiFetch<{ masivos: Masivo[] }>(base)
        .then((d) => {
          if (!vivo) return;
          for (const m of d.masivos) if (m.estado === "enviando") seguidos.current.add(m.id);
          setMasivos(d.masivos.filter((m) => seguidos.current.has(m.id)));
          if (d.masivos.some((m) => m.estado === "enviando")) espera = window.setTimeout(cargar, 4000);
        })
        .catch(() => {
          if (vivo) espera = window.setTimeout(cargar, 15000);
        });
    };
    cargar();
    return () => {
      vivo = false;
      window.clearTimeout(espera);
    };
  }, [base, refresco, vuelta]);

  async function confirmarDetener() {
    if (!detener) return;
    setDeteniendo(true);
    try {
      await apiFetch(`${base}/${detener.id}/detener`, { method: "POST" });
    } catch {
      // Si ya había terminado, el aviso lo mostrará así en la siguiente consulta.
    } finally {
      setDeteniendo(false);
      setDetener(null);
      setVuelta((n) => n + 1);
    }
  }

  const visibles = masivos.filter((m) => !cerrados.has(m.id));
  if (visibles.length === 0) return null;

  return (
    <>
      {visibles.map((m) => {
        const hechos = m.enviados + m.fallidos;
        const porEnviar = hechos + m.pendientes;
        const pct = porEnviar > 0 ? Math.round((hechos * 100) / porEnviar) : 100;
        const enCurso = m.estado === "enviando";
        const empiezaDespues = enCurso && hechos === 0 && m.proximo && new Date(m.proximo).getTime() > Date.now() + 60_000;
        return (
          <div key={m.id} className="masivo-banner" role="status">
            <div className="masivo-banner-texto">
              <strong>
                {enCurso ? "Enviando" : m.estado === "detenido" ? "Masivo detenido" : "Masivo terminado"}: «{m.plantilla_nombre}»
              </strong>
              <span>
                {enCurso && !empiezaDespues && `${hechos.toLocaleString("es-MX")} de ${porEnviar.toLocaleString("es-MX")}`}
                {empiezaDespues && `${porEnviar.toLocaleString("es-MX")} en cola; empieza el ${cuandoMasivo(m.proximo)}`}
                {!enCurso && `${m.enviados.toLocaleString("es-MX")} enviados`}
                {m.fallidos > 0 && ` · ${m.fallidos.toLocaleString("es-MX")} fallidos`}
                {!enCurso && m.omitidos > 0 && ` · ${m.omitidos.toLocaleString("es-MX")} omitidos`}
                {!enCurso && " · El detalle está en Reportes › Masivos."}
              </span>
              {enCurso && (
                <span className="masivo-barra" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} />
                </span>
              )}
            </div>
            {enCurso ? (
              <button type="button" className="boton-secundario-claro" onClick={() => setDetener(m)}>
                Detener
              </button>
            ) : (
              <button type="button" className="auto-quitar" aria-label="Cerrar aviso" onClick={() => setCerrados((s) => new Set(s).add(m.id))}>
                <IconoXMarca className="icono-inline" />
              </button>
            )}
          </div>
        );
      })}
      <ModalConfirmar
        abierto={!!detener}
        titulo="¿Detener el masivo?"
        mensaje="Lo que todavía no sale ya no saldrá. Los mensajes que ya se mandaron no se pueden deshacer."
        textoConfirmar="Detener"
        peligro
        enviando={deteniendo}
        onConfirmar={confirmarDetener}
        onCancelar={() => setDetener(null)}
      />
    </>
  );
}
