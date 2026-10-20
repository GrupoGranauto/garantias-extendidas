import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { IconoChevron, IconoXMarca } from "../componentes/Iconos";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Unidad = "horas" | "dias";
type Accion = "tarea" | "whatsapp";
type Servidor = {
  id: string;
  nombre: string;
  activa: boolean;
  estado: string;
  espera_horas: number;
  titulo: string;
  descripcion: string | null;
  vence_horas: number | null;
  accion: Accion;
  plantilla_id: string | null;
  telefonos_prueba: string[];
  resumen: { pendientes: number; hechos: number; omitidos: number };
};
type Respuesta = {
  reglas: Servidor[];
  estados: { valor: string; etiqueta: string }[];
  cobertura_automatica: boolean;
  contratos_en_certificado: number;
  recientes: { id: string; regla: string; estado: string; motivo: string | null; programado_para: string; actualizado_en: string; cliente: string | null }[];
  /** Plantillas de servicio aprobadas que puede mandar una regla. */
  plantillas: { id: string; nombre: string }[];
};
type Fila = {
  clave: string;
  id?: string;
  nombre: string;
  activa: boolean;
  estado: string;
  esperaValor: number;
  esperaUnidad: Unidad;
  titulo: string;
  descripcion: string;
  venceValor: string; // "" = sin fecha
  venceUnidad: Unidad;
  accion: Accion;
  plantillaId: string | null;
  prueba: string;
  resumen?: Servidor["resumen"];
};

const ESTADOS: Record<string, string> = { pendiente: "Pendiente", hecho: "Hecho", omitido: "Omitido" };
const MOTIVOS: Record<string, string> = {
  cambio_de_estado: "El contrato ya cambió de estado",
  ya_no_aplica: "La oportunidad ya no aplica",
  // A quien no se le puede buscar no se le crea la tarea (mismas claves que el freno de envíos).
  baja: "La persona pidió no ser contactada",
  no_contactable: "Está marcada como no contactable",
  supresion_numero_equivocado: "Su teléfono está marcado como número equivocado",
  supresion_ya_no_tiene_auto: "Ya no tiene el vehículo",
  supresion_flotilla: "Su vehículo es de flotilla",
  supresion_uso_no_elegible: "El uso de su vehículo no es elegible",
  supresion_fuera_km_tiempo: "Su vehículo ya pasó el kilometraje o el tiempo de la garantía",
  // Reglas que mandan WhatsApp.
  modo_prueba: "Modo prueba: no es uno de los teléfonos de prueba",
  vencido: "Ya no estaba vigente cuando podía salir",
  sin_plantilla: "La regla no tiene plantilla",
  plantilla_no_disponible: "La plantilla o WhatsApp no estaban disponibles",
  pagado: "Ya tiene un pago registrado",
  fuera_de_regla: "La plantilla no es para su situación",
  contrato_cancelado: "Su contrato está cancelado",
  sin_telefono: "No tiene teléfono válido",
  sin_celular: "Su número no es celular",
  variable_vacia: "Le falta un dato que usa la plantilla",
  no_encontrada: "La oportunidad ya no está en la base",
};

let contador = 0;
const clave = () => `r${++contador}`;
const aHoras = (valor: number, unidad: Unidad) => valor * (unidad === "dias" ? 24 : 1);
const aUnidad = (horas: number): { valor: number; unidad: Unidad } => (horas > 0 && horas % 24 === 0 ? { valor: horas / 24, unidad: "dias" } : { valor: horas, unidad: "horas" });
const entero = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v) || 0)));

function deServidor(r: Servidor): Fila {
  const espera = aUnidad(r.espera_horas);
  const vence = r.vence_horas === null ? null : aUnidad(r.vence_horas);
  return {
    clave: r.id,
    id: r.id,
    nombre: r.nombre,
    activa: r.activa,
    estado: r.estado,
    esperaValor: espera.valor,
    esperaUnidad: espera.unidad,
    titulo: r.titulo,
    descripcion: r.descripcion ?? "",
    venceValor: vence ? String(vence.valor) : r.vence_horas === 0 ? "0" : "",
    venceUnidad: vence?.unidad ?? "horas",
    accion: r.accion,
    plantillaId: r.plantilla_id,
    prueba: r.telefonos_prueba.join(", "),
    resumen: r.resumen,
  };
}

