import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { correoValido } from "../auth/validaciones";
import { usePortal } from "../portal/PortalProvider";
import { supabase } from "../lib/supabase";
import LayoutAuth from "../componentes/LayoutAuth";
import CampoTexto from "../componentes/CampoTexto";
import BotonGoogle from "../componentes/BotonGoogle";
import Alerta from "../componentes/Alerta";
import { IconoCorreo, IconoCandado, IconoFlecha } from "../componentes/Iconos";

export default function Login() {
  const { entrar, entrarConGoogle, salir } = useAuth();
  const { portal } = usePortal();
  const navigate = useNavigate();
  const location = useLocation();
  const destino = (location.state as { destino?: string } | null)?.destino ?? "/";

  const [correo, setCorreo] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  /**
   * Cada portal tiene sus propios usuarios. Entrar por el subdominio
   * equivocado no debe dar acceso, aunque la contraseña sea correcta.
   *
   * Esto es la puerta visible; el aislamiento real lo hacen las políticas
   * RLS, que solo devuelven las filas de la sucursal del usuario.
   */
  async function perteneceAlPortal(): Promise<boolean> {
    if (!portal) return true; // dominio raíz: administradores de plataforma

    const { data } = await supabase.auth.getUser();
    if (!data.user) return false;

    const { data: perfil } = await supabase
      .from("usuarios")
      .select("sucursal_id, activo")
      .eq("id", data.user.id)
      .maybeSingle();

    return Boolean(perfil?.activo) && perfil?.sucursal_id === portal.id;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!correoValido(correo)) {
      setError("Escribe un correo válido.");
      return;
    }

    setEnviando(true);
    const { error } = await entrar(correo, password);

    if (error) {
      setEnviando(false);
      setError(error);
      return;
    }

    if (!(await perteneceAlPortal())) {
      await salir();
      setEnviando(false);
      setError("Esta cuenta no tiene acceso a este portal.");
      return;
    }

    setEnviando(false);
    navigate(destino, { replace: true });
  }

  async function onGoogle() {
    setError(null);
    const { error } = await entrarConGoogle();
    if (error) setError(error);
  }

  // Sucursal desactivada: no se ofrece ninguna forma de entrar
  if (portal && !portal.activa) {
    return (
      <LayoutAuth
        titulo={<>Acceso <span className="acento">cerrado</span></>}
        aviso={
          <Alerta tipo="info">
            {portal.mensajeCerrado?.trim() ||
              "Este portal está temporalmente fuera de servicio. Comunícate con Sistemas."}
          </Alerta>
        }
      >
        <p className="centrado">{portal.nombre}</p>
      </LayoutAuth>
    );
  }

  // Solo el dominio raíz (sin sucursal) es el panel de administración de
  // plataforma; cada sucursal entra a su propio sistema de garantías.
  const titulo = portal ? (
    <>Bienvenido a <span className="acento">Garantías Extendidas</span></>
  ) : (
    <>Bienvenido al <span className="acento">Panel de administración</span></>
  );
  const subtitulo = portal
    ? "Ingresa tus credenciales para gestionar las garantías de tu sucursal."
    : "Ingresa tus credenciales maestras para gestionar el sistema.";

  return (
    <LayoutAuth
      titulo={titulo}
      subtitulo={subtitulo}
      aviso={error && <Alerta tipo="error">{error}</Alerta>}
    >
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

        <CampoTexto
          etiqueta="Contraseña"
          tipo="password"
          valor={password}
          onChange={setPassword}
          placeholder="••••••••"
          autoComplete="current-password"
          icono={<IconoCandado />}
          accesorio={
            <Link to="/olvide-contrasena" className="enlace-sutil">
              ¿Olvidaste tu contraseña?
            </Link>
          }
        />

        <button type="submit" className="boton-principal" disabled={enviando}>
          {enviando ? "Entrando…" : "Acceder al Portal"}
          {!enviando && <IconoFlecha />}
        </button>
      </form>

      {(!portal || portal.loginGoogle) && (
        <>
          <div className="separador"><span>O también puedes</span></div>
          <BotonGoogle onClick={onGoogle} deshabilitado={enviando} />
        </>
      )}
    </LayoutAuth>
  );
}
