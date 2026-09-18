import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { correoValido } from "../auth/validaciones";
import LayoutAuth from "../componentes/LayoutAuth";
import CampoTexto from "../componentes/CampoTexto";
import Alerta from "../componentes/Alerta";
import { IconoCorreo, IconoFlecha } from "../componentes/Iconos";

export default function OlvideContrasena() {
  const { enviarCorreoRecuperacion } = useAuth();

  const [correo, setCorreo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!correoValido(correo)) {
      setError("Escribe un correo válido.");
      return;
    }

    setEnviando(true);
    const { error } = await enviarCorreoRecuperacion(correo);
    setEnviando(false);

    if (error) setError(error);
    else setEnviado(true);
  }

  return (
    <LayoutAuth
      titulo={<>Recuperar <span className="acento">contraseña</span></>}
      subtitulo="Te enviamos un enlace para crear una nueva."
      aviso={
        error ? (
          <Alerta tipo="error">{error}</Alerta>
        ) : (
          enviado && (
            /* Mismo mensaje exista o no la cuenta: no revelamos qué correos están dados de alta */
            <Alerta tipo="ok">
              Si {correo} tiene una cuenta, el enlace ya va en camino. Revisa también la
              carpeta de spam.
            </Alerta>
          )
        )
      }
    >
      {enviado ? (
        <>
          <p className="auth-nota">
            <Link to="/login">Volver a iniciar sesión</Link>
          </p>
        </>
      ) : (
        <>
          <form onSubmit={onSubmit} noValidate>
            <CampoTexto
              etiqueta="Correo Electrónico"
              tipo="email"
              valor={correo}
              onChange={setCorreo}
              placeholder="ejemplo@corporativo.com"
              autoComplete="email"
              icono={<IconoCorreo />}
            />

            <button type="submit" className="boton-principal" disabled={enviando}>
              {enviando ? "Enviando…" : "Enviar enlace"}
              {!enviando && <IconoFlecha />}
            </button>
          </form>

          <p className="auth-nota">
            <Link to="/login">Volver</Link>
          </p>
        </>
      )}
    </LayoutAuth>
  );
}
