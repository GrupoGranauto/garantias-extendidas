import { useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Tipo = "texto" | "entero" | "decimal" | "booleano" | "fecha" | "fecha_hora" | "uuid";

type CampoServidor = {
  nombre_tecnico: string;
  nombre_visible: string;
  tipo: Tipo;
  posicion: number;
};

type Respuesta =
  | { configurado: false }
  | {
      configurado: true;
      nombre_visible: string;
      campos: CampoServidor[];
      filas: Record<string, unknown>[];
      total: number;
      pagina: number;
      limite: number;
    };

function formatearValor(valor: unknown, tipo: Tipo): string {
  if (valor === null || valor === undefined) return "—";
  if (tipo === "booleano") return valor ? "Sí" : "No";
  if (tipo === "fecha") return new Date(String(valor)).toLocaleDateString();
  if (tipo === "fecha_hora") return new Date(String(valor)).toLocaleString();
  return String(valor);
}

/** Los datos de la entidad que la sucursal dio de alta (o que le dieron de alta a ella). Solo lectura. */
export default function BaseDatos() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;

  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    apiFetch<Respuesta>(`/api/admin/sucursales/${sucursalId}/entidad/registros?pagina=${pagina}&limite=50`)
      .then(setDatos)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la información."));
  }, [sucursalId, pagina]);

  return (
    <div className="pagina-formulario">
      <header className="pagina-cabecera">
        <div>
          <h1>Base de datos</h1>
          <p>Los datos que se registraron para tu sucursal. Solo lectura.</p>
        </div>
      </header>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {!datos && !error && <Cargador />}

      {datos && !datos.configurado && (
        <div className="marcador">
          <strong>Todavía no hay una base de datos para tu sucursal</strong>
          <span>Cuando el administrador de la plataforma la dé de alta, aparecerá aquí.</span>
        </div>
      )}

      {datos?.configurado && datos.filas.length === 0 && (
        <div className="marcador">
          <strong>{datos.nombre_visible}</strong>
          <span>Todavía no hay registros.</span>
        </div>
      )}

      {datos?.configurado && datos.filas.length > 0 && (
        <>
          <div className="tabla-envoltura">
            <table className="tabla">
              <thead>
                <tr>
                  {datos.campos.map((c) => (
                    <th key={c.nombre_tecnico}>{c.nombre_visible}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {datos.filas.map((fila) => (
                  <tr key={String(fila.id)}>
                    {datos.campos.map((c) => (
                      <td key={c.nombre_tecnico}>{formatearValor(fila[c.nombre_tecnico], c.tipo)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <footer className="barra-acciones">
            <p>
              {(datos.pagina - 1) * datos.limite + 1}–{Math.min(datos.pagina * datos.limite, datos.total)} de {datos.total}
            </p>
            <div className="pagina-acciones">
              <button
                type="button"
                className="boton-secundario-claro"
                disabled={pagina <= 1}
                onClick={() => setPagina((p) => p - 1)}
              >
                Anterior
              </button>
              <button
                type="button"
                className="boton-secundario-claro"
                disabled={datos.pagina * datos.limite >= datos.total}
                onClick={() => setPagina((p) => p + 1)}
              >
                Siguiente
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
