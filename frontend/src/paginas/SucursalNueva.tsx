import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import Interruptor from "../componentes/Interruptor";
import CampoArchivo from "../componentes/CampoArchivo";
import Alerta from "../componentes/Alerta";
import { useImagen } from "../lib/useImagen";
import { subirImagen } from "../lib/subirImagen";
import { apiFetch } from "../lib/api";

type SucursalCreada = { id: string; nombre: string; subdominio: string; url: string };

const FORMA_SUBDOMINIO = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/;

export default function SucursalNueva() {
  const [activa, setActiva] = useState(true);
  const [loginGoogle, setLoginGoogle] = useState(true);
  const [color, setColor] = useState("#493f91");
  const [nombre, setNombre] = useState("");
  const [subdominio, setSubdominio] = useState("");
  const [mensajeCerrado, setMensajeCerrado] = useState("");

  const logo = useImagen();
  const logoPanel = useImagen();
  const imagenAcceso = useImagen();

  const [enviando, setEnviando] = useState(false);
  const [paso, setPaso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creada, setCreada] = useState<SucursalCreada | null>(null);

  function limpiar() {
    setNombre("");
    setSubdominio("");
    setMensajeCerrado("");
    setColor("#493f91");
    setActiva(true);
    setLoginGoogle(true);
    logo.cambiar(null);
    logoPanel.cambiar(null);
    imagenAcceso.cambiar(null);
    setCreada(null);
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (nombre.trim().length < 2) {
      setError("Escribe el nombre de la sucursal.");
      return;
    }
    if (!FORMA_SUBDOMINIO.test(subdominio)) {
      setError("El subdominio necesita entre 3 y 32 caracteres, y no puede empezar ni terminar con guion.");
      return;
    }

    setEnviando(true);

    try {
      // 1. Las imágenes primero: la sucursal se guarda ya con sus URLs
      setPaso("Subiendo imágenes…");

      const [logo_url, logo_panel_url, imagen_acceso_url] = await Promise.all([
        logo.archivo ? subirImagen(subdominio, "logo", logo.archivo) : null,
        logoPanel.archivo ? subirImagen(subdominio, "logo-panel", logoPanel.archivo) : null,
        imagenAcceso.archivo
          ? subirImagen(subdominio, "imagen-acceso", imagenAcceso.archivo)
          : null,
      ]);

      // 2. El alta
      setPaso("Creando el portal…");

      const respuesta = await apiFetch<SucursalCreada>("/api/admin/sucursales", {
        method: "POST",
        body: JSON.stringify({
          nombre: nombre.trim(),
          subdominio,
          color,
          activa,
          login_google: loginGoogle,
          mensaje_cerrado: mensajeCerrado.trim() || null,
          logo_url,
          logo_panel_url,
          imagen_acceso_url,
        }),
      });

      setCreada(respuesta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la sucursal.");
    } finally {
      setEnviando(false);
      setPaso(null);
    }
  }

  // ---------- Resultado ----------
  if (creada) {
    return (
      <div className="pagina-formulario">
        <nav className="migas" aria-label="Ruta">
          <Link to="/sucursales">Sucursales</Link>
          <span aria-hidden="true">/</span>
          <span>Nueva</span>
        </nav>

        <header className="pagina-cabecera">
          <h1>Sucursal creada</h1>
          <p>{creada.nombre} ya tiene su portal.</p>
        </header>

        <section className="seccion">
          <div className="seccion-info">
            <h2>Siguiente paso</h2>
            <p>El portal responde en cuanto el subdominio apunte a la aplicación.</p>
          </div>

          <div className="seccion-campos">
            <Alerta tipo="ok">
              Portal disponible en{" "}
              <a href={creada.url} target="_blank" rel="noreferrer">
                {creada.url}
              </a>
            </Alerta>

            <p className="campo-ayuda">
              Falta dar de alta a sus usuarios: cada cuenta pertenece a una sola sucursal
              y solo entra por su propio subdominio.
            </p>

            <div className="pagina-acciones">
              <button type="button" className="boton-guardar" onClick={limpiar}>
                Crear otra sucursal
              </button>
              <Link to="/sucursales" className="boton-secundario-claro">
                Ver listado
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="pagina-formulario">
      <nav className="migas" aria-label="Ruta">
        <Link to="/sucursales">Sucursales</Link>
        <span aria-hidden="true">/</span>
        <span>Nueva</span>
      </nav>

      <header className="pagina-cabecera">
        <h1>Nueva sucursal</h1>
        <p>Define cómo se identifica y qué ve su personal al entrar al panel.</p>
      </header>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {/* ---------- Datos generales ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Datos generales</h2>
          <p>Nombre visible y dirección con la que su gente entra al sistema.</p>
        </div>

        <div className="seccion-campos">
          <div className="pareja-campos">
            <div className="campo-formulario">
              <label htmlFor="nombre">
                Nombre <span className="obligatorio">*</span>
              </label>
              <input
                id="nombre"
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Nissan Hermosillo"
              />
            </div>

            <div className="campo-formulario">
              <label htmlFor="subdominio">
                Subdominio <span className="obligatorio">*</span>
              </label>
              <div className="campo-con-sufijo">
                <input
                  id="subdominio"
                  type="text"
                  value={subdominio}
                  onChange={(e) =>
                    setSubdominio(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                  }
                  placeholder="hermosillo"
                />
                <span className="campo-sufijo">.ge.autoinsights.mx</span>
              </div>
              <p className="campo-ayuda">
                Quedará como <code>{subdominio || "sucursal"}.ge.autoinsights.mx</code>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Acceso ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Acceso</h2>
          <p>Controla si la sucursal puede entrar y con qué métodos.</p>
        </div>

        <div className="seccion-campos">
          <div className="pareja-campos">
            <div className="opcion">
              <Interruptor etiqueta="Sucursal activa" activo={activa} onChange={setActiva} />
              <p className="campo-ayuda">Apagado, nadie de esta sucursal puede iniciar sesión.</p>
            </div>

            <div className="opcion">
              <Interruptor
                etiqueta="Entrar con Google"
                activo={loginGoogle}
                onChange={setLoginGoogle}
              />
              <p className="campo-ayuda">Además del acceso con correo y contraseña.</p>
            </div>
          </div>

          <div className="campo-formulario">
            <div className="campo-cabecera-fila">
              <label htmlFor="mensaje">Mensaje cuando el acceso está cerrado</label>
              <span className="campo-pista">Se muestra si la sucursal está inactiva</span>
            </div>
            <textarea
              id="mensaje"
              rows={2}
              value={mensajeCerrado}
              onChange={(e) => setMensajeCerrado(e.target.value)}
              placeholder="Ej. Acceso suspendido por mantenimiento. Comunícate con Sistemas."
            />
          </div>
        </div>
      </section>

      {/* ---------- Identidad ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Identidad visual</h2>
          <p>Imágenes y color con los que se personaliza el panel de la sucursal.</p>
        </div>

        <div className="seccion-campos">
          <div className="trio-campos">
            <CampoArchivo etiqueta="Logo" recomendado="PNG" imagen={logo} />
            <CampoArchivo etiqueta="Logo para panel" recomendado="Claro" imagen={logoPanel} />
            <CampoArchivo
              etiqueta="Imagen de acceso"
              recomendado="1920×1080"
              imagen={imagenAcceso}
            />
          </div>

          <div className="campo-formulario">
            <label htmlFor="color">Color del panel</label>
            <div className="campo-color">
              <input
                id="color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
              <input
                type="text"
                className="campo-color-texto"
                value={color.toUpperCase()}
                onChange={(e) => setColor(e.target.value)}
                spellCheck={false}
              />
              <div className="color-muestra" style={{ background: color }}>
                <span>Botones y acentos</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="barra-acciones">
        <p>
          {paso ?? (
            <>
              Los campos marcados con <span className="obligatorio">*</span> son obligatorios.
            </>
          )}
        </p>
        <div className="pagina-acciones">
          <Link to="/sucursales" className="boton-secundario-claro">
            Cancelar
          </Link>
          <button type="submit" className="boton-guardar" disabled={enviando}>
            {enviando ? "Guardando…" : "Guardar sucursal"}
          </button>
        </div>
      </footer>
    </form>
  );
}
