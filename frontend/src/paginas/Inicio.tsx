import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { apiFetch } from "../lib/api";
import Alerta from "../componentes/Alerta";

type Estado = { ok: boolean; detail: string };
type Conexiones = { supabase: Estado; bigquery: Estado };

export default function Inicio() {
  const { usuario } = useAuth();
  const [conexiones, setConexiones] = useState<Conexiones | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Conexiones>("/api/health/conexiones")
      .then(setConexiones)
      .catch((e: Error) => setError(e.message));
  }, []);

  const nombre = usuario?.user_metadata?.full_name ?? usuario?.email?.split("@")[0] ?? "";

  return (
    <>
      <div className="panel-encabezado">
        <h1>Inicio</h1>
        <p>Bienvenido{nombre ? `, ${nombre}` : ""}. Aquí verás el resumen de garantías extendidas.</p>
      </div>

      <div className="rejilla">
        <section className="ficha">
          <h2>Estado de conexiones</h2>
          <p className="ficha-nota">Servicios de los que depende el panel.</p>

          {error && <Alerta tipo="error">Backend sin responder: {error}</Alerta>}
          {!conexiones && !error && <p className="ficha-nota">Consultando…</p>}

          {conexiones && (
            <ul className="estado-lista">
              {(Object.entries(conexiones) as [string, Estado][]).map(([nombre, estado]) => (
                <li key={nombre}>
                  <span className={estado.ok ? "estado-punto ok" : "estado-punto falla"} />
                  <strong>{nombre}</strong>
                  <span className="detalle">{estado.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ficha">
          <h2>Pólizas del periodo</h2>
          <p className="ficha-nota">Pendiente de conectar con la base.</p>
          <p className="ficha-nota">Aquí van los totales de GN y GI del mes en curso.</p>
        </section>

        <section className="ficha">
          <h2>Cancelaciones</h2>
          <p className="ficha-nota">Pendiente de conectar con la base.</p>
          <p className="ficha-nota">Aquí va el conteo de cancelaciones y VIN con cargo duplicado.</p>
        </section>
      </div>
    </>
  );
}
