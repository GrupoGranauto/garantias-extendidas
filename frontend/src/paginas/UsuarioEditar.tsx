import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import CampoArchivo from "../componentes/CampoArchivo";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { useImagen } from "../lib/useImagen";
import { subirImagen } from "../lib/subirImagen";
import { apiFetch } from "../lib/api";

type Rol = "admin" | "asesor";

type UsuarioDetalle = {
  id: string;
  correo: string;
  nombre: string | null;
  puesto: string | null;
  foto_url: string | null;
  rol: Rol;
  sucursal_id: string | null;
  activo: boolean;
};

type Sucursal = { id: string; nombre: string };

const ROLES: { valor: Rol; etiqueta: string }[] = [
  { valor: "admin", etiqueta: "Administrador" },
  { valor: "asesor", etiqueta: "Asesor" },
];

export default function UsuarioEditar() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [cargando, setCargando] = useState(true);
  const [correo, setCorreo] = useState("");
  const [nombre, setNombre] = useState("");
  const [puesto, setPuesto] = useState("");
  const [rol, setRol] = useState<Rol>("asesor");
  const [sucursalId, setSucursalId] = useState("");
  const [urlFoto, setUrlFoto] = useState<string | null>(null);
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);

  const foto = useImagen(urlFoto);
  const esPlataforma = sucursalId === "";

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  useEffect(() => {
    if (!id) return;

    Promise.all([
      apiFetch<UsuarioDetalle>(`/api/admin/usuarios/${id}`),
      apiFetch<{ sucursales: Sucursal[] }>("/api/admin/sucursales"),
    ])
      .then(([u, s]) => {
        setCorreo(u.correo);
        setNombre(u.nombre ?? "");
        setPuesto(u.puesto ?? "");
        setRol(u.rol);
        setSucursalId(u.sucursal_id ?? "");
        setUrlFoto(u.foto_url);
        setSucursales(s.sucursales);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el usuario."))
      .finally(() => setCargando(false));
  }, [id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setGuardado(false);

    if (nombre.trim().length === 0) {
      setError("Escribe el nombre del usuario.");
      return;
    }

    setEnviando(true);

    try {
      let foto_url: string | null | undefined;
      if (foto.archivo) foto_url = await subirImagen(id!, "foto", foto.archivo, "usuarios");
      else if (foto.quitada) foto_url = null;

      await apiFetch(`/api/admin/usuarios/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          nombre: nombre.trim(),
          puesto: puesto.trim() || null,
          rol: esPlataforma ? "admin" : rol,
          sucursal_id: sucursalId || null,
          ...(foto_url !== undefined ? { foto_url } : {}),
        }),
      });

      setGuardado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el usuario.");
    } finally {
      setEnviando(false);
    }
  }

  if (cargando) {
    return (
      <div className="pagina-formulario">
        <Cargador />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="pagina-formulario">
      <nav className="migas" aria-label="Ruta">
        <Link to="/usuarios">Usuarios</Link>
        <span aria-hidden="true">/</span>
        <span>Editar</span>
      </nav>

      <header className="pagina-cabecera">
        <h1>Editar {nombre || correo}</h1>
        <p>{correo}</p>
      </header>

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

      {/* ---------- Datos ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Datos del usuario</h2>
          <p>El correo no se puede cambiar: es la identidad de la cuenta.</p>
        </div>

        <div className="seccion-campos">
          <CampoArchivo etiqueta="Foto de perfil" recomendado="Cuadrada" imagen={foto} />

          <div className="pareja-campos">
            <div className="campo-formulario">
              <label htmlFor="nombre">
                Nombre <span className="obligatorio">*</span>
              </label>
              <input id="nombre" type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} />
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

      <footer className="barra-acciones">
        <p>
          Los campos marcados con <span className="obligatorio">*</span> son obligatorios.
        </p>
        <div className="pagina-acciones">
          <button type="button" className="boton-secundario-claro" onClick={() => navigate("/usuarios")}>
            Cancelar
          </button>
          <button type="submit" className="boton-guardar" disabled={enviando}>
            {enviando ? "Guardando…" : "Guardar cambios"}
          </button>
        </div>
      </footer>
    </form>
  );
}
