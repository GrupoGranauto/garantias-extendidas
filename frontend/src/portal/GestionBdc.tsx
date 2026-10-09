import { useState } from "react";

/**
 * Campos de gestión del ejecutivo BDC (Notion: «Pipeline y campos del ejecutivo BDC»): seguimiento, ya tiene GE,
 * calificación, cotización y pago, cierre e indicadores calculados. Cada cambio se guarda solo y queda en el historial.
 */

export type OpcionCatalogo = { clave: string; etiqueta: string };
export type CatalogoGestion = "respuesta_titular" | "motivo_no_interes" | "donde_obtuvo_ge" | "origen_venta" | "clasificacion_respuesta";

export type Gestion = {
  valores: {
    respuesta_titular: string | null;
    proximo_contacto_en: string | null;
    motivo_no_interes: string | null;
    declara_ge: boolean;
    donde_obtuvo_ge: string | null;
    fecha_compra_ge: string | null;
    conserva_auto: boolean | null;
    monto_cotizado: number | null;
    link_enviado_en: string | null;
    fecha_pago: string | null;
    origen_venta: string | null;
    escalar_posventa: boolean;
    respuesta_por_clasificar: boolean;
    clasificacion_respuesta: string | null;
    no_contactar: boolean;
    no_contactar_canal: string | null;
    no_contactar_en: string | null;
  };
  calculados: {
    ge_validada: boolean | null;
    kilometraje: number | null;
    km_leido_en: string | null;
    periodo: number | null;
    plazo_meses: number | null;
    pagado: boolean | null;
    estado_calculado: string | null;
    ultimo_mensaje_estado: string | null;
    ultimo_mensaje_fallo: string | null;
    ultimo_mensaje_en: string | null;
    ultima_plantilla: string | null;
    intentos_llamada: number | null;
    intentos_whatsapp: number | null;
    ultimo_intento_en: string | null;
    ultimo_contacto_efectivo_en: string | null;
    dias_en_campana: number | null;
    dias_para_cierre: number | null;
  };
  catalogos: Record<CatalogoGestion, OpcionCatalogo[]>;
  llamada: { valor: string; texto: string }[];
};

/** Respuestas que piden agendar el próximo contacto. */
export const RESPUESTA_CON_PROXIMO = new Set(["LLAMAR_DESPUES", "LO_VA_A_PENSAR"]);

