import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoChevron, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Tipo = "texto" | "entero" | "fecha" | "fecha_hora" | "booleano";
type Operador = "igual" | "distinto" | "contiene" | "vacio" | "no_vacio" | "mayor" | "menor";
type Condicion = { campo: string; operador: Operador; valor: string };
type Accion = "tarea" | "llamada" | "whatsapp";
type Unidad = "horas" | "dias";

type Servidor = {
  id: string;
  campana: string;
  nombre: string;
  activa: boolean;
  desde: "primer_envio" | "ultimo_envio";
  espera_horas: number;
  accion: Accion;
  condiciones: Condicion[];
  titulo: string | null;
  descripcion: string | null;
  vence_horas: number | null;
  hora: string | null;
  plantilla_id: string | null;
  vigencia_horas: number;
  resumen: { pendientes: number; hechos: number; omitidos: number; simulados: number };
};
type Respuesta = {
  seguimientos: Servidor[];
  campanas: string[];
  plantillas: { id: string; nombre: string }[];
  etapas: string[];
  campos: { nombre: string; etiqueta: string; tipo: Tipo }[];
  estados_contacto: string[];
  recientes: { id: string; seguimiento: string; campana: string; accion: Accion; estado: string; motivo: string | null; simulada: boolean; programado_para: string; actualizado_en: string; cliente: string | null }[];
};

/** Lo que se edita en pantalla: las esperas se escriben en horas o días. */
type Fila = {
  clave: string;
  id?: string;
  campana: string;
  nombre: string;
  activa: boolean;
  desde: "primer_envio" | "ultimo_envio";
  esperaValor: number;
  esperaUnidad: Unidad;
  accion: Accion;
  condiciones: Condicion[];
  titulo: string;
  descripcion: string;
  venceValor: string; // "" = sin fecha
  venceUnidad: Unidad;
  hora: string;
  plantilla_id: string;
  vigencia_horas: number;
  resumen?: Servidor["resumen"];
};

const OPERADORES: Record<Tipo, Operador[]> = {
  texto: ["igual", "distinto", "contiene", "vacio", "no_vacio"],
  entero: ["igual", "distinto", "mayor", "menor", "vacio", "no_vacio"],
  fecha: ["igual", "mayor", "menor", "vacio", "no_vacio"],
  fecha_hora: ["igual", "mayor", "menor", "vacio", "no_vacio"],
  booleano: ["igual"],
};
const ETIQUETA_OPERADOR = (o: Operador, tipo: Tipo): string => {
  if (tipo === "booleano") return "es";
  const esFecha = tipo === "fecha" || tipo === "fecha_hora";
  return { igual: "es igual a", distinto: "es distinto de", contiene: "contiene", vacio: "está vacío", no_vacio: "no está vacío", mayor: esFecha ? "es posterior a" : "es mayor que", menor: esFecha ? "es anterior a" : "es menor que" }[o];
};

const ESTADOS: Record<string, string> = { pendiente: "Pendiente", hecho: "Hecho", omitido: "Omitido", simulado: "Simulado" };
const MOTIVOS: Record<string, string> = {
  ya_no_aplica: "La oportunidad ya no está abierta",
  ya_tiene_ge: "Ya compró garantía",
  excluido_etapa: "El vehículo ya no puede contratar (fuera de meses o km)",
  baja: "Pidió la baja",
  ahora_no: "Respondió «Ahora no» (vuelve en la siguiente campaña)",
  no_cumple_condicion: "No cumplió las condiciones",
  atrasado: "Le tocaba hace más de 24 h (seguimiento apagado o motor detenido)",
};
const ACCIONES: Record<Accion, string> = { tarea: "Crear una tarea", llamada: "Agendar una llamada", whatsapp: "Enviar otro WhatsApp" };

let contador = 0;
const clave = () => `s${++contador}`;

const aHoras = (valor: number, unidad: Unidad) => valor * (unidad === "dias" ? 24 : 1);
function aUnidad(horas: number): { valor: number; unidad: Unidad } {
  return horas > 0 && horas % 24 === 0 ? { valor: horas / 24, unidad: "dias" } : { valor: horas, unidad: "horas" };
}

