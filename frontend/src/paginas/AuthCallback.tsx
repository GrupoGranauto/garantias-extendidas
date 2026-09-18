import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { esperarSesion } from "../lib/esperarSesion";
import { traducirError } from "../auth/errores";
import Alerta from "../componentes/Alerta";
import LayoutAuth from "../componentes/LayoutAuth";

/** Aterrizaje del OAuth de Google y de la confirmación de correo. */
export default function AuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;

    const errorUrl = params.get("error_description") ?? params.get("error");
    if (errorUrl) {
      setError(traducirError(errorUrl));
      return;
    }

    // El canje del ?code= lo hace supabase-js; aquí solo esperamos el resultado
    esperarSesion().then((sesion) => {
      if (!vivo) return;
      if (sesion) navigate("/", { replace: true });
      else setError("No se pudo completar el inicio de sesión. Intenta de nuevo.");
    });

    return () => {
      vivo = false;
    };
  }, [params, navigate]);

  if (error) {
    return (
      <LayoutAuth
        titulo={<>No se pudo <span className="acento">entrar</span></>}
        aviso={<Alerta tipo="error">{error}</Alerta>}
      >
        <button className="boton-principal" onClick={() => navigate("/login", { replace: true })}>
          Volver al inicio de sesión
        </button>
      </LayoutAuth>
    );
  }

  return (
    <LayoutAuth titulo="Completando inicio de sesión…">
      <p className="centrado">Un momento.</p>
    </LayoutAuth>
  );
}
