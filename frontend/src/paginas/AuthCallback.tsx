import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { esperarSesion } from "../lib/esperarSesion";
import { traducirError } from "../auth/errores";
import { usePortal } from "../portal/PortalProvider";
import { supabase } from "../lib/supabase";
import Alerta from "../componentes/Alerta";
import LayoutAuth from "../componentes/LayoutAuth";

/** Aterrizaje del OAuth de Google y de la confirmación de correo. */
export default function AuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const { portal } = usePortal();

  useEffect(() => {
    let vivo = true;

    const errorUrl = params.get("error_description") ?? params.get("error");
    if (errorUrl) {
      setError(traducirError(errorUrl));
      return;
    }

    // El canje del ?code= lo hace supabase-js; aquí solo esperamos el resultado
    esperarSesion().then(async (sesion) => {
      if (!vivo || !sesion) {
        if (vivo) setError("No se pudo completar el inicio de sesión. Intenta de nuevo.");
        return;
      }

      // Mismo chequeo que el login con contraseña: cada portal es de sus
      // propios usuarios, entrar por el subdominio equivocado no da acceso
      // aunque Google sí haya autenticado a la persona.
      const { data: perfil } = await supabase
        .from("usuarios")
        .select("sucursal_id, activo")
        .eq("id", sesion.user.id)
        .maybeSingle();

      const pertenece = Boolean(perfil?.activo) && perfil?.sucursal_id === (portal?.id ?? null);

      if (!vivo) return;

      if (!pertenece) {
        await supabase.auth.signOut();
        setError("Esta cuenta no tiene acceso a este portal.");
        return;
      }

      navigate("/", { replace: true });
    });

    return () => {
      vivo = false;
    };
  }, [params, navigate, portal]);

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