function deServidor(s: Servidor): Fila {
  const espera = aUnidad(s.espera_horas);
  const vence = s.vence_horas === null ? null : aUnidad(s.vence_horas);
  return {
    clave: s.id,
    id: s.id,
    campana: s.campana,
    nombre: s.nombre,
    activa: s.activa,
    desde: s.desde,
    esperaValor: espera.valor,
    esperaUnidad: espera.unidad,
    accion: s.accion,
    condiciones: s.condiciones,
    titulo: s.titulo ?? "",
    descripcion: s.descripcion ?? "",
    venceValor: vence ? String(vence.valor) : s.vence_horas === 0 ? "0" : "",
    venceUnidad: vence?.unidad ?? "horas",
    hora: s.hora ?? "",
    plantilla_id: s.plantilla_id ?? "",
    vigencia_horas: s.vigencia_horas,
    resumen: s.resumen,
  };
}

const nuevo = (campana: string): Fila => ({
  clave: clave(),
  campana,
  nombre: "Llamar si no respondió",
  activa: false,
  desde: "primer_envio",
  esperaValor: 2,
  esperaUnidad: "dias",
  accion: "llamada",
  condiciones: [{ campo: "respondio_whatsapp", operador: "igual", valor: "false" }],
  titulo: "Llamar a {cliente}",
  descripcion: "",
  venceValor: "0",
  venceUnidad: "horas",
  hora: "10:00",
  plantilla_id: "",
  vigencia_horas: 48,
});

const entero = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v) || 0)));

/**
 * Seguimientos: qué pasa después del primer mensaje automático de una campaña. Pasadas las horas o días que elijas, y solo si
 * se cumplen las condiciones, se crea una tarea, se agenda una llamada o se manda otro WhatsApp. La etapa del embudo es la
 * «etiqueta» del cliente y también se puede usar como condición, igual que cualquier otra columna.
 */