const nueva = (estado: string): Fila => ({
  clave: clave(),
  nombre: "Nueva regla",
  activa: false,
  estado,
  esperaValor: 24,
  esperaUnidad: "horas",
  titulo: "Dar seguimiento a {cliente}",
  descripcion: "",
  venceValor: "24",
  venceUnidad: "horas",
  accion: "tarea",
  plantillaId: null,
  prueba: "",
});

/**
 * Pago y cierre automáticos: cuando un contrato lleva cierto tiempo en un estado (por ejemplo, la liga de pago que dura 24
 * horas) se crea sola una tarea para el ejecutivo o se le manda al cliente una plantilla de WhatsApp de servicio; y paso
 * automático a «Cobertura iniciada» cuando termina la garantía original.
 */
export default function ReglasContrato() {
  const { portal } = usePortal();
  const sucursalId = portal!.id;
  const base = `/api/admin/sucursales/${sucursalId}/crm/contrato-reglas`;

  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cobertura, setCobertura] = useState(true);
  const [sucio, setSucio] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  const cargar = useCallback(() => {
    apiFetch<Respuesta>(base)
      .then((r) => {
        setDatos(r);
        setFilas(r.reglas.map(deServidor));
        setCobertura(r.cobertura_automatica);
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
  function mover(i: number, d: -1 | 1) {
    cambiar((f) => {
      const j = i + d;
      if (j < 0 || j >= f.length) return f;
      const c = [...f];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  }

  async function guardar() {
    setGuardando(true);
    setAviso(null);
    try {
      await apiFetch(base, {
        method: "PUT",
        body: JSON.stringify({
          cobertura_automatica: cobertura,
          reglas: filas.map((f) => ({
            id: f.id,
            nombre: f.nombre.trim(),
            activa: f.activa,
            estado: f.estado,
            espera_horas: aHoras(f.esperaValor, f.esperaUnidad),
            titulo: f.accion === "whatsapp" ? "" : f.titulo.trim(),
            descripcion: f.accion === "whatsapp" ? null : f.descripcion.trim() || null,
            vence_horas: f.venceValor === "" ? null : aHoras(Number(f.venceValor) || 0, f.venceUnidad),
            accion: f.accion,
            plantilla_id: f.accion === "whatsapp" ? f.plantillaId : null,
            telefonos_prueba: f.accion === "whatsapp" ? f.prueba.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean) : [],
          })),
        }),
      });
      setAviso({ tipo: "ok", texto: "Guardado." });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!datos) return <Cargador />;

  const etiquetaEstado = (v: string) => datos.estados.find((e) => e.valor === v)?.etiqueta ?? v;
  const frase = (f: Fila) => {
    const unidad = f.esperaUnidad === "dias" ? (f.esperaValor === 1 ? "día" : "días") : f.esperaValor === 1 ? "hora" : "horas";
    const cuando = f.esperaValor === 0 ? `En cuanto el contrato entra a «${etiquetaEstado(f.estado)}»` : `Si el contrato lleva ${f.esperaValor} ${unidad} en «${etiquetaEstado(f.estado)}»`;
    if (f.accion === "tarea") return `${cuando}, se crea la tarea para el ejecutivo.`;
    const plantilla = datos.plantillas.find((p) => p.id === f.plantillaId)?.nombre;
    const prueba = f.prueba.trim() ? " Está en modo prueba: solo les llega a los teléfonos de prueba." : "";
    return `${cuando}, se le manda al cliente ${plantilla ? `«${plantilla}»` : "la plantilla elegida"}.${prueba}`;
  };

  return (
    <>
      <p className="pestana-descripcion">
        Para que el pago y el cierre no se queden a medias: cuando un contrato lleva cierto tiempo en un estado, se crea sola una tarea para el ejecutivo o se le manda al
        cliente una plantilla de WhatsApp. Por ejemplo, la liga de pago que llega por correo dura 24 horas: se le avisa al generarla, se le recuerda antes de que venza y se
        le dice si venció.
      </p>
      <Alerta tipo="info">
        Los mensajes son de servicio: pasan por el freno de siempre (baja, supresiones, contrato cancelado; los de cobro nunca a quien ya pagó), pero no esperan por el límite
        de un mensaje al día. Salen de {"08:00"} a {"20:00"}; lo que toque de noche sale a la apertura solo si sigue vigente. Si el contrato cambia de estado antes, no salen.
      </Alerta>
      {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

      <section className="rep-tarjeta">
        <div className="inicio-cab">
          <h3>Cobertura automática</h3>
          <button type="button" className="boton-guardar" disabled={!sucio || guardando} onClick={guardar}>
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
        <label className="camp-def-activa">
          <input type="checkbox" checked={cobertura} onChange={(e) => { setCobertura(e.target.checked); setSucio(true); setAviso(null); }} /> Pasar solos a «Cobertura iniciada» cuando termina la garantía original
        </label>
        <p className="rep-ayuda">
          La garantía original dura 36 meses desde la factura, y la extendida empieza al terminar. Con esto encendido, los contratos en «Certificado entregado» pasan solos a «Cobertura
          iniciada» ese día, y el cambio queda en el historial como automático. Hoy hay {datos.contratos_en_certificado.toLocaleString("es-MX")} contratos en «Certificado entregado».
        </p>
      </section>

      <section className="rep-tarjeta">
        <h3>Reglas por tiempo en un estado</h3>

        {filas.map((f, idx) => (
          <div key={f.clave} className={`camp-def seg${f.activa ? "" : " camp-def-apagada"}`}>
            <div className="camp-def-cab">
              <span className="camp-def-orden">{idx + 1}</span>
              <input type="text" className="auto-input" maxLength={80} placeholder="Nombre de la regla" value={f.nombre} onChange={(e) => editar(f.clave, { nombre: e.target.value })} aria-label="Nombre de la regla" />
              <label className="camp-def-activa">
                <input type="checkbox" checked={f.activa} onChange={(e) => editar(f.clave, { activa: e.target.checked })} /> Activa
              </label>
              <button type="button" className="auto-quitar" aria-label="Subir" disabled={idx === 0} onClick={() => mover(idx, -1)}>
                <IconoChevron className="icono-inline icono-arriba" />
              </button>
              <button type="button" className="auto-quitar" aria-label="Bajar" disabled={idx === filas.length - 1} onClick={() => mover(idx, 1)}>
                <IconoChevron className="icono-inline" />
              </button>
              <button type="button" className="auto-quitar" aria-label={`Quitar ${f.nombre || "regla"}`} onClick={() => cambiar((x) => x.filter((y) => y.clave !== f.clave))}>
                <IconoXMarca className="icono-inline" />
              </button>
            </div>

            <div className="seg-bloque">
              <h4>Cuándo</h4>
              <div className="camp-def-campos">
                <label className="auto-campo">
                  <span>El contrato lleva</span>
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
                  <span>En el estado</span>
                  <select className="auto-input" value={f.estado} onChange={(e) => editar(f.clave, { estado: e.target.value })}>
                    {datos.estados.map((e) => (
                      <option key={e.valor} value={e.valor}>
                        {e.etiqueta}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="seg-bloque">
              <h4>Qué hace</h4>
              <div className="camp-def-campos">
                <label className="auto-campo">
                  <span>Acción</span>
                  <select className="auto-input" value={f.accion} onChange={(e) => editar(f.clave, { accion: e.target.value as Accion })}>
                    <option value="tarea">Crear una tarea para el ejecutivo</option>
                    <option value="whatsapp">Mandar WhatsApp al cliente</option>
                  </select>
                </label>
              </div>
              {f.accion === "whatsapp" ? (
                <div className="camp-def-campos">
                  <label className="auto-campo seg-ancho">
                    <span>Plantilla</span>
                    <select className="auto-input" value={f.plantillaId ?? ""} onChange={(e) => editar(f.clave, { plantillaId: e.target.value || null })}>
                      <option value="">Elige una plantilla de servicio</option>
                      {f.plantillaId && !datos.plantillas.some((p) => p.id === f.plantillaId) && (
                        <option value={f.plantillaId} disabled>
                          La plantilla guardada ya no se puede usar
                        </option>
                      )}
                      {datos.plantillas.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nombre}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="auto-campo">
                    <span>Ya no sale si pasan</span>
                    <input type="number" min={1} className="auto-input" value={f.venceValor} onChange={(e) => editar(f.clave, { venceValor: e.target.value === "" ? "" : String(entero(e.target.value, 0, 8760)) })} />
                  </label>
                  <label className="auto-campo">
                    <span>Unidad</span>
                    <select className="auto-input" value={f.venceUnidad} onChange={(e) => editar(f.clave, { venceUnidad: e.target.value as Unidad })}>
                      <option value="horas">Horas</option>
                      <option value="dias">Días</option>
                    </select>
                  </label>
                  <label className="auto-campo seg-ancho">
                    <span>Solo para probar: teléfonos (10 dígitos, separados con coma)</span>
                    <input type="text" inputMode="numeric" className="auto-input" placeholder="Vacío = a todos los clientes" value={f.prueba} onChange={(e) => editar(f.clave, { prueba: e.target.value })} />
                  </label>
                </div>
              ) : (
              <div className="camp-def-campos">
                <label className="auto-campo seg-ancho">
                  <span>Título</span>
                  <input type="text" className="auto-input" maxLength={160} value={f.titulo} onChange={(e) => editar(f.clave, { titulo: e.target.value })} placeholder="Puedes usar {cliente}, {vin}, {campana}, {agencia}, {ejecutivo}" />
                </label>
                <label className="auto-campo seg-ancho">
                  <span>Descripción (opcional)</span>
                  <input type="text" className="auto-input" maxLength={1000} value={f.descripcion} onChange={(e) => editar(f.clave, { descripcion: e.target.value })} />
                </label>
                <label className="auto-campo">
                  <span>Vence dentro de</span>
                  <input type="number" min={0} className="auto-input" value={f.venceValor} placeholder="Sin fecha" onChange={(e) => editar(f.clave, { venceValor: e.target.value === "" ? "" : String(entero(e.target.value, 0, 8760)) })} />
                </label>
                <label className="auto-campo">
                  <span>Unidad</span>
                  <select className="auto-input" value={f.venceUnidad} onChange={(e) => editar(f.clave, { venceUnidad: e.target.value as Unidad })}>
                    <option value="horas">Horas</option>
                    <option value="dias">Días</option>
                  </select>
                </label>
              </div>
              )}
            </div>

            <p className="rep-ayuda">
              <strong>Resumen:</strong> {frase(f)}
              {f.resumen && f.resumen.pendientes + f.resumen.hechos + f.resumen.omitidos > 0 && (
                <>
                  {" "}
                  Hasta ahora: {f.resumen.pendientes} pendientes, {f.resumen.hechos} {f.accion === "whatsapp" ? "mandados" : "hechas"} y {f.resumen.omitidos}{" "}
                  {f.accion === "whatsapp" ? "omitidos" : "omitidas"}.
                </>
              )}
            </p>
          </div>
        ))}
        {filas.length === 0 && <p className="auto-vacio">Todavía no hay reglas. Agrega la primera.</p>}

        <div className="camp-def-agregar">
          <button type="button" className="boton-secundario-claro auto-agregar" disabled={filas.length >= 20} onClick={() => cambiar((f) => [...f, nueva(datos.estados[2]?.valor ?? "orden_pago")])}>
            Agregar regla
          </button>
        </div>
      </section>

      <section className="rep-tarjeta">
        <h3>Lo último que pasó</h3>
        {datos.recientes.length === 0 ? (
          <p className="auto-vacio">Todavía no se ha ejecutado ninguna regla.</p>
        ) : (
          <div className="tabla-envoltura">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Regla</th>
                  <th>Estado</th>
                  <th>Motivo</th>
                  <th>Cuándo</th>
                </tr>
              </thead>
              <tbody>
                {datos.recientes.map((r) => (
                  <tr key={r.id}>
                    <td>{r.cliente ?? "—"}</td>
                    <td>{r.regla}</td>
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