const CANALES_BAJA = [
  { valor: "llamada", texto: "Llamada" },
  { valor: "whatsapp", texto: "WhatsApp" },
  { valor: "correo", texto: "Correo" },
  { valor: "presencial", texto: "Presencial" },
  { valor: "sms", texto: "SMS" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO → valor de <input type="datetime-local"> en la hora local. */
export function aLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Hoy en Hermosillo, igual que el servidor (no la fecha del navegador). */
const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Hermosillo" });

/** Límite de los selectores de fecha y hora (evita años de 5 dígitos que el navegador acepta). */
export const FECHA_HORA_MAX = "2100-12-31T23:59";

/**
 * Valida el «próximo contacto» de un <input type="datetime-local">: devuelve el ISO o el error en español.
 * Sin valor devuelve null (quitarlo).
 */
export function proximoDesdeLocal(local: string): { iso: string | null } | { error: string } {
  if (!local) return { iso: null };
  const d = new Date(local);
  if (Number.isNaN(d.getTime()) || d.getFullYear() > 2100) return { error: "La fecha del próximo contacto no es válida." };
  if (d.getTime() < Date.now() - 60_000) return { error: "El próximo contacto debe ser a futuro." };
  return { iso: d.toISOString() };
}

function fechaHora(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("es-MX", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fecha(valor: string | null): string {
  if (!valor) return "—";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(valor) ? `${valor}T00:00:00` : valor);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
}

const etiquetaDe = (ops: OpcionCatalogo[], clave: string | null) => (clave ? (ops.find((o) => o.clave === clave)?.etiqueta ?? clave) : null);

type Props = {
  gestion: Gestion;
  enviando: boolean;
  /** Guarda uno o varios campos de gestión (PUT …/gestion). Resuelve si se guardó. */
  guardar: (valores: Record<string, unknown>, exito: string) => Promise<boolean>;
  /** Marca «no contactar» con el canal por el que lo pidió (PUT …/no-contactar). */
  noContactar: (canal: string) => void;
  /** Quita «no contactar» (solo administradores; nunca una baja pedida por WhatsApp). */
  quitarNoContactar: () => void;
  esAdmin: boolean;
  /** Muestra un error de captura sin ir al servidor. */
  avisar: (texto: string) => void;
};

export default function GestionBdc({ gestion, enviando, guardar, noContactar, quitarNoContactar, esAdmin, avisar }: Props) {
  const g = gestion.valores;
  const k = gestion.calculados;
  const cat = gestion.catalogos;
  const [monto, setMonto] = useState(g.monto_cotizado === null ? "" : String(g.monto_cotizado));
  const [proximo, setProximo] = useState(aLocal(g.proximo_contacto_en));
  const [canalBaja, setCanalBaja] = useState("llamada");
  const [confirmarBaja, setConfirmarBaja] = useState(false);

  const guardarMonto = () => {
    const limpio = monto.replace(/[$,\s]/g, "");
    const anterior = g.monto_cotizado === null ? "" : String(g.monto_cotizado);
    if (limpio === anterior) return;
    if (limpio !== "" && !(Number(limpio) >= 0)) {
      setMonto(anterior);
      return;
    }
    guardar({ monto_cotizado: limpio === "" ? null : Number(limpio) }, "Monto cotizado guardado.").then((ok) => {
      if (!ok) setMonto(anterior);
    });
  };

  const guardarProximo = (incompleta: boolean) => {
    const anterior = aLocal(g.proximo_contacto_en);
    // Un segmento borrado deja el valor vacío: no es «quitarlo», es una fecha a medias.
    if (incompleta) {
      avisar("La fecha del próximo contacto está incompleta: no se guardó.");
      setProximo(anterior);
      return;
    }
    if (proximo === anterior) return;
    const r = proximoDesdeLocal(proximo);
    if ("error" in r) {
      avisar(r.error);
      setProximo(anterior);
      return;
    }
    if (!r.iso && RESPUESTA_CON_PROXIMO.has(g.respuesta_titular ?? "")) {
      avisar("Con esta respuesta del titular hace falta la fecha del próximo contacto: cámbiala en lugar de borrarla.");
      setProximo(anterior);
      return;
    }
    guardar({ proximo_contacto_en: r.iso }, r.iso ? "Próximo contacto agendado." : "Próximo contacto quitado.").then((ok) => {
      if (!ok) setProximo(anterior);
    });
  };

  // Las fechas se guardan al salir del campo: mientras se teclea, el navegador entrega años a medias («0002»).
  const fechaInput = (campo: "fecha_compra_ge" | "link_enviado_en" | "fecha_pago", titulo: string, exito: string) => (
    <label className="ficha-campo">
      <span>{titulo}</span>
      <input
        key={g[campo] ?? ""}
        type="date"
        className="auto-input"
        defaultValue={g[campo] ?? ""}
        min="2000-01-01"
        max={hoy()}
        disabled={enviando}
        onBlur={(e) => {
          const anterior = g[campo] ?? "";
          const v = e.target.value;
          if (e.target.validity.badInput) {
            avisar("La fecha está incompleta: no se guardó.");
            e.target.value = anterior;
            return;
          }
          if (v === anterior) return;
          if (v && (v < "2000-01-01" || v > hoy())) {
            avisar("La fecha debe ser desde el 2000 y no a futuro.");
            e.target.value = anterior;
            return;
          }
          const input = e.target;
          guardar({ [campo]: v || null }, exito).then((ok) => {
            if (!ok) input.value = anterior;
          });
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </label>
  );

  const selectCatalogo = (campo: "donde_obtuvo_ge" | "origen_venta", titulo: string, exito: string) => (
    <label className="ficha-campo">
      <span>{titulo}</span>
      <select
        className="auto-input"
        value={g[campo] ?? ""}
        disabled={enviando}
        onChange={(e) => guardar({ [campo]: e.target.value || null }, exito)}
      >
        <option value="">Sin dato</option>
        {cat[campo].map((o) => (
          <option key={o.clave} value={o.clave}>
            {o.etiqueta}
          </option>
        ))}
      </select>
    </label>
  );

  const periodo =
    k.kilometraje === null || k.kilometraje === undefined ? "Sin km capturado" : k.periodo ? `Periodo ${k.periodo}` : "Fuera de rango por km";
  const respuesta = etiquetaDe(cat.respuesta_titular, g.respuesta_titular);

  return (
    <section className="ficha-sec">
      <h3>Gestión</h3>

      <div className="ficha-grupo">
        <h4>Seguimiento</h4>
        <p className="ficha-ayuda">La respuesta del titular y su motivo se registran con la llamada.</p>
        <div className="ficha-datos">
          <div className="ficha-campo">
            <span>Respuesta del titular</span>
            <strong className="ficha-valor">{respuesta ?? "—"}</strong>
          </div>
          <label className="ficha-campo">
            <span>Próximo contacto</span>
            <input
              type="datetime-local"
              className="auto-input"
              value={proximo}
              min={aLocal(new Date().toISOString())}
              max={FECHA_HORA_MAX}
              disabled={enviando}
              onChange={(e) => setProximo(e.target.value)}
              onBlur={(e) => guardarProximo(e.currentTarget.validity.badInput)}
            />
          </label>
          {g.motivo_no_interes && (
            <div className="ficha-campo">
              <span>Motivo de no interés</span>
              <strong className="ficha-valor">{etiquetaDe(cat.motivo_no_interes, g.motivo_no_interes)}</strong>
            </div>
          )}
        </div>
      </div>

      <div className="ficha-grupo">
        <h4>Ya tiene GE</h4>
        <label className="ficha-check">
          <input
            type="checkbox"
            checked={g.declara_ge}
            disabled={enviando}
            onChange={(e) => guardar({ declara_ge: e.target.checked }, e.target.checked ? "Marcado: declara tener GE." : "Desmarcado.")}
          />
          El cliente declara tener garantía extendida
          {g.declara_ge && (
            <span className={`ficha-chip ${k.ge_validada ? "ficha-chip-ok" : ""}`}>{k.ge_validada ? "Validada en cartera" : "Sin validar en cartera"}</span>
          )}
        </label>
        {g.declara_ge && (
          <div className="ficha-datos">
            {selectCatalogo("donde_obtuvo_ge", "Dónde la obtuvo", "Guardado.")}
            {fechaInput("fecha_compra_ge", "Fecha aproximada de compra", "Fecha guardada.")}
          </div>
        )}
      </div>

      <div className="ficha-grupo">
        <h4>Calificación</h4>
        <div className="ficha-datos">
          <label className="ficha-campo">
            <span>Conserva el auto</span>
            <select
              className="auto-input"
              value={g.conserva_auto === null ? "" : String(g.conserva_auto)}
              disabled={enviando}
              onChange={(e) => guardar({ conserva_auto: e.target.value === "" ? null : e.target.value === "true" }, "Guardado.")}
            >
              <option value="">Sin dato</option>
              <option value="true">Sí</option>
              <option value="false">No</option>
            </select>
          </label>
          <div className="ficha-campo">
            <span>Periodo</span>
            <strong className="ficha-valor">{periodo}</strong>
          </div>
          <div className="ficha-campo">
            <span>Lectura del km</span>
            <strong className="ficha-valor">{fecha(k.km_leido_en)}</strong>
          </div>
        </div>
      </div>

      <div className="ficha-grupo">
        <h4>Cotización y pago</h4>
        <div className="ficha-datos">
          <label className="ficha-campo">
            <span>Monto cotizado</span>
            <input
              type="text"
              inputMode="decimal"
              className="auto-input"
              placeholder="$0.00"
              value={monto}
              disabled={enviando}
              onChange={(e) => setMonto(e.target.value.replace(/[^\d.,$\s]/g, ""))}
              onBlur={guardarMonto}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </label>
          {fechaInput("link_enviado_en", "Envío del link de pago", "Fecha de envío guardada.")}
          <div className="ficha-campo">
            <span>Plazo adicional</span>
            <strong className="ficha-valor">{k.plazo_meses ? `${k.plazo_meses} meses` : "—"}</strong>
          </div>
          {fechaInput("fecha_pago", "Fecha de pago", "Fecha de pago guardada.")}
          <div className="ficha-campo">
            <span>Pagado</span>
            <strong className="ficha-valor">{k.pagado ? "Sí" : "No"}</strong>
          </div>
          {selectCatalogo("origen_venta", "Origen de la venta", "Origen de la venta guardado.")}
        </div>
        <p className="ficha-ayuda">Con la fecha de pago capturada la oportunidad cuenta como pagada. El plazo se elige en «Datos para emitir».</p>
      </div>

      <div className="ficha-grupo">
        <h4>Cierre</h4>
        <div className="ficha-datos">
          <div className="ficha-campo">
            <span>Estado de la oportunidad</span>
            <strong className="ficha-valor">{k.estado_calculado ?? "—"}</strong>
          </div>
        </div>
        <label className="ficha-check">
          <input
            type="checkbox"
            checked={g.escalar_posventa}
            disabled={enviando}
            onChange={(e) => guardar({ escalar_posventa: e.target.checked }, e.target.checked ? "Escalado a posventa." : "Ya no está escalado a posventa.")}
          />
          Escalar a posventa (queja de servicio)
        </label>
        {g.no_contactar ? (
          <p className="ficha-ayuda ficha-ayuda-alerta">
            No contactar desde {fecha(g.no_contactar_en)}
            {g.no_contactar_canal ? ` (lo pidió por ${CANALES_BAJA.find((c) => c.valor === g.no_contactar_canal)?.texto.toLowerCase() ?? g.no_contactar_canal})` : ""}. No recibe mensajes masivos.
            {esAdmin && ["llamada", "correo", "presencial", "sms"].includes(g.no_contactar_canal ?? "") && (
              <>
                {" "}
                <button type="button" className="boton-secundario-claro" disabled={enviando} onClick={quitarNoContactar}>
                  Quitar «no contactar» (error de captura)
                </button>
              </>
            )}
          </p>
        ) : confirmarBaja ? (
          <div className="ficha-fila">
            <select className="auto-input" value={canalBaja} onChange={(e) => setCanalBaja(e.target.value)} aria-label="Canal por el que lo pidió">
              {CANALES_BAJA.map((c) => (
                <option key={c.valor} value={c.valor}>
                  Lo pidió por {c.texto.toLowerCase()}
                </option>
              ))}
            </select>
            <div className="ficha-botones">
              <button type="button" className="boton-guardar boton-guardar-peligro" disabled={enviando} onClick={() => noContactar(canalBaja)}>
                Confirmar
              </button>
              <button type="button" className="boton-secundario-claro" disabled={enviando} onClick={() => setConfirmarBaja(false)}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="boton-secundario-claro" disabled={enviando} onClick={() => setConfirmarBaja(true)}>
            Pidió no ser contactado
          </button>
        )}
      </div>

      <div className="ficha-grupo">
        <h4>Indicadores</h4>
        <dl className="ficha-datos">
          <div>
            <dt>Intentos</dt>
            <dd>
              {k.intentos_llamada ?? 0} por llamada · {k.intentos_whatsapp ?? 0} por WhatsApp
            </dd>
          </div>
          <div>
            <dt>Último intento</dt>
            <dd>{fechaHora(k.ultimo_intento_en)}</dd>
          </div>
          <div>
            <dt>Último contacto efectivo</dt>
            <dd>{fechaHora(k.ultimo_contacto_efectivo_en)}</dd>
          </div>
          <div>
            <dt>Días en campaña</dt>
            <dd>{k.dias_en_campana ?? "—"}</dd>
          </div>
          <div>
            <dt>Días para cierre de ventana</dt>
            <dd>{k.dias_para_cierre ?? "—"}</dd>
          </div>
          <div>
            <dt>Último mensaje</dt>
            <dd>
              {k.ultimo_mensaje_estado ? `${k.ultimo_mensaje_estado} · ${fechaHora(k.ultimo_mensaje_en)}` : "Sin mensajes"}
              {k.ultima_plantilla ? ` · ${k.ultima_plantilla}` : ""}
            </dd>
          </div>
          {k.ultimo_mensaje_fallo && (
            <div>
              <dt>Motivo del fallo</dt>
              <dd>{k.ultimo_mensaje_fallo}</dd>
            </div>
          )}
        </dl>
      </div>
    </section>
  );
}
