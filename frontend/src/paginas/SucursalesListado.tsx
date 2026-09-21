import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Interruptor from "../componentes/Interruptor";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";

type Sucursal = {
  id: string;
  subdominio: string;
  nombre: string;
  color: string;
  logo_url: string | null;
  activa: boolean;
  login_google: boolean;
  creado_en: string;
};

type Diagnostico = {
  host: string;
  dns: { resuelve: boolean };
  https: { responde: boolean };
  listo: boolean;
};

const DOMINIO = "ge.autoinsights.mx";

export default function SucursalesListado() {
  const [sucursales, setSucursales] = useState<Sucursal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cambiando, setCambiando] = useState<string | null>(null);
  const [diagnosticos, setDiagnosticos] = useState<Record<string, Diagnostico | "cargando" | "error">>(
    {},
  );

  function cargar() {
    apiFetch<{ sucursales: Sucursal[] }>("/api/admin/sucursales")
      .then((r) => setSucursales(r.sucursales))
      .catch((e: Error) => setError(e.message));
  }

  useEffect(cargar, []);

  async function alternarActiva(sucursal: Sucursal) {
    const nuevoValor = !sucursal.activa;
    setCambiando(sucursal.id);

    // Optimista: se ve el cambio de inmediato, se revierte si falla
    setSucursales((previas) =>
      previas?.map((s) => (s.id === sucursal.id ? { ...s, activa: nuevoValor } : s)) ?? null,
    );

    try {
      await apiFetch(`/api/admin/sucursales/${sucursal.id}/activa`, {
        method: "PATCH",
        body: JSON.stringify({ activa: nuevoValor }),
      });
    } catch (err) {
      setSucursales((previas) =>
        previas?.map((s) => (s.id === sucursal.id ? { ...s, activa: sucursal.activa } : s)) ?? null,
      );
      setError(err instanceof Error ? err.message : "No se pudo actualizar la sucursal.");
    } finally {
      setCambiando(null);
    }
  }

  async function verificarDNS(sucursal: Sucursal) {
    setDiagnosticos((previos) => ({ ...previos, [sucursal.id]: "cargando" }));
    try {
      const resultado = await apiFetch<Diagnostico>(
        `/api/admin/sucursales/${sucursal.subdominio}/diagnostico`,
      );
      setDiagnosticos((previos) => ({ ...previos, [sucursal.id]: resultado }));
    } catch {
      setDiagnosticos((previos) => ({ ...previos, [sucursal.id]: "error" }));
    }
  }

  return (
    <div className="pagina-formulario">
      <nav className="migas" aria-label="Ruta">
        <span>Sucursales</span>
        <span aria-hidden="true">/</span>
        <span>Listado</span>
      </nav>

      <header className="pagina-cabecera">
        <div>
          <h1>Sucursales</h1>
          <p>Portales dados de alta, cada uno con su propio subdominio y usuarios.</p>
        </div>
        <div className="pagina-acciones">
          <Link to="/sucursales/nueva" className="boton-guardar">
            Nueva sucursal
          </Link>
        </div>
      </header>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {!sucursales && !error && <Cargador />}

      {sucursales && sucursales.length === 0 && (
        <div className="marcador">
          <strong>Todavía no hay sucursales</strong>
          <span>Da de alta la primera desde "Nueva sucursal".</span>
        </div>
      )}

      {sucursales && sucursales.length > 0 && (
        <div className="tabla-envoltura">
          <table className="tabla">
            <thead>
              <tr>
                <th>Sucursal</th>
                <th>Portal</th>
                <th>Color</th>
                <th>Google</th>
                <th>Estado</th>
                <th>Verificar</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sucursales.map((s) => {
                const diag = diagnosticos[s.id];
                return (
                  <tr key={s.id} className={s.activa ? undefined : "fila-inactiva"}>
                    <td>
                      <div className="celda-sucursal">
                        <span className="miniatura-logo">
                          {s.logo_url ? (
                            <img src={s.logo_url} alt="" />
                          ) : (
                            <span className="miniatura-logo-hueco" style={{ background: s.color }} />
                          )}
                        </span>
                        <span>{s.nombre}</span>
                      </div>
                    </td>
                    <td>
                      <a
                        href={`https://${s.subdominio}.${DOMINIO}`}
                        target="_blank"
                        rel="noreferrer"
                        className="enlace-portal"
                      >
                        {s.subdominio}.{DOMINIO}
                      </a>
                    </td>
                    <td>
                      <span className="color-punto" style={{ background: s.color }} />
                      <code className="color-codigo">{s.color.toUpperCase()}</code>
                    </td>
                    <td>{s.login_google ? "Sí" : "No"}</td>
                    <td>
                      <div className="celda-estado">
                        <Interruptor
                          etiqueta={s.activa ? "Activa" : "Inactiva"}
                          activo={s.activa}
                          onChange={() => alternarActiva(s)}
                        />
                      </div>
                    </td>
                    <td>
                      {!diag && (
                        <button
                          type="button"
                          className="boton-tenue"
                          onClick={() => verificarDNS(s)}
                          disabled={cambiando === s.id}
                        >
                          Verificar
                        </button>
                      )}
                      {diag === "cargando" && <span className="campo-pista">Consultando…</span>}
                      {diag === "error" && <span className="pastilla pastilla-mal">Sin respuesta</span>}
                      {diag && diag !== "cargando" && diag !== "error" && (
                        <span className={diag.listo ? "pastilla pastilla-bien" : "pastilla pastilla-mal"}>
                          {diag.listo
                            ? "Portal activo"
                            : !diag.dns.resuelve
                              ? "DNS pendiente"
                              : "HTTPS pendiente"}
                        </span>
                      )}
                    </td>
                    <td>
                      <Link to={`/sucursales/${s.id}/editar`} className="boton-tenue">
                        Editar
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
