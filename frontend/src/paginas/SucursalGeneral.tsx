import { useState, type FormEvent } from "react";
import Interruptor from "../componentes/Interruptor";
import CampoArchivo from "../componentes/CampoArchivo";
import Alerta from "../componentes/Alerta";
import { useImagen, type Imagen } from "../lib/useImagen";
import { subirImagen } from "../lib/subirImagen";
import { apiFetch } from "../lib/api";
import { useSucursal } from "./SucursalEditLayout";

/** Sube el archivo solo si hay uno nuevo, o marca null si se quitó. undefined = no tocar. */
async function valorImagen(
  imagen: Imagen,
  subdominio: string,
  campo: string,
): Promise<string | null | undefined> {
  if (imagen.archivo) return subirImagen(subdominio, campo, imagen.archivo);
  if (imagen.quitada) return null;
  return undefined;
}

export default function SucursalGeneral() {
  const { sucursal, recargar } = useSucursal();

  const [nombre, setNombre] = useState(sucursal.nombre);
  const [color, setColor] = useState(sucursal.color);
  const [loginGoogle, setLoginGoogle] = useState(sucursal.login_google);
  const [mensajeCerrado, setMensajeCerrado] = useState(sucursal.mensaje_cerrado ?? "");

  const logo = useImagen(sucursal.logo_url);
  const logoPanel = useImagen(sucursal.logo_panel_url);
  const imagenAcceso = useImagen(sucursal.imagen_acceso_url);

  const [enviando, setEnviando] = useState(false);
  const [paso, setPaso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setGuardado(false);

    if (nombre.trim().length < 2) {
      setError("Escribe el nombre de la sucursal.");
      return;
    }

    setEnviando(true);

    try {
      setPaso("Subiendo imágenes…");

      const [logo_url, logo_panel_url, imagen_acceso_url] = await Promise.all([
        valorImagen(logo, sucursal.subdominio, "logo"),
        valorImagen(logoPanel, sucursal.subdominio, "logo-panel"),
        valorImagen(imagenAcceso, sucursal.subdominio, "imagen-acceso"),
      ]);

      setPaso("Guardando cambios…");

      const cuerpo: Record<string, unknown> = {
        nombre: nombre.trim(),
        color,
        login_google: loginGoogle,
        mensaje_cerrado: mensajeCerrado.trim() || null,
      };
      // Solo se manda lo que el usuario tocó: el resto se queda como estaba
      if (logo_url !== undefined) cuerpo.logo_url = logo_url;
      if (logo_panel_url !== undefined) cuerpo.logo_panel_url = logo_panel_url;
      if (imagen_acceso_url !== undefined) cuerpo.imagen_acceso_url = imagen_acceso_url;

      await apiFetch(`/api/admin/sucursales/${sucursal.id}`, {
        method: "PATCH",
        body: JSON.stringify(cuerpo),
      });

      recargar();
      setGuardado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la sucursal.");
    } finally {
      setEnviando(false);
      setPaso(null);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}
      {guardado && (
        <div className="aviso-formulario">
          <Alerta tipo="ok">Cambios guardados.</Alerta>
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
              <label htmlFor="subdominio">Subdominio</label>
              <div className="campo-con-sufijo">
                <input id="subdominio" type="text" value={sucursal.subdominio} disabled />
                <span className="campo-sufijo">.ge.autoinsights.mx</span>
              </div>
              <p className="campo-ayuda">
                No se puede cambiar: ya tiene DNS y certificado emitidos para este nombre.
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
              <Interruptor
                etiqueta="Entrar con Google"
                activo={loginGoogle}
                onChange={setLoginGoogle}
              />
              <p className="campo-ayuda">Además del acceso con correo y contraseña.</p>
            </div>
          </div>

          <p className="campo-ayuda">
            El estado (activa/inactiva) se cambia desde el listado, con el interruptor de esa fila.
          </p>

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
          <button type="submit" className="boton-guardar" disabled={enviando}>
            {enviando ? "Guardando…" : "Guardar cambios"}
          </button>
        </div>
      </footer>
    </form>
  );
}