export default function Seguimientos() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const base = `/api/admin/sucursales/${sucursalId}/crm/seguimientos`;

  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [sucio, setSucio] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  const cargar = useCallback(() => {
    apiFetch<Respuesta>(base)
      .then((r) => {
        setDatos(r);
        setFilas(r.seguimientos.map(deServidor));
        setSel((s) => s ?? r.campanas[0] ?? null);
        setSucio(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar."));
  }, [base]);
  useEffect(cargar, [cargar]);

  function cambiar(fn: (f: Fila[]) => Fila[]) {
    setFilas(fn);
    setSucio(true);
    setAviso(null);
  }
  const editar = (k: string, cambios: Partial<Fila>) => cambiar((f) => f.map((x) => (x.clave === k ? { ...x, ...cambios } : x)));

  function mover(k: string, d: -1 | 1) {
    cambiar((f) => {
      const propios = f.filter((x) => x.campana === sel);
      const i = propios.findIndex((x) => x.clave === k);
      const j = i + d;
      if (i < 0 || j < 0 || j >= propios.length) return f;
      const orden = [...propios];
      [orden[i], orden[j]] = [orden[j], orden[i]];
      let n = 0;
      return f.map((x) => (x.campana === sel ? orden[n++] : x));
    });
  }

  async function guardar() {
    setGuardando(true);
    setAviso(null);
    try {
      await apiFetch(base, {
        method: "PUT",
        body: JSON.stringify({
          seguimientos: filas.map((f) => ({
            id: f.id,
            campana: f.campana,
            nombre: f.nombre.trim(),
            activa: f.activa,
            desde: f.desde,
            espera_horas: aHoras(f.esperaValor, f.esperaUnidad),
            accion: f.accion,
            condiciones: f.condiciones,
            titulo: f.accion === "whatsapp" ? null : f.titulo.trim() || null,
            descripcion: f.accion === "whatsapp" ? null : f.descripcion.trim() || null,
            vence_horas: f.accion === "whatsapp" || f.venceValor === "" ? null : aHoras(Number(f.venceValor) || 0, f.venceUnidad),
            hora: f.accion === "whatsapp" || f.hora === "" ? null : f.hora,
            plantilla_id: f.accion === "whatsapp" && f.plantilla_id ? f.plantilla_id : null,
            vigencia_horas: f.vigencia_horas,
          })),
        }),
      });
      setAviso({ tipo: "ok", texto: "Seguimientos guardados." });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!datos) return <Cargador />;

  const propios = filas.filter((f) => f.campana === sel);
  const etiquetaCampo = (n: string) => datos.campos.find((c) => c.nombre === n)?.etiqueta ?? n;
  const tipoCampo = (n: string): Tipo => datos.campos.find((c) => c.nombre === n)?.tipo ?? "texto";

  function entradaValor(f: Fila, i: number) {
    const c = f.condiciones[i];
    const tipo = tipoCampo(c.campo);
    const poner = (valor: string) => editar(f.clave, { condiciones: f.condiciones.map((x, j) => (j === i ? { ...x, valor } : x)) });
    if (c.operador === "vacio" || c.operador === "no_vacio") return null;
    if (tipo === "booleano") {
      return (
        <select className="auto-input" value={c.valor} onChange={(e) => poner(e.target.value)} aria-label="Valor">
          <option value="true">Sí</option>
          <option value="false">No</option>
        </select>
      );
    }
    if (c.campo === "etapa_embudo" || c.campo === "estado_contacto") {
      const opciones = c.campo === "etapa_embudo" ? datos!.etapas : datos!.estados_contacto;
      return (
        <select className="auto-input" value={c.valor} onChange={(e) => poner(e.target.value)} aria-label="Valor">
          <option value="">Elige…</option>
          {opciones.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    if (tipo === "fecha" || tipo === "fecha_hora") return <input type="date" className="auto-input" value={c.valor} onChange={(e) => poner(e.target.value)} aria-label="Valor" />;
    if (tipo === "entero") return <input type="number" className="auto-input" value={c.valor} onChange={(e) => poner(e.target.value)} aria-label="Valor" />;
    return <input type="text" className="auto-input" maxLength={200} value={c.valor} onChange={(e) => poner(e.target.value)} aria-label="Valor" />;
  }

  function cambiarCampo(f: Fila, i: number, campo: string) {
    const tipo = tipoCampo(campo);
    const operador = OPERADORES[tipo][0];
    editar(f.clave, { condiciones: f.condiciones.map((x, j) => (j === i ? { campo, operador, valor: tipo === "booleano" ? "true" : "" } : x)) });
  }

  function frase(f: Fila): string {
    const unidad = f.esperaUnidad === "dias" ? (f.esperaValor === 1 ? "día" : "días") : f.esperaValor === 1 ? "hora" : "horas";
    const cuando = `${f.esperaValor} ${unidad} después del ${f.desde === "primer_envio" ? "primer" : "último"} mensaje de ${f.campana}`;
    const si = f.condiciones.length === 0 ? "a todos" : "a quien cumpla las condiciones";
    const que = f.accion === "whatsapp" ? "manda otro WhatsApp" : f.accion === "llamada" ? "agenda una llamada" : "crea una tarea";
    return `${cuando}: ${que} ${si}.`;
  }

  return (
    <>
      <p className="pestana-descripcion">
        Define qué pasa después del primer mensaje automático de cada campaña: pasadas unas horas o días, y solo si se cumplen tus condiciones, se crea una tarea para el
        ejecutivo, se agenda una llamada o se manda otro WhatsApp. Las condiciones pueden usar cualquier columna de la base; la etapa del embudo es la «etiqueta» del
        cliente.
      </p>
      <Alerta tipo="info">
        Los seguimientos nacen apagados. Solo se disparan con mensajes que ya salieron: si el primer mensaje fue una simulación, el seguimiento también se simula (se anota lo que
        habría hecho, sin crear tareas ni mandar nada). Los WhatsApp de seguimiento respetan el horario, el tope diario y las bajas de la campaña.
      </Alerta>
      {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

      <section className="rep-tarjeta">
        <div className="inicio-cab">
          <h3>Seguimientos por campaña</h3>
          <button type="button" className="boton-guardar" disabled={!sucio || guardando} onClick={guardar}>
            {guardando ? "Guardando…" : "Guardar seguimientos"}
          </button>
        </div>

        <label className="auto-campo ciclo-columna">
          <span>Campaña</span>
          <select className="auto-input" value={sel ?? ""} onChange={(e) => setSel(e.target.value)}>
            {datos.campanas.map((c) => (
              <option key={c} value={c}>
                {c} ({filas.filter((f) => f.campana === c).length})
              </option>
            ))}
          </select>
        </label>

        {propios.map((f, idx) => (
          <div key={f.clave} className={`camp-def seg${f.activa ? "" : " camp-def-apagada"}`}>
            <div className="camp-def-cab">
              <span className="camp-def-orden">{idx + 1}</span>
              <input type="text" className="auto-input" maxLength={80} placeholder="Nombre del seguimiento" value={f.nombre} onChange={(e) => editar(f.clave, { nombre: e.target.value })} aria-label="Nombre del seguimiento" />
              <label className="camp-def-activa">
                <input type="checkbox" checked={f.activa} onChange={(e) => editar(f.clave, { activa: e.target.checked })} /> Activo
              </label>
              <button type="button" className="auto-quitar" aria-label="Subir" disabled={idx === 0} onClick={() => mover(f.clave, -1)}>
                <IconoChevron className="icono-inline icono-arriba" />
              </button>
              <button type="button" className="auto-quitar" aria-label="Bajar" disabled={idx === propios.length - 1} onClick={() => mover(f.clave, 1)}>
                <IconoChevron className="icono-inline" />
              </button>
              <button type="button" className="auto-quitar" aria-label={`Quitar ${f.nombre || "seguimiento"}`} onClick={() => cambiar((x) => x.filter((y) => y.clave !== f.clave))}>
                <IconoXMarca className="icono-inline" />
              </button>
            </div>

            <div className="seg-bloque">
              <h4>Cuándo</h4>
              <div className="camp-def-campos">
                <label className="auto-campo">
                  <span>Esperar</span>
                  <input type="number" min={0} className="auto-input" value={f.esperaValor} onChange={(e) => editar(f.clave, { esperaValor: entero(e.target.value, 0, 8760) })} />
                </label>
                <label className="auto-campo">
                  <span>Unidad</span>
                  <select className="auto-input" value={f.esperaUnidad} onChange={(e) => editar(f.clave, { esperaUnidad: e.target.value as Unidad })}>
                    <option value="horas">Horas</option>
                    <option value="dias">Días</option>
                  </select>
                </label>
                <label className="auto-campo">
                  <span>Contar desde</span>
                  <select className="auto-input" value={f.desde} onChange={(e) => editar(f.clave, { desde: e.target.value as Fila["desde"] })}>
                    <option value="primer_envio">El primer mensaje de la campaña</option>
                    <option value="ultimo_envio">El último mensaje de la campaña</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="seg-bloque">
              <h4>Solo si…</h4>
              {f.condiciones.length === 0 && <p className="rep-ayuda">Sin condiciones: aplica a todos los que recibieron el mensaje.</p>}
              {f.condiciones.map((c, i) => {
                const tipo = tipoCampo(c.campo);
                return (
                  <div key={i} className="seg-condicion">
                    <select className="auto-input" value={c.campo} onChange={(e) => cambiarCampo(f, i, e.target.value)} aria-label="Columna">
                      {datos.campos.map((k) => (
                        <option key={k.nombre} value={k.nombre}>
                          {k.etiqueta}
                        </option>
                      ))}
                      {!datos.campos.some((k) => k.nombre === c.campo) && <option value={c.campo}>{c.campo} (ya no existe)</option>}
                    </select>
                    <select
                      className="auto-input"
                      value={c.operador}
                      onChange={(e) => editar(f.clave, { condiciones: f.condiciones.map((x, j) => (j === i ? { ...x, operador: e.target.value as Operador } : x)) })}
                      aria-label="Operador"
                    >
                      {OPERADORES[tipo].map((o) => (
                        <option key={o} value={o}>
                          {ETIQUETA_OPERADOR(o, tipo)}
                        </option>
                      ))}
                    </select>
                    {entradaValor(f, i)}
                    <button type="button" className="auto-quitar" aria-label="Quitar condición" onClick={() => editar(f.clave, { condiciones: f.condiciones.filter((_, j) => j !== i) })}>
                      <IconoXMarca className="icono-inline" />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="boton-secundario-claro auto-agregar"
                disabled={f.condiciones.length >= 8}
                onClick={() => editar(f.clave, { condiciones: [...f.condiciones, { campo: "etapa_embudo", operador: "igual", valor: "" }] })}
              >
                Agregar condición
              </button>
            </div>

            <div className="seg-bloque">
              <h4>Qué hace</h4>
              <div className="camp-def-campos">
                <label className="auto-campo">
                  <span>Acción</span>
                  <select className="auto-input" value={f.accion} onChange={(e) => editar(f.clave, { accion: e.target.value as Accion, venceValor: e.target.value === "llamada" && f.venceValor === "" ? "0" : f.venceValor })}>
                    {(Object.keys(ACCIONES) as Accion[]).map((a) => (
                      <option key={a} value={a}>
                        {ACCIONES[a]}
                      </option>
                    ))}
                  </select>
                </label>
                {f.accion === "whatsapp" ? (
                  <>
                    <label className="auto-campo">
                      <span>Plantilla</span>
                      <select className="auto-input" value={f.plantilla_id} onChange={(e) => editar(f.clave, { plantilla_id: e.target.value })}>
                        <option value="">Elige una plantilla</option>
                        {datos.plantillas.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.nombre}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="auto-campo">
                      <span>Si no puede salir en (horas), se omite</span>
                      <input type="number" min={1} max={1440} className="auto-input" value={f.vigencia_horas} onChange={(e) => editar(f.clave, { vigencia_horas: entero(e.target.value, 1, 1440) })} />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="auto-campo seg-ancho">
                      <span>{f.accion === "llamada" ? "Título de la llamada" : "Título de la tarea"}</span>
                      <input type="text" className="auto-input" maxLength={160} value={f.titulo} onChange={(e) => editar(f.clave, { titulo: e.target.value })} placeholder="Puedes usar {cliente}, {vin}, {campana}, {agencia}, {ejecutivo}" />
                    </label>
                    <label className="auto-campo seg-ancho">
                      <span>Descripción (opcional)</span>
                      <input type="text" className="auto-input" maxLength={1000} value={f.descripcion} onChange={(e) => editar(f.clave, { descripcion: e.target.value })} />
                    </label>
                    <label className="auto-campo">
                      <span>{f.accion === "llamada" ? "Agendar para dentro de" : "Vence dentro de"}</span>
                      <input
                        type="number"
                        min={0}
                        className="auto-input"
                        value={f.venceValor}
                        placeholder={f.accion === "llamada" ? "" : "Sin fecha"}
                        onChange={(e) => editar(f.clave, { venceValor: e.target.value === "" ? "" : String(entero(e.target.value, 0, 8760)) })}
                      />
                    </label>
                    <label className="auto-campo">
                      <span>Unidad</span>
                      <select className="auto-input" value={f.venceUnidad} onChange={(e) => editar(f.clave, { venceUnidad: e.target.value as Unidad })}>
                        <option value="horas">Horas</option>
                        <option value="dias">Días</option>
                      </select>
                    </label>
                    <label className="auto-campo">
                      <span>A las (opcional, hora de Hermosillo)</span>
                      <input type="time" className="auto-input" value={f.hora} onChange={(e) => editar(f.clave, { hora: e.target.value })} />
                    </label>
                  </>
                )}
              </div>
            </div>

            <p className="rep-ayuda">
              <strong>Resumen:</strong> {frase(f)}
              {f.resumen && (f.resumen.pendientes + f.resumen.hechos + f.resumen.omitidos + f.resumen.simulados > 0) && (
                <>
                  {" "}
                  Hasta ahora: {f.resumen.pendientes} pendientes, {f.resumen.hechos} hechos, {f.resumen.simulados} simulados y {f.resumen.omitidos} omitidos.
                </>
              )}
            </p>
          </div>
        ))}
        {propios.length === 0 && <p className="auto-vacio">Esta campaña todavía no tiene seguimientos.</p>}

        <div className="camp-def-agregar">
          <button type="button" className="boton-secundario-claro auto-agregar" disabled={!sel || filas.length >= 40} onClick={() => sel && cambiar((f) => [...f, nuevo(sel)])}>
            Agregar seguimiento a {sel ?? "la campaña"}
          </button>
        </div>
      </section>

      <section className="rep-tarjeta">
        <h3>Lo último que pasó</h3>
        {datos.recientes.length === 0 ? (
          <p className="auto-vacio">Todavía no se ha ejecutado ningún seguimiento.</p>
        ) : (
          <div className="tabla-envoltura">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Seguimiento</th>
                  <th>Acción</th>
                  <th>Estado</th>
                  <th>Motivo</th>
                  <th>Cuándo</th>
                </tr>
              </thead>
              <tbody>
                {datos.recientes.map((r) => (
                  <tr key={r.id}>
                    <td>{r.cliente ?? "—"}</td>
                    <td>
                      {r.seguimiento} <small>({r.campana})</small>
                    </td>
                    <td>{ACCIONES[r.accion]}</td>
                    <td>{ESTADOS[r.estado] ?? r.estado}</td>
                    <td>{r.motivo ? (MOTIVOS[r.motivo] ?? r.motivo) : "—"}</td>
                    <td>{new Date(r.estado === "pendiente" ? r.programado_para : r.actualizado_en).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
