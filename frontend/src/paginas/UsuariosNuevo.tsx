import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import Alerta from "../componentes/Alerta";
import { apiFetch } from "../lib/api";

type Rol = "admin" | "asesor";

type Sucursal = { id: string; nombre: string; subdominio: string };

type UsuarioCreado = { id: string; correo: string; rol: Rol; metodo: string };

const ROLES: { valor: Rol; etiqueta: string }[] = [
  { valor: "admin", etiqueta: "Administrador" },
  { valor: "asesor", etiqueta: "Asesor" },
];

export default function UsuariosNuevo() {
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);

  const [correo, setCorreo] = useState("");
  const [nombre, setNombre] = useState("");
  const [puesto, setPuesto] = useState("");
  const [rol, setRol] = useState<Rol>("asesor");
  const [sucursalId, setSucursalId] = useState("");
  const esPlataforma = sucursalId === "";
  const [definirPassword, setDefinirPassword] = useState(false);
  const [password, setPassword] = useState("");

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creado, setCreado] = useState<UsuarioCreado | null>(null);

  useEffect(() => {
    apiFetch<{ sucursales: Sucursal[] }>("/api/admin/sucursales")
      .then((r) => setSucursales(r.sucursales))
      .catch(() => {
        // El selector de sucursal queda vacío; no bloquea el resto del formulario
      });
  }, []);

  function limpiar() {
    setCorreo("");
    setNombre("");
    setPuesto("");
    setRol("asesor");
    setSucursalId("");
    setDefinirPassword(false);
    setPassword("");
    setCreado(null);
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!correo.trim()) {
      setError("Escribe el correo del usuario.");
      return;
    }
    if (definirPassword && password.length < 8) {
      setError("La contraseña necesita al menos 8 caracteres.");
      return;
    }

    setEnviando(true);

    try {
      const respuesta = await apiFetch<UsuarioCreado>("/api/admin/usuarios", {
        method: "POST",
        body: JSON.stringify({
          correo: correo.trim(),
          nombre: nombre.trim() || undefined,
          puesto: puesto.trim() || undefined,
          rol: esPlataforma ? "admin" : rol,
          sucursal_id: sucursalId || null,
          password: definirPassword ? password : undefined,
        }),
      });

      setCreado(respuesta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dar de alta al usuario.");
    } finally {
      setEnviando(false);
    }
  }

  // ---------- Confirmación tras crear ----------
  if (creado) {
    return (
      <div className="pagina-formulario">
        <nav className="migas" aria-label="Ruta">
          <Link to="/usuarios">Usuarios</Link>
          <span aria-hidden="true">/</span>
          <span>Nuevo</span>
        </nav>

        <header className="pagina-cabecera">
          <h1>Usuario dado de alta</h1>
          <p>{creado.correo} ya tiene acceso.</p>
        </header>

        <section className="seccion">
          <div className="seccion-info">
            <h2>Siguiente paso</h2>
          </div>

          <div className="seccion-campos">
            <Alerta tipo="ok">{creado.metodo}.</Alerta>

            <div className="pagina-acciones">
              <button type="button" className="boton-guardar" onClick={limpiar}>
                Dar de alta a otro
              </button>
              <Link to="/usuarios" className="boton-secundario-claro">
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
        <Link to="/usuarios">Usuarios</Link>
        <span aria-hidden="true">/</span>
        <span>Nuevo</span>
      </nav>

      <header className="pagina-cabecera">
        <h1>Nuevo usuario</h1>
        <p>No hay registro público: cada cuenta la da de alta un administrador.</p>
      </header>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {/* ---------- Datos ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Datos del usuario</h2>
          <p>Correo con el que va a iniciar sesión, y cómo se identifica dentro del sistema.</p>
        </div>

        <div className="seccion-campos">
          <div className="pareja-campos">
            <div className="campo-formulario">
              <label htmlFor="correo">
                Correo <span className="obligatorio">*</span>
              </label>
              <input
                id="correo"
                type="email"
                value={correo}
                onChange={(e) => setCorreo(e.target.value)}
                placeholder="nombre@empresa.com"
              />
            </div>

            <div className="campo-formulario">
              <label htmlFor="nombre">Nombre</label>
              <input
                id="nombre"
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Opcional"
              />
            </div>
          </div>

          <div className="campo-formulario">
            <label htmlFor="puesto">Puesto</label>
            <input
              id="puesto"
              type="text"
              value={puesto}
              onChange={(e) => setPuesto(e.target.value)}
              placeholder="Ej. Asesor de garantías"
            />
          </div>
        </div>
      </section>

      {/* ---------- Permisos ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Permisos</h2>
          <p>A qué sucursal pertenece y qué puede hacer dentro del sistema.</p>
        </div>

        <div className="seccion-campos">
          <div className={esPlataforma ? "pareja-campos" : "trio-campos"}>
            <div className="campo-formulario">
              <label htmlFor="sucursal">Sucursal</label>
              <select id="sucursal" value={sucursalId} onChange={(e) => setSucursalId(e.target.value)}>
                <option value="">— Administrador de plataforma —</option>
                {sucursales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nombre}
                  </option>
                ))}
              </select>
            </div>

            {!esPlataforma && (
              <div className="campo-formulario">
                <label htmlFor="rol">Rol</label>
                <select id="rol" value={rol} onChange={(e) => setRol(e.target.value as Rol)}>
                  {ROLES.map((r) => (
                    <option key={r.valor} value={r.valor}>
                      {r.etiqueta}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {esPlataforma && (
            <p className="campo-ayuda">
              Sin sucursal entra por el dominio raíz y ve todo: el rol no se elige, siempre es{" "}
              <strong>Administrador</strong>.
            </p>
          )}
        </div>
      </section>

      {/* ---------- Acceso ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Acceso</h2>
          <p>Puedes definirle una contraseña tú mismo, o dejar que la elija desde un correo de invitación.</p>
        </div>

        <div className="seccion-campos">
          <div className="pareja-campos">
            <label className="opcion-radio">
              <input
                type="radio"
                name="metodo-acceso"
                checked={!definirPassword}
                onChange={() => setDefinirPassword(false)}
              />
              <span>
                <strong>Enviar invitación por correo</strong>
                <span className="campo-ayuda">El usuario define su propia contraseña al aceptarla.</span>
              </span>
            </label>

            <label className="opcion-radio">
              <input
                type="radio"
                name="metodo-acceso"
                checked={definirPassword}
                onChange={() => setDefinirPassword(true)}
              />
              <span>
                <strong>Definir contraseña ahora</strong>
                <span className="campo-ayuda">Queda lista para entrar de inmediato.</span>
              </span>
            </label>
          </div>

          {definirPassword && (
            <div className="campo-formulario">
              <label htmlFor="password">
                Contraseña <span className="obligatorio">*</span>
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                autoComplete="new-password"
              />
            </div>
          )}
        </div>
      </section>

      <footer className="barra-acciones">
        <p>
          Los campos marcados con <span className="obligatorio">*</span> son obligatorios.
        </p>
        <div className="pagina-acciones">
          <Link to="/usuarios" className="boton-secundario-claro">
            Cancelar
          </Link>
          <button type="submit" className="boton-guardar" disabled={enviando}>
            {enviando ? "Guardando…" : "Dar de alta"}
          </button>
        </div>
      </footer>
    </form>
  );
}
