import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import ModalConfirmar from "../componentes/ModalConfirmar";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Estado = "borrador" | "pendiente" | "aprobada" | "rechazada" | "pausada" | "deshabilitada";

type Plantilla = {
  id: string;
  nombre_tecnico: string;
  idioma: string;
  categoria: "marketing" | "utility" | "authentication";
  estado: Estado;
  motivo_rechazo: string | null;
  creado_en: string;
};

const ETIQUETA_ESTADO: Record<Estado, string> = {
  borrador: "Borrador",
  pendiente: "En revisión",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  pausada: "Pausada",
  deshabilitada: "Deshabilitada",
};

const ETIQUETA_CATEGORIA: Record<Plantilla["categoria"], string> = {
  marketing: "Marketing",
  utility: "Utilidad",
  authentication: "Autenticación",
};

const PASTILLA_ESTADO: Record<Estado, string> = {
  borrador: "neutral",
  pendiente: "pendiente",
  aprobada: "bien",
  rechazada: "mal",
  pausada: "pendiente",
  deshabilitada: "neutral",
};

/** Plantillas de WhatsApp de esta sucursal. Vive en el portal de la sucursal, no en el panel de plataforma. */
export default function PlantillasListado() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [plantillas, setPlantillas] = useState<Plantilla[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [enviandoId, setEnviandoId] = useState<string | null>(null);
  const [porEliminar, setPorEliminar] = useState<Plantilla | null>(null);
  const [eliminando, setEliminando] = useState(false);

  function cargar() {
    apiFetch<Plantilla[]>(`/api/admin/sucursales/${sucursalId}/plantillas`)
      .then(setPlantillas)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las plantillas."));
  }

  useEffect(cargar, [sucursalId]);

  async function sincronizar() {
    setSincronizando(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/plantillas/sync`, { method: "POST" });
      cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo sincronizar con Meta.");
    } finally {
      setSincronizando(false);
    }
  }

  async function enviarARevision(plantilla: Plantilla) {
    setEnviandoId(plantilla.id);
    setError(null);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/plantillas/${plantilla.id}/enviar`, { method: "POST" });
      cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo enviar la plantilla a revisión.");
    } finally {
      setEnviandoId(null);
    }
  }

  async function eliminar() {
    if (!porEliminar) return;
    setEliminando(true);
    try {
      await apiFetch(`/api/admin/sucursales/${sucursalId}/plantillas/${porEliminar.id}`, { method: "DELETE" });
      setPlantillas((previas) => previas?.filter((p) => p.id !== porEliminar.id) ?? null);
      setPorEliminar(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la plantilla.");
      setPorEliminar(null);
    } finally {
      setEliminando(false);
    }
  }

  return (
    <div className="pagina-formulario">
      <header className="pagina-cabecera">
        <div>
          <h1>Plantillas</h1>
          <p>Plantillas de mensaje de WhatsApp. Meta las revisa antes de poder usarlas para iniciar conversación.</p>
        </div>
        <div className="pagina-acciones">
          <button type="button" className="boton-tenue" onClick={sincronizar} disabled={sincronizando}>
            {sincronizando ? "Sincronizando…" : "Sincronizar con Meta"}
          </button>
          <Link to="/plantillas/nueva" className="boton-guardar">
            Nueva plantilla
          </Link>
        </div>
      </header>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {!plantillas && !error && <Cargador />}

      {plantillas && plantillas.length === 0 && (
        <div className="marcador">
          <strong>Todavía no hay plantillas</strong>
          <span>Da de alta la primera desde "Nueva plantilla".</span>
        </div>
      )}

      {plantillas && plantillas.length > 0 && (
        <div className="tabla-envoltura">
          <table className="tabla">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Idioma</th>
                <th>Categoría</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {plantillas.map((p) => (
                <tr key={p.id}>
                  <td>{p.nombre_tecnico}</td>
                  <td>{p.idioma}</td>
                  <td>{ETIQUETA_CATEGORIA[p.categoria]}</td>
                  <td>
                    <span className={`pastilla pastilla-${PASTILLA_ESTADO[p.estado]}`}>{ETIQUETA_ESTADO[p.estado]}</span>
                    {p.estado === "rechazada" && p.motivo_rechazo && (
                      <p className="campo-ayuda">{p.motivo_rechazo}</p>
                    )}
                  </td>
                  <td>
                    <div className="celda-acciones">
                      {(p.estado === "borrador" || p.estado === "rechazada") && (
                        <>
                          <Link to={`/plantillas/${p.id}/editar`} className="boton-tenue">
                            Editar
                          </Link>
                          <button
                            type="button"
                            className="boton-tenue"
                            onClick={() => enviarARevision(p)}
                            disabled={enviandoId === p.id}
                          >
                            {enviandoId === p.id ? "Enviando…" : "Enviar a revisión"}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="boton-tenue boton-peligro"
                        onClick={() => setPorEliminar(p)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ModalConfirmar
        abierto={porEliminar !== null}
        titulo="Eliminar plantilla"
        mensaje={`¿Eliminar «${porEliminar?.nombre_tecnico}»? Si ya se envió a Meta, también se borra allá.`}
        textoConfirmar="Eliminar"
        peligro
        enviando={eliminando}
        onConfirmar={eliminar}
        onCancelar={() => setPorEliminar(null)}
      />
    </div>
  );
}
