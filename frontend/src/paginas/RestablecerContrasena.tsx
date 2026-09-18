import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { esperarSesion } from "../lib/esperarSesion";
import { useAuth } from "../auth/AuthProvider";
import { revisarPassword, MIN_PASSWORD } from "../auth/validaciones";
import LayoutAuth from "../componentes/LayoutAuth";
import CampoTexto from "../componentes/CampoTexto";
import Alerta from "../componentes/Alerta";
import { IconoCandado, IconoFlecha } from "../componentes/Iconos";

type Estado = "verificando" | "listo" | "invalido" | "hecho";

export default function RestablecerContrasena() {
  const { cambiarPassword, session } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [estado, setEstado] = useState<Estado>("verificando");
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // El correo de recuperación llega con ?code=. Lo canjea supabase-js solo
  // (detectSessionInUrl); canjearlo aquí otra vez rompe el verifier de PKCE.
  useEffect(() => {
    let vivo = true;

    const errorUrl = params.get("error_description") ?? params.get("error");
    if (errorUrl) {
      setEstado("invalido");
      return;
    }

    esperarSesion().then((sesion) => {
      if (!vivo) return;
      setEstado(sesion ? "listo" : "invalido");
    });

    return () => {
      vivo = false;
    };
  }, [params]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const problema = revisarPassword(password);
    if (problema) {
      setError(problema);
      return;
    }
    if (password !== confirmacion) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setEnviando(true);
    const { error } = await cambiarPassword(password);
    setEnviando(false);

    if (error) setError(error);
    else setEstado("hecho");
  }

  if (estado === "verificando") {
    return (
      <LayoutAuth titulo="Verificando enlace…">
        <p className="centrado">Un momento.</p>
      </LayoutAuth>
    );
  }

  if (estado === "invalido") {
    return (
      <LayoutAuth
        titulo={<>Enlace <span className="acento">no válido</span></>}
        aviso={
          <Alerta tipo="error">
            El enlace expiró o ya se usó. Pide uno nuevo desde “¿Olvidaste tu contraseña?”.
          </Alerta>
        }
      >
        <button className="boton-principal" onClick={() => navigate("/olvide-contrasena")}>
          Pedir otro enlace
          <IconoFlecha />
        </button>
      </LayoutAuth>
    );
  }

  if (estado === "hecho") {
    return (
      <LayoutAuth
        titulo={<>Contraseña <span className="acento">actualizada</span></>}
        aviso={<Alerta tipo="ok">Ya puedes usar tu nueva contraseña.</Alerta>}
      >
        <button
          className="boton-principal"
          onClick={() => navigate(session ? "/" : "/login", { replace: true })}
        >
          Continuar
          <IconoFlecha />
        </button>
      </LayoutAuth>
    );
  }

  return (
    <LayoutAuth
      titulo={<>Nueva <span className="acento">contraseña</span></>}
      subtitulo="Escríbela dos veces para confirmar."
      aviso={error && <Alerta tipo="error">{error}</Alerta>}
    >
      <form onSubmit={onSubmit} noValidate>
        <CampoTexto
          etiqueta="Nueva contraseña"
          tipo="password"
          valor={password}
          onChange={setPassword}
          placeholder="••••••••"
          autoComplete="new-password"
          icono={<IconoCandado />}
          ayuda={`Mínimo ${MIN_PASSWORD} caracteres, con mayúscula, minúscula y número.`}
        />
        <CampoTexto
          etiqueta="Repetir contraseña"
          tipo="password"
          valor={confirmacion}
          onChange={setConfirmacion}
          placeholder="••••••••"
          autoComplete="new-password"
          icono={<IconoCandado />}
        />

        <button type="submit" className="boton-principal" disabled={enviando}>
          {enviando ? "Guardando…" : "Guardar contraseña"}
          {!enviando && <IconoFlecha />}
        </button>
      </form>
    </LayoutAuth>
  );
}
