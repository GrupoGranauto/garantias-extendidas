import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Interruptor from "../componentes/Interruptor";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import ModalConfirmar from "../componentes/ModalConfirmar";
import { apiFetch } from "../lib/api";

type Rol = "admin" | "asesor";

type Usuario = {
  id: string;
  correo: string;
  nombre: string | null;
  puesto: string | null;
  foto_url: string | null;
  rol: Rol;
  sucursal_id: string | null;
  activo: boolean;
  creado_en: string;
};

type Sucursal = { id: string; nombre: string };

const ETIQUETA_ROL: Record<Rol, string> = {
  admin: "Administrador",
  asesor: "Asesor",
};

export default function UsuariosListado() {
  const [usuarios, setUsuarios] = useState<Usuario[] | null>(null);
  const [sucursales, setSucursales] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [cambiando, setCambiando] = useState<string | null>(null);
  const [porEliminar, setPorEliminar] = useState<Usuario | null>(null);
  const [eliminando, setEliminando] = useState(false);

  useEffect(() => {
    apiFetch<{ usuarios: Usuario[] }>("/api/admin/usuarios")
      .then((r) => setUsuarios(r.usuarios))
      .catch((e: Error) => setError(e.message));

    apiFetch<{ sucursales: Sucursal[] }>("/api/admin/sucursales")
      .then((r) => setSucursales(Object.fromEntries(r.sucursales.map((s) => [s.id, s.nombre]))))
      .catch(() => {
        // El nombre de sucursal queda como "—"; no bloquea el listado de usuarios
      });
  }, []);

  async function alternarActivo(usuario: Usuario) {
    const nuevoValor = !usuario.activo;
    setCambiando(usuario.id);

    setUsuarios((previos) =>
      previos?.map((u) => (u.id === usuario.id ? { ...u, activo: nuevoValor } : u)) ?? null,
    );

    try {
      await apiFetch(`/api/admin/usuarios/${usuario.id}/activo`, {
        method: "PATCH",
        body: JSON.stringify({ activo: nuevoValor }),
      });
    } catch (err) {
      setUsuarios((previos) =>
        previos?.map((u) => (u.id === usuario.id ? { ...u, activo: usuario.activo } : u)) ?? null,
      );
      setError(err instanceof Error ? err.message : "No se pudo actualizar el usuario.");
    } finally {
      setCambiando(null);
    }
  }

  async function eliminar() {
    if (!porEliminar) return;

    setEliminando(true);
    try {
      await apiFetch(`/api/admin/usuarios/${porEliminar.id}`, { method: "DELETE" });
      setUsuarios((previos) => previos?.filter((u) => u.id !== porEliminar.id) ?? null);
      setPorEliminar(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el usuario.");
      setPorEliminar(null);
    } finally {
      setEliminando(false);
    }
  }

  return (
    <div className="pagina-formulario">
      <nav className="migas" aria-label="Ruta">
        <span>Usuarios</span>
        <span aria-hidden="true">/</span>
        <span>Listado</span>
      </nav>

      <header className="pagina-cabecera">
        <div>
          <h1>Usuarios</h1>
          <p>Cuentas con acceso al panel. No hay registro público: cada una la da de alta un administrador.</p>
        </div>
        <div className="pagina-acciones">
          <Link to="/usuarios/nuevo" className="boton-guardar">
            Nuevo usuario
          </Link>
        </div>
      </header>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}

      {!usuarios && !error && <Cargador />}

      {usuarios && usuarios.length === 0 && (
        <div className="marcador">
          <strong>Todavía no hay usuarios</strong>
          <span>Da de alta al primero desde "Nuevo usuario".</span>
        </div>
      )}

      {usuarios && usuarios.length > 0 && (
        <div className="tabla-envoltura">
          <table className="tabla">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Correo</th>
                <th>Puesto</th>
                <th>Rol</th>
                <th>Sucursal</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => (
                <tr key={u.id} className={u.activo ? undefined : "fila-inactiva"}>
                  <td>
                    <div className="celda-sucursal">
                      <span className="miniatura-logo redonda">
                        {u.foto_url ? (
                          <img src={u.foto_url} alt="" />
                        ) : (
                          <span className="miniatura-logo-hueco" style={{ background: "var(--gris-200)" }} />
                        )}
                      </span>
                      <span>{u.nombre ?? "Sin nombre"}</span>
                    </div>
                  </td>
                  <td>{u.correo}</td>
                  <td>{u.puesto ?? "—"}</td>
                  <td>{ETIQUETA_ROL[u.rol]}</td>
                  <td>{u.sucursal_id ? (sucursales[u.sucursal_id] ?? "—") : "Plataforma"}</td>
                  <td>
                    <div className="celda-estado">
                      <Interruptor
                        etiqueta={u.activo ? "Activo" : "Inactivo"}
                        activo={u.activo}
                        onChange={() => alternarActivo(u)}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="celda-acciones">
                      <Link to={`/usuarios/${u.id}/editar`} className="boton-tenue">
                        Editar
                      </Link>
                      <button
                        type="button"
                        className="boton-tenue boton-peligro"
                        onClick={() => setPorEliminar(u)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ModalConfirmar
        abierto={porEliminar !== null}
        titulo="Eliminar usuario"
        mensaje={`¿Eliminar a «${porEliminar?.nombre ?? porEliminar?.correo}»? Se borra por completo, no se puede deshacer.`}
        textoConfirmar="Eliminar"
        peligro
        enviando={eliminando}
        onConfirmar={eliminar}
        onCancelar={() => setPorEliminar(null)}
      />
    </div>
  );
}
