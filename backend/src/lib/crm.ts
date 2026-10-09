import { getPool } from "./db.js";
import { recalcularEtapas } from "./cicloVehiculo.js";
import type { CampoEntidad } from "./entidades.js";
import {
  COLOR_RESULTADO,
  DESTINO_DE_RESULTADO,
  NOMBRE_MOTIVO,
  RESULTADOS_BDC,
  SIN_CONTACTO_EFECTIVO,
  esResultadoBdc,
  resultadoDeEstado,
  type ResultadoBdc,
} from "./resultadoBdcLogica.js";
import {
  NOMBRES_CATALOGO,
  RESPUESTAS_CON_PROXIMO,
  efectoClasificacion,
  fechaCapturaValida,
  efectoRespuesta,
  type Catalogo,
  type ClasificacionRespuesta,
  type MotivoNoInteres,
  type Opcion,
  type RespuestaTitular,
} from "./gestionLogica.js";

/** Estado de contacto: la vista lo muestra con etiqueta, la tabla lo guarda con clave. */
export const ESTADOS_CONTACTO: Record<string, string> = {
  "Sin intentar": "sin_intentar",
  Intentando: "intentando",
  Contactado: "contactado",
  "Buzón de voz": "buzon",
  "No contactable": "no_contactable",
  Baja: "baja",
};

const COLOR_ESTADO_CONTACTO: Record<string, string> = {
  "Sin intentar": "#6b7280",
  Intentando: "#ff4d00",
  Contactado: "#614dff",
  "Buzón de voz": "#b89f00",
  "No contactable": "#dc2626",
  Baja: "#374151",
};

const COLOR_EJECUTIVO = "#475569";

const ETIQUETA_DE_ESTADO: Record<string, string> = Object.fromEntries(Object.entries(ESTADOS_CONTACTO).map(([etiqueta, clave]) => [clave, etiqueta]));
const TITULO_CAMPO: Record<string, string> = {
  comentarios: "Comentarios",
  fecha_ultimo_contacto: "Fecha último contacto",
  fecha_compra: "Fecha de compra de la garantía",
  kilometraje: "Kilometraje",
  ejecutivo: "Ejecutivo",
  estado_contacto: "Contacto",
  resultado_bdc: "Resultado BDC",
  respuesta_titular: "Respuesta del titular",
  proximo_contacto_en: "Próximo contacto",
  motivo_no_interes: "Motivo de no interés",
  declara_ge: "Cliente declara tener GE",
  donde_obtuvo_ge: "Dónde obtuvo la GE",
  fecha_compra_ge: "Fecha aprox. de compra de la GE",
  conserva_auto: "Conserva el auto",
  monto_cotizado: "Monto cotizado",
  link_enviado_en: "Fecha de envío del link",
  fecha_pago: "Fecha de pago",
  origen_venta: "Origen de la venta",
  escalar_posventa: "Escalar a posventa",
  clasificacion_respuesta: "Clasificación de la respuesta",
};

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/** El historial y las actividades referencian a public.usuarios: sin fila ahí (ej. admin de plataforma) queda sin autor. */
export async function autorValido(cliente: Consulta, usuarioId?: string): Promise<string | null> {
  if (!usuarioId) return null;
  return (await cliente.query(`SELECT id FROM usuarios WHERE id = $1`, [usuarioId])).rows[0]?.id ?? null;
}

/**
 * Contacto efectivo (contestó el titular, o su mensaje de WhatsApp se clasificó como del titular): si el lead sigue en «Por contactar»,
 * pasa solo a «Contactado». Nunca retrocede ni avanza más allá: el resto del embudo lo mueve el ejecutivo. El cambio
 * de estado dispara las automatizaciones de «Contactado» (trigger de crm_oportunidades). Devuelve si lo movió.
 */
export async function avanzarPorContacto(
  cliente: Consulta,
  sucursalId: string,
  oportunidadId: string,
  /** Una llamada registrada con el titular avanza aunque la campaña ya haya salido de la ventana. */
  inclusoFueraDeVentana = false,
): Promise<boolean> {
  await marcarPrimerContacto(cliente, sucursalId, oportunidadId);
  const { rowCount } = await cliente.query(
    `WITH destino AS (
       SELECT o.id, o.etapa_id AS origen, d.id AS etapa,
              (SELECT coalesce(max(x.posicion), 0) + 1024 FROM crm_oportunidades x WHERE x.etapa_id = d.id) AS posicion
         FROM crm_oportunidades o
         JOIN crm_etapas e ON e.id = o.etapa_id AND e.clave = 'por_contactar'
         JOIN crm_etapas d ON d.embudo_id = e.embudo_id AND d.clave = 'contactado' AND d.tipo = 'abierta' AND d.activa
        WHERE o.id = $1 AND o.sucursal_id = $2 AND o.estado = 'abierta' AND (o.estado_cartera = 'ACTIVA' OR $3::boolean)
     ), movida AS (
       UPDATE crm_oportunidades o SET etapa_id = d.etapa, posicion = d.posicion, entro_a_etapa_en = now()
         -- Si alguien lo movió mientras tanto (otra transacción), sigue en su lugar: no regresa a «Contactado».
         FROM destino d WHERE o.id = d.id AND o.etapa_id = d.origen
       RETURNING o.id, d.origen, d.etapa
     )
     INSERT INTO crm_historial_etapas (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, origen)
     SELECT $2, id, origen, etapa, 'automatizacion' FROM movida`,
    [oportunidadId, sucursalId, inclusoFueraDeVentana],
  );
  const movido = (rowCount ?? 0) > 0;
  if (movido) await ajustarResultados(cliente, sucursalId, [oportunidadId]);
  return movido;
}

/**
 * Primer contacto efectivo dentro de la campaña en curso (KPI «tiempo al primer contacto»): se fija una sola vez por
 * campaña, la primera vez que el lead queda «Contactado» (contestó o escribió el titular, o el ejecutivo lo marcó).
 */
export async function marcarPrimerContacto(cliente: Consulta, sucursalId: string, oportunidadId: string): Promise<void> {
  await cliente.query(
    `UPDATE crm_oportunidad_campanas p SET primer_contacto_en = now()
       FROM crm_oportunidades o
      WHERE o.id = $1 AND o.sucursal_id = $2 AND o.estado_contacto = 'contactado'
        AND p.oportunidad_id = o.id AND p.cerrada_en IS NULL AND p.primer_contacto_en IS NULL`,
    [oportunidadId, sucursalId],
  );
}

/**
 * Pone el «Resultado BDC» que corresponde al estado al que se movieron los leads: si el que tienen ya es de ese estado
 * (y, en perdido, del mismo motivo) se respeta; si no, toma el resultado base. Se llama después de cualquier cambio de
 * estado (arrastre, edición, acción masiva, contacto) para que resultado y estado nunca se contradigan.
 */
export async function ajustarResultados(cliente: Consulta, sucursalId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { rows } = await cliente.query(
    `SELECT o.id, o.resultado_bdc, e.clave AS etapa, mp.clave AS motivo
       FROM crm_oportunidades o
       JOIN crm_etapas e ON e.id = o.etapa_id
       LEFT JOIN crm_motivos_perdida mp ON mp.id = o.motivo_perdida_id
      WHERE o.sucursal_id = $1 AND o.id = ANY($2::uuid[])`,
    [sucursalId, ids],
  );
  const cambios = rows
    .map((r) => ({ id: r.id as string, antes: r.resultado_bdc as ResultadoBdc, nuevo: resultadoDeEstado(r.etapa as string, (r.motivo as string | null) ?? null, r.resultado_bdc as ResultadoBdc) }))
    .filter((c) => c.nuevo !== c.antes);
  if (cambios.length > 0) {
    await cliente.query(
      `UPDATE crm_oportunidades o SET resultado_bdc = r.nuevo FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, nuevo text)
        WHERE o.id = r.id AND o.sucursal_id = $1`,
      [sucursalId, JSON.stringify(cambios)],
    );
  }
}

/** El motivo de pérdida (por clave) que pide un resultado; si la sucursal no lo tiene, se crea. */
async function asegurarMotivo(cliente: Consulta, sucursalId: string, clave: string): Promise<string> {
  const { rows } = await cliente.query(`SELECT id FROM crm_motivos_perdida WHERE sucursal_id = $1 AND clave = $2`, [sucursalId, clave]);
  if (rows[0]) return rows[0].id as string;
  const { rows: nuevo } = await cliente.query(
    `INSERT INTO crm_motivos_perdida (sucursal_id, clave, nombre, orden)
     VALUES ($1, $2, $3, (SELECT coalesce(max(orden), 0) + 1 FROM crm_motivos_perdida WHERE sucursal_id = $1))
     ON CONFLICT (sucursal_id, clave) DO UPDATE SET clave = EXCLUDED.clave RETURNING id`,
    [sucursalId, clave, NOMBRE_MOTIVO[clave] ?? clave],
  );
  return nuevo[0].id as string;
}

/** Estados de contrato que prueban una venta: el certificado ya se entregó (implica pago confirmado). */
export const CONTRATO_CON_EVIDENCIA = ["certificado_entregado", "cobertura_iniciada"];

/**
 * Si la sucursal exige evidencia para marcar una venta, devuelve el motivo por el que aún no se
 * puede; null si se puede (o la sucursal no lo exige). Una venta es pago y certificado, no interés.
 */
export async function evidenciaFaltante(cliente: Consulta, sucursalId: string, oportunidadId: string): Promise<string | null> {
  const { rows: cfg } = await cliente.query(`SELECT exigir_evidencia_venta FROM crm_config WHERE sucursal_id = $1`, [sucursalId]);
  if (!cfg[0]?.exigir_evidencia_venta) return null;
  const { rows } = await cliente.query(`SELECT estado FROM crm_contratos WHERE oportunidad_id = $1`, [oportunidadId]);
  return rows[0] && CONTRATO_CON_EVIDENCIA.includes(rows[0].estado as string)
    ? null
    : "Para marcar una venta se necesita el certificado entregado. Registra el contrato en la ficha de la oportunidad.";
}

/**
 * Columnas de la vista que se editan desde la tabla, y a dónde van. Cualquier otra
 * columna 'back' que llegue aquí es un error de configuración, no se ignora.
 */
const COLUMNAS_DIRECTAS = new Set(["comentarios", "fecha_ultimo_contacto", "fecha_compra", "ejecutivo"]);

/**
 * Campos de gestión del BDC (Notion) que van directo a la fila, con su tipo para validar lo que llega por la ficha o la
 * tabla. Los de catálogo (respuesta del titular, motivo de no interés…) se resuelven aparte: llega la etiqueta o la clave.
 */
const CAMPOS_GESTION: Record<string, "booleano" | "booleano_o_nulo" | "fecha" | "fecha_hora" | "monto"> = {
  proximo_contacto_en: "fecha_hora",
  declara_ge: "booleano",
  fecha_compra_ge: "fecha",
  conserva_auto: "booleano_o_nulo",
  monto_cotizado: "monto",
  link_enviado_en: "fecha",
  fecha_pago: "fecha",
  escalar_posventa: "booleano",
};

function validarGestion(campo: string, v: unknown): string | null {
  const tipo = CAMPOS_GESTION[campo];
  const titulo = TITULO_CAMPO[campo] ?? campo;
  if (v === null) return tipo === "booleano" ? `«${titulo}» no puede quedar vacío.` : null;
  switch (tipo) {
    case "booleano":
    case "booleano_o_nulo":
      return typeof v === "boolean" ? null : `«${titulo}» debe ser sí o no.`;
    case "fecha":
      return typeof v === "string" && fechaCapturaValida(v, new Date().toLocaleDateString("en-CA", { timeZone: "America/Hermosillo" }))
        ? null
        : `«${titulo}» no es una fecha válida: debe ser un día real, desde el 2000 y no a futuro.`;
    case "fecha_hora": {
      const d = typeof v === "string" ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100
        ? null
        : `«${titulo}» no es una fecha válida.`;
    }
    case "monto":
      return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10_000_000 ? null : `«${titulo}» debe ser un monto válido.`;
  }
  return null;
}

/** Compara el valor guardado con el nuevo sin importar el tipo con que llegó (fecha, número, texto). */
function mismoValor(a: unknown, b: unknown): boolean {
  if ((a ?? null) === null || (b ?? null) === null) return (a ?? null) === (b ?? null);
  if (a instanceof Date) return a.getTime() === new Date(String(b)).getTime();
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

/** Opciones de los catálogos de gestión del grupo (todas; las inactivas solo sirven para mostrar valores viejos). */
export async function leerCatalogos(cliente: Consulta, sucursalId: string): Promise<Record<Catalogo, (Opcion & { activo: boolean })[]>> {
  const { rows } = await cliente.query(
    `SELECT catalogo, clave, etiqueta, activo FROM crm_catalogo_opciones WHERE sucursal_id = $1 ORDER BY catalogo, orden`,
    [sucursalId],
  );
  const salida = Object.fromEntries(NOMBRES_CATALOGO.map((c) => [c, [] as (Opcion & { activo: boolean })[]])) as Record<
    Catalogo,
    (Opcion & { activo: boolean })[]
  >;
  for (const r of rows) salida[r.catalogo as Catalogo]?.push({ clave: r.clave, etiqueta: r.etiqueta, activo: r.activo });
  return salida;
}

/** Color de cada respuesta del titular: azul si avanza, ámbar si es seguimiento, rojo si cierra. */
const COLOR_RESPUESTA: Record<string, string> = {
  PIDE_INFORMACION: "#614dff",
  PIDE_PRECIO: "#0891b2",
  QUIERE_PAGAR: "#16a34a",
  LLAMAR_DESPUES: "#d97706",
  LO_VA_A_PENSAR: "#b89f00",
  QUEJA_SERVICIO: "#9333ea",
};
const COLOR_CATALOGO = "#6b7280";

/**
 * No contactar (Notion: «gana sobre todo y bloquea masivos»): la baja es de la persona, así que va al contacto y deja en
 * «Baja» todos sus leads que no son venta (abiertos y perdidos: así el ciclo diario tampoco los reabre). Se guarda el
 * canal por el que lo pidió, si se sabe.
 */
export async function marcarNoContactar(cliente: Consulta, sucursalId: string, oportunidadId: string, canal: string | null): Promise<void> {
  await cliente.query(
    `WITH c AS (
       UPDATE crm_contactos k SET whatsapp_baja = true, whatsapp_baja_en = coalesce(k.whatsapp_baja_en, now()),
              -- WhatsApp manda: una baja por WhatsApp no se puede quitar, aunque antes se hubiera registrado por otro canal.
              baja_canal = CASE WHEN $3 = 'whatsapp' THEN 'whatsapp' ELSE coalesce(k.baja_canal, $3) END
         FROM crm_oportunidades o
        WHERE o.id = $1 AND o.sucursal_id = $2 AND k.id = o.contacto_id
       RETURNING k.id
     )
     UPDATE crm_oportunidades x SET estado_contacto = 'baja', respuesta_por_clasificar = false
       FROM c WHERE x.contacto_id = c.id AND x.sucursal_id = $2 AND x.estado <> 'ganada'
        AND (x.estado_contacto <> 'baja' OR x.respuesta_por_clasificar)`,
    [oportunidadId, sucursalId, canal],
  );
}

/**
 * Las listas desplegables del CRM salen de sus tablas (etapas, motivos) o de datos
 * vivos (ejecutivos): se inyectan en los campos para que lo que ve y valida el
 * portal sea siempre lo vigente, no una copia guardada en la configuración.
 */
export async function opcionesDinamicas(sucursalId: string): Promise<Record<string, { valor: string; color: string; tipo?: string }[]>> {
  const pool = getPool();
  const [etapas, motivos, ejecutivos, catalogos] = await Promise.all([
    pool.query(`SELECT nombre, color, tipo FROM crm_etapas WHERE sucursal_id = $1 AND activa ORDER BY orden`, [sucursalId]),
    // «Pidió baja» no se elige a mano: lo pone el flujo de «no contactar», que además da de baja a la persona.
    pool.query(`SELECT nombre FROM crm_motivos_perdida WHERE sucursal_id = $1 AND activo AND clave <> 'pidio_baja' ORDER BY orden`, [sucursalId]),
    pool.query(
      `SELECT DISTINCT ejecutivo FROM crm_oportunidades WHERE sucursal_id = $1 AND ejecutivo IS NOT NULL AND ejecutivo <> '' ORDER BY 1`,
      [sucursalId],
    ),
    leerCatalogos(pool, sucursalId),
  ]);
  return {
    etapa_embudo: etapas.rows.map((r) => ({ valor: r.nombre as string, color: r.color as string, tipo: r.tipo as string })),
    resultado_bdc: RESULTADOS_BDC.map((r) => ({ valor: r, color: COLOR_RESULTADO[r] })),
    motivo_perdida: motivos.rows.map((r) => ({ valor: r.nombre as string, color: "#6b7280" })),
    estado_contacto: Object.keys(ESTADOS_CONTACTO).map((valor) => ({ valor, color: COLOR_ESTADO_CONTACTO[valor] })),
    ejecutivo: ejecutivos.rows.map((r) => ({ valor: r.ejecutivo as string, color: COLOR_EJECUTIVO })),
    // Catálogos de gestión del grupo: la tabla muestra y elige por etiqueta.
    ...Object.fromEntries(
      Object.entries(catalogos).map(([cat, ops]) => [
        cat,
        ops.filter((o) => o.activo).map((o) => ({ valor: o.etiqueta, color: (cat === "respuesta_titular" && COLOR_RESPUESTA[o.clave]) || COLOR_CATALOGO })),
      ]),
    ),
  };
}

/**
 * Quitar «no contactar» (solo un administrador, para corregir un error de captura). Una baja pedida por WhatsApp (STOP o
 * clasificada así) no se quita nunca: esa la decidió la persona. Sus leads en «Baja» vuelven a «Contactado» si ya se
 * había hablado con el titular, o a «Sin intentar».
 */
export async function quitarNoContactar(
  sucursalId: string,
  oportunidadId: string,
  usuarioId?: string,
): Promise<{ ok: true } | { ok: false; estado: 400 | 404; error: string }> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `SELECT k.id, k.whatsapp_baja, k.baja_canal,
              EXISTS (SELECT 1 FROM crm_actividades a JOIN crm_oportunidades x ON x.id = a.oportunidad_id
                       WHERE x.contacto_id = k.id AND a.tipo = 'baja' AND a.detalle->>'canal' = 'whatsapp') AS por_whatsapp
         FROM crm_oportunidades o JOIN crm_contactos k ON k.id = o.contacto_id
        WHERE o.id = $1 AND o.sucursal_id = $2 FOR UPDATE OF k`,
      [oportunidadId, sucursalId],
    );
    const k = rows[0];
    if (!k) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }
    if (!k.whatsapp_baja) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 400, error: "Esta persona no está en «no contactar»." };
    }
    // Solo se quita lo que el BDC registró a mano (llamada, correo, presencial, SMS). Por WhatsApp o sin canal conocido, no.
    if (!["llamada", "correo", "presencial", "sms"].includes(k.baja_canal) || k.por_whatsapp) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 400, error: "La baja la pidió el cliente por WhatsApp (o no se sabe por dónde): no se puede quitar." };
    }
    await cliente.query(`UPDATE crm_contactos SET whatsapp_baja = false, whatsapp_baja_en = NULL, baja_canal = NULL WHERE id = $1`, [k.id]);
    await cliente.query(
      `UPDATE crm_oportunidades SET estado_contacto = CASE WHEN ultimo_contacto_efectivo_en IS NOT NULL THEN 'contactado' ELSE 'sin_intentar' END
        WHERE contacto_id = $1 AND sucursal_id = $2 AND estado_contacto = 'baja'`,
      [k.id, sucursalId],
    );
    await cliente.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id)
       VALUES ($1, $2, 'edicion', 'Se quitó «no contactar»', $3, $4)`,
      [sucursalId, oportunidadId, { campo: "no_contactar", anterior: true, nuevo: false, canal: k.baja_canal ?? null }, await autorValido(cliente, usuarioId)],
    );
    await cliente.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/**
 * La respuesta del titular y el motivo de no interés se capturan con la llamada, junto con lo que piden (próximo contacto,
 * motivo, comentario): en la tabla se ven pero no se editan sueltos.
 */
export const SOLO_CON_LLAMADA = new Set(["respuesta_titular", "motivo_no_interes", "clasificacion_respuesta"]);

/** Pone las opciones vigentes en los campos que son lista del CRM. */
export function conOpcionesDinamicas(
  campos: CampoEntidad[],
  opciones: Record<string, { valor: string; color: string; tipo?: string }[]>,
): CampoEntidad[] {
  return campos.map((c) => {
    if (!opciones[c.nombre_tecnico] || c.origen !== "back") return c;
    const conLista: CampoEntidad = { ...c, editor_tipo: "lista", opciones: opciones[c.nombre_tecnico] };
    return SOLO_CON_LLAMADA.has(c.nombre_tecnico) ? { ...conLista, origen: "api" } : conLista;
  });
}

export type ResultadoEdicion = { ok: true; etapaCambio: boolean } | { ok: false; estado: 404 | 400; error: string };

/**
 * Aplica una edición a una oportunidad, en una sola transacción. Un cambio de etapa
 * mueve la tarjeta al final de su columna, actualiza el estado comercial (abierta,
 * ganada, perdida), y deja constancia en el historial. Lo demás va directo a la fila.
 */
export type ParamsEdicion = {
  sucursalId: string;
  oportunidadId: string;
  valores: Record<string, unknown>;
  usuarioId?: string;
  /** Canal por el que pidió no ser contactado, si la edición termina en baja (respuesta del titular o clasificación). */
  canalBaja?: string;
  /** El contacto efectivo ya se registró aparte (la llamada): no lo vuelvas a marcar. */
  sinMarcarContacto?: boolean;
  /** Viene de registrar una llamada (o un «no contactar»): solo así se aceptan la respuesta del titular y su motivo. */
  capturaDeLlamada?: boolean;
};

export async function editarOportunidad(params: ParamsEdicion): Promise<ResultadoEdicion> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const r = await editarEnTransaccion(cliente, params);
    await cliente.query(r.ok ? "COMMIT" : "ROLLBACK");
    return r;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Lo mismo que editarOportunidad, dentro de una transacción abierta por quien llama (que hace COMMIT o ROLLBACK). */
export async function editarEnTransaccion(cliente: Consulta, params: ParamsEdicion): Promise<ResultadoEdicion> {
  const { sucursalId, oportunidadId, valores, usuarioId } = params;
  {

    const { rows: filas } = await cliente.query(
      `SELECT o.id, o.etapa_id, o.estado, o.motivo_perdida_id, e.tipo AS tipo_etapa, o.comentarios, o.resultado_bdc,
              o.fecha_ultimo_contacto::text AS fecha_ultimo_contacto, o.fecha_compra::text AS fecha_compra,
              o.ejecutivo, o.estado_contacto, o.vehiculo_id, o.estado_cartera,
              (SELECT k.whatsapp_baja FROM crm_contactos k WHERE k.id = o.contacto_id) AS contacto_baja,
              o.respuesta_titular, o.motivo_no_interes, o.donde_obtuvo_ge, o.origen_venta, o.clasificacion_respuesta,
              o.proximo_contacto_en, o.declara_ge, o.fecha_compra_ge::text AS fecha_compra_ge, o.conserva_auto,
              o.monto_cotizado::float8 AS monto_cotizado, o.link_enviado_en::text AS link_enviado_en,
              o.fecha_pago::text AS fecha_pago, o.escalar_posventa,
              (SELECT v.kilometraje FROM crm_vehiculos v WHERE v.id = o.vehiculo_id) AS kilometraje
         FROM crm_oportunidades o LEFT JOIN crm_etapas e ON e.id = o.etapa_id
        WHERE o.id = $1 AND o.sucursal_id = $2 FOR UPDATE OF o`,
      [oportunidadId, sucursalId],
    );
    const actual = filas[0];
    if (!actual) {
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }

    const sets: string[] = [];
    const args: unknown[] = [];
    const asignar = (columna: string, valor: unknown) => {
      args.push(valor);
      sets.push(`${columna} = $${args.length}`);
    };

    for (const [col, valor] of Object.entries(valores)) {
      if (COLUMNAS_DIRECTAS.has(col)) asignar(col, valor);
    }

    // ---- Gestión del BDC (Notion): campos directos ----
    for (const campo of Object.keys(CAMPOS_GESTION)) {
      if (!(campo in valores)) continue;
      const v = valores[campo] === "" || valores[campo] === undefined ? null : valores[campo];
      const error = validarGestion(campo, v);
      if (error) return { ok: false, estado: 400, error };
      asignar(campo, v);
    }
    if ("proximo_contacto_en" in valores && !params.capturaDeLlamada) {
      const v = valores.proximo_contacto_en;
      if (v && new Date(String(v)).getTime() < Date.now() - 60_000) {
        return { ok: false, estado: 400, error: "El próximo contacto debe ser a futuro." };
      }
      if (!v && RESPUESTAS_CON_PROXIMO.has(actual.respuesta_titular as string)) {
        return { ok: false, estado: 400, error: "Con esta respuesta del titular hace falta la fecha del próximo contacto: cámbiala en lugar de borrarla." };
      }
    }

    // ---- Gestión del BDC: listas con catálogo (llega la etiqueta desde la tabla o la clave desde la ficha) ----
    const catalogos = NOMBRES_CATALOGO.some((c) => c in valores) ? await leerCatalogos(cliente, sucursalId) : null;
    const claves: Partial<Record<Catalogo, string | null>> = {};
    for (const cat of NOMBRES_CATALOGO) {
      if (!(cat in valores)) continue;
      const v = valores[cat];
      if (v === null || v === undefined || v === "") {
        claves[cat] = null;
      } else {
        const op = catalogos![cat].find((o) => o.clave === v || o.etiqueta === v);
        if (!op) return { ok: false, estado: 400, error: `'${String(v)}' no está entre las opciones de «${TITULO_CAMPO[cat]}».` };
        claves[cat] = op.clave;
      }
      asignar(cat, claves[cat]);
    }
    if ((claves.respuesta_titular !== undefined || claves.motivo_no_interes !== undefined) && !params.capturaDeLlamada) {
      return { ok: false, estado: 400, error: "La respuesta del titular se registra con la llamada, desde la ficha." };
    }
    if (claves.clasificacion_respuesta) sets.push("respuesta_por_clasificar = false");

    // Lo que la respuesta del titular o la clasificación de un mensaje le hacen al lead (Notion, «Cómo se mueve el hito»).
    let resultadoPorRespuesta: ResultadoBdc | null = null;
    let motivoForzado: string | undefined;
    let noContactar = false;
    let efectivo = false;
    const tocaEstado = "etapa_embudo" in valores || "motivo_perdida" in valores || "resultado_bdc" in valores;
    let contactoForzado: string | null = null;
    const respuesta = (claves.respuesta_titular ?? null) as RespuestaTitular | null;
    if (respuesta) {
      const motivoNI = (claves.motivo_no_interes ?? null) as MotivoNoInteres | null;
      const ef = efectoRespuesta(respuesta, motivoNI, actual.resultado_bdc as ResultadoBdc);
      if (ef.resultado && !tocaEstado) {
        resultadoPorRespuesta = ef.resultado;
        motivoForzado = ef.motivo ?? undefined;
      }
      if (ef.marcas.declara_ge && !("declara_ge" in valores)) asignar("declara_ge", true);
      if (ef.marcas.conserva_auto === false && !("conserva_auto" in valores)) asignar("conserva_auto", false);
      if (ef.marcas.escalar_posventa && !("escalar_posventa" in valores)) asignar("escalar_posventa", true);
      if (ef.marcas.no_contactar) noContactar = true;
      efectivo = claves.respuesta_titular !== undefined && claves.respuesta_titular !== actual.respuesta_titular;
    }
    if (claves.clasificacion_respuesta) {
      const ef = efectoClasificacion(claves.clasificacion_respuesta as ClasificacionRespuesta);
      if (ef.noContactar) noContactar = true;
      // Número equivocado: el teléfono queda no contactable, como en la llamada; cerrar la campaña lo decide el ejecutivo.
      if (ef.numeroEquivocado) contactoForzado = "no_contactable";
      if (ef.efectivo) {
        efectivo = true;
        // Escribió el titular y el lead seguía sin contacto efectivo: «Solicita info por WhatsApp» (pasa a Contactado).
        if (
          !tocaEstado &&
          !resultadoPorRespuesta &&
          actual.estado === "abierta" &&
          actual.estado_cartera === "ACTIVA" &&
          actual.estado_contacto !== "baja" &&
          !actual.contacto_baja &&
          SIN_CONTACTO_EFECTIVO.has(actual.resultado_bdc as ResultadoBdc)
        ) {
          resultadoPorRespuesta = "SOLICITA INFO WHATSAPP";
        }
      }
    }
    if (noContactar && !resultadoPorRespuesta && !tocaEstado && actual.estado !== "ganada") {
      resultadoPorRespuesta = "NO CONTACTABLE";
      motivoForzado = "pidio_baja";
    }
    if (efectivo && !params.sinMarcarContacto) sets.push("ultimo_contacto_efectivo_en = now()");

    // ---- Estado de contacto ----
    if ("estado_contacto" in valores) {
      const etiqueta = valores.estado_contacto as string | null;
      const clave = etiqueta ? ESTADOS_CONTACTO[etiqueta] : undefined;
      if (!clave) {
        return { ok: false, estado: 400, error: "Estado de contacto inválido." };
      }
      if (actual.contacto_baja && clave !== "baja") {
        return { ok: false, estado: 400, error: "Esta persona pidió no ser contactada: su contacto se queda en «Baja»." };
      }
      asignar("estado_contacto", clave);
    }

    // ---- Resultado BDC: decide el estado del lead, el motivo de pérdida y el contacto ----
    let resultadoElegido: ResultadoBdc | null = null;
    if ("resultado_bdc" in valores) {
      if (!esResultadoBdc(valores.resultado_bdc)) {
        return { ok: false, estado: 400, error: "Resultado BDC inválido." };
      }
      if ("etapa_embudo" in valores || "motivo_perdida" in valores) {
        return { ok: false, estado: 400, error: "Cambia el resultado o el estado del lead, no los dos a la vez." };
      }
      resultadoElegido = valores.resultado_bdc;
    } else if (resultadoPorRespuesta) {
      resultadoElegido = resultadoPorRespuesta;
    }
    if (resultadoElegido) {
      asignar("resultado_bdc", resultadoElegido);
      const contacto = noContactar ? "baja" : DESTINO_DE_RESULTADO[resultadoElegido].contacto;
      if (contacto && (noContactar || (actual.estado_contacto !== "baja" && !actual.contacto_baja)) && !("estado_contacto" in valores)) {
        asignar("estado_contacto", contacto);
      }
    } else if (!("estado_contacto" in valores)) {
      // Una venta conserva su estado de contacto: la baja queda en la persona (y en sus demás leads).
      if (noContactar) {
        if (actual.estado !== "ganada") asignar("estado_contacto", "baja");
      }
      else if (contactoForzado && actual.estado_contacto !== "baja") asignar("estado_contacto", contactoForzado);
      else if (efectivo && ["sin_intentar", "intentando", "buzon"].includes(actual.estado_contacto)) asignar("estado_contacto", "contactado");
    }

    // ---- Etapa ----
    let etapaDestinoId: string = actual.etapa_id;
    let tipoDestino: string = actual.tipo_etapa ?? "abierta";
    let etapaCambio = false;

    if ("etapa_embudo" in valores || resultadoElegido) {
      const nombre = valores.etapa_embudo as string | null;
      const { rows: etapas } = resultadoElegido
        ? await cliente.query(`SELECT id, tipo FROM crm_etapas WHERE sucursal_id = $1 AND clave = $2 AND activa`, [
            sucursalId,
            DESTINO_DE_RESULTADO[resultadoElegido].etapa,
          ])
        : nombre
          ? await cliente.query(
              `SELECT id, tipo FROM crm_etapas WHERE sucursal_id = $1 AND nombre = $2 AND activa`,
              [sucursalId, nombre],
            )
          : { rows: [] };
      if (!etapas[0]) {
        return {
          ok: false,
          estado: 400,
          error: resultadoElegido ? "Esta sucursal no tiene el estado del lead que corresponde a ese resultado." : "Ese estado del lead no existe.",
        };
      }
      etapaDestinoId = etapas[0].id as string;
      tipoDestino = etapas[0].tipo as string;
      etapaCambio = etapaDestinoId !== actual.etapa_id;

      if (etapaCambio && tipoDestino === "ganada") {
        const falta = await evidenciaFaltante(cliente, sucursalId, oportunidadId);
        if (falta) {
          return { ok: false, estado: 400, error: falta };
        }
      }

      if (etapaCambio) {
        const { rows: pos } = await cliente.query(
          `SELECT coalesce(max(posicion), 0) + 1024 AS p FROM crm_oportunidades WHERE etapa_id = $1`,
          [etapaDestinoId],
        );
        asignar("etapa_id", etapaDestinoId);
        asignar("posicion", pos[0].p);
        asignar("estado", tipoDestino);
        sets.push(`entro_a_etapa_en = now()`);
        sets.push(tipoDestino === "abierta" ? `cerrada_en = NULL` : `cerrada_en = now()`);
        if (tipoDestino !== "perdida") sets.push(`motivo_perdida_id = NULL`);
      }
    }

    // ---- Motivo de pérdida ----
    let motivoId: string | null = actual.motivo_perdida_id;
    const motivoDelResultado = resultadoElegido ? (motivoForzado ?? DESTINO_DE_RESULTADO[resultadoElegido].motivo) : undefined;
    if (motivoDelResultado) {
      motivoId = await asegurarMotivo(cliente, sucursalId, motivoDelResultado);
      asignar("motivo_perdida_id", motivoId);
    } else if ("motivo_perdida" in valores) {
      if (tipoDestino !== "perdida") {
        return { ok: false, estado: 400, error: "Solo una oportunidad perdida lleva motivo de pérdida." };
      }
      const nombre = valores.motivo_perdida as string | null;
      motivoId = null;
      if (nombre) {
        const { rows } = await cliente.query(
          `SELECT id, clave FROM crm_motivos_perdida WHERE sucursal_id = $1 AND nombre = $2 AND activo`,
          [sucursalId, nombre],
        );
        if (!rows[0]) {
          return { ok: false, estado: 400, error: "El motivo de pérdida no existe." };
        }
        if (rows[0].clave === "pidio_baja") return { ok: false, estado: 400, error: "«Pidió baja» se registra con «Pidió no ser contactado» en la ficha." };
        motivoId = rows[0].id as string;
      }
      asignar("motivo_perdida_id", motivoId);
    }

    // El kilometraje es del vehículo (lo comparten todas sus oportunidades) y cambia su etapa del vehículo.
    let kmNuevo: number | null | undefined;
    if ("kilometraje" in valores) {
      const v = valores.kilometraje;
      kmNuevo = v === null || v === undefined || v === "" ? null : Number(v);
      if (kmNuevo !== null && (!Number.isInteger(kmNuevo) || kmNuevo < 0 || kmNuevo > 5_000_000)) {
        return { ok: false, estado: 400, error: "El kilometraje debe ser un número entero entre 0 y 5,000,000." };
      }
    }

    if (sets.length === 0 && kmNuevo === undefined) {
      return { ok: false, estado: 400, error: "No hay nada que actualizar." };
    }

    if (sets.length > 0) {
      args.push(oportunidadId, sucursalId);
      await cliente.query(
        `UPDATE crm_oportunidades SET ${sets.join(", ")} WHERE id = $${args.length - 1} AND sucursal_id = $${args.length}`,
        args,
      );
    }
    if (kmNuevo !== undefined) {
      await cliente.query(`UPDATE crm_vehiculos SET kilometraje = $3, kilometraje_actualizado_en = now() WHERE id = $1 AND sucursal_id = $2`, [
        actual.vehiculo_id,
        sucursalId,
        kmNuevo,
      ]);
      await recalcularEtapas(cliente, sucursalId, actual.vehiculo_id as string);
    }

    // Auditoría: cada campo que cambió queda en la línea de tiempo con su valor anterior y el nuevo.
    const autorEdicion = await autorValido(cliente, usuarioId);
    const cambios: { campo: string; anterior: unknown; nuevo: unknown }[] = [];
    for (const campo of ["comentarios", "fecha_ultimo_contacto", "fecha_compra", "ejecutivo"] as const) {
      if (campo in valores && (valores[campo] ?? null) !== (actual[campo] ?? null)) {
        cambios.push({ campo, anterior: actual[campo] ?? null, nuevo: valores[campo] ?? null });
      }
    }
    if (kmNuevo !== undefined && (kmNuevo ?? null) !== (actual.kilometraje ?? null)) {
      cambios.push({ campo: "kilometraje", anterior: actual.kilometraje ?? null, nuevo: kmNuevo });
    }
    if ("estado_contacto" in valores) {
      const anterior = ETIQUETA_DE_ESTADO[actual.estado_contacto as string] ?? null;
      if (anterior !== valores.estado_contacto) cambios.push({ campo: "estado_contacto", anterior, nuevo: valores.estado_contacto });
    }
    if (resultadoElegido && resultadoElegido !== actual.resultado_bdc) {
      cambios.push({ campo: "resultado_bdc", anterior: actual.resultado_bdc, nuevo: resultadoElegido });
    }
    for (const campo of Object.keys(CAMPOS_GESTION)) {
      if (campo in valores && !mismoValor(actual[campo], valores[campo] === "" ? null : valores[campo])) {
        cambios.push({ campo, anterior: actual[campo] ?? null, nuevo: valores[campo] === "" ? null : (valores[campo] ?? null) });
      }
    }
    const etiqueta = (cat: Catalogo, clave: string | null) => (clave ? (catalogos?.[cat].find((o) => o.clave === clave)?.etiqueta ?? clave) : null);
    for (const cat of NOMBRES_CATALOGO) {
      if (claves[cat] !== undefined && claves[cat] !== (actual[cat] ?? null)) {
        cambios.push({ campo: cat, anterior: etiqueta(cat, actual[cat] ?? null), nuevo: etiqueta(cat, claves[cat] ?? null) });
      }
    }
    if (noContactar) {
      await marcarNoContactar(cliente, sucursalId, oportunidadId, params.canalBaja ?? (claves.clasificacion_respuesta ? "whatsapp" : null));
    } else if (ESTADOS_CONTACTO[valores.estado_contacto as string] === "baja") {
      // Poner «Baja» a mano en el contacto es lo mismo: la persona deja de recibir mensajes en todos sus leads.
      await marcarNoContactar(cliente, sucursalId, oportunidadId, "llamada");
    }
    for (const c of cambios) {
      await cliente.query(
        `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sucursalId, oportunidadId, c.campo === "ejecutivo" ? "reasignacion" : "edicion", TITULO_CAMPO[c.campo] ?? c.campo, c, autorEdicion],
      );
    }

    if (etapaCambio) {
      // El historial referencia a public.usuarios: quien no tenga fila ahí (ej. un admin de plataforma) queda sin autor.
      const autor = autorEdicion;
      await cliente.query(
        `INSERT INTO crm_historial_etapas
           (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, motivo_perdida_id, usuario_id, origen)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
        [sucursalId, oportunidadId, actual.etapa_id, etapaDestinoId, tipoDestino === "perdida" ? motivoId : null, autor],
      );
    }

    // Cambiar el estado o el motivo a mano pone el resultado que les corresponde.
    if (!resultadoElegido && (etapaCambio || "motivo_perdida" in valores)) await ajustarResultados(cliente, sucursalId, [oportunidadId]);

    // Marcarlo como «Contactado» a mano también lo saca de «Por contactar» (si no se eligió otro estado a la vez).
    const dadoDeBaja = actual.estado_contacto === "baja" || actual.contacto_baja === true;
    if (!etapaCambio && (ESTADOS_CONTACTO[valores.estado_contacto as string] === "contactado" || (efectivo && !noContactar && !dadoDeBaja))) {
      etapaCambio = await avanzarPorContacto(cliente, sucursalId, oportunidadId);
    }
    // Primer contacto de la campaña: solo si esta edición fue un contacto (respuesta o clasificación del titular, contacto
    // marcado a mano o un resultado trabajado nuevo), no cualquier cambio de un lead ya contactado.
    const huboContacto =
      efectivo ||
      ESTADOS_CONTACTO[valores.estado_contacto as string] === "contactado" ||
      (resultadoElegido !== null && resultadoElegido !== actual.resultado_bdc && DESTINO_DE_RESULTADO[resultadoElegido].contacto === "contactado");
    if (huboContacto) await marcarPrimerContacto(cliente, sucursalId, oportunidadId);

    return { ok: true, etapaCambio };
  }
}

/** Etapas del embudo de la sucursal, en orden (para dibujar las columnas del tablero). */
export async function listarEtapas(sucursalId: string) {
  const { rows } = await getPool().query(
    `SELECT id, nombre, color, tipo, orden, tiempo_max_horas FROM crm_etapas WHERE sucursal_id = $1 AND activa ORDER BY orden`,
    [sucursalId],
  );
  return rows as { id: string; nombre: string; color: string; tipo: string; orden: number; tiempo_max_horas: number | null }[];
}

export type ResultadoMover = { ok: true } | { ok: false; estado: 404 | 400; error: string };

const SEPARACION = 1024;

/**
 * Mueve una tarjeta del tablero: a otra etapa o a otro lugar de la misma. `antesId`
 * es la tarjeta delante de la cual queda; sin ella, va al final de la columna. La
 * posición es un número entre sus vecinas, así un movimiento toca solo una fila.
 * Si cae en Perdido puede traer motivo; mover fuera de Perdido lo limpia.
 */
export async function moverOportunidad(params: {
  sucursalId: string;
  oportunidadId: string;
  etapaId: string;
  antesId?: string | null;
  motivoPerdida?: string | null;
  usuarioId?: string;
}): Promise<ResultadoMover> {
  const { sucursalId, oportunidadId, etapaId, antesId, motivoPerdida, usuarioId } = params;
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");

    const { rows: filas } = await cliente.query(
      `SELECT id, etapa_id, motivo_perdida_id FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2 FOR UPDATE`,
      [oportunidadId, sucursalId],
    );
    const actual = filas[0];
    if (!actual) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }

    const { rows: etapas } = await cliente.query(
      `SELECT id, tipo FROM crm_etapas WHERE id = $1 AND sucursal_id = $2 AND activa`,
      [etapaId, sucursalId],
    );
    if (!etapas[0]) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 400, error: "Ese estado del lead no existe." };
    }
    const tipo = etapas[0].tipo as string;
    const cambioEtapa = etapaId !== actual.etapa_id;
    if (cambioEtapa && tipo === "ganada") {
      const falta = await evidenciaFaltante(cliente, sucursalId, oportunidadId);
      if (falta) {
        await cliente.query("ROLLBACK");
        return { ok: false, estado: 400, error: falta };
      }
    }

    // Posición entre las vecinas de la columna destino (sin contar la propia tarjeta).
    let posicion: number;
    if (antesId) {
      const { rows: ref } = await cliente.query(
        `SELECT posicion FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2 AND etapa_id = $3`,
        [antesId, sucursalId, etapaId],
      );
      if (!ref[0]) {
        await cliente.query("ROLLBACK");
        return { ok: false, estado: 400, error: "La tarjeta de referencia no está en ese estado." };
      }
      const siguiente = ref[0].posicion as number;
      const { rows: prev } = await cliente.query(
        `SELECT max(posicion) AS p FROM crm_oportunidades WHERE etapa_id = $1 AND posicion < $2 AND id <> $3`,
        [etapaId, siguiente, oportunidadId],
      );
      const anterior = prev[0].p as number | null;
      posicion = anterior === null ? siguiente - SEPARACION : (anterior + siguiente) / 2;
      // Sin espacio numérico entre vecinas: se renumera la columna completa y se vuelve a calcular.
      if (anterior !== null && siguiente - anterior < 1e-6) {
        await cliente.query(
          `UPDATE crm_oportunidades o SET posicion = r.n * $2
             FROM (SELECT id, row_number() OVER (ORDER BY posicion, id) AS n FROM crm_oportunidades WHERE etapa_id = $1) r
            WHERE o.id = r.id`,
          [etapaId, SEPARACION],
        );
        const { rows: ref2 } = await cliente.query(`SELECT posicion FROM crm_oportunidades WHERE id = $1`, [antesId]);
        const { rows: prev2 } = await cliente.query(
          `SELECT max(posicion) AS p FROM crm_oportunidades WHERE etapa_id = $1 AND posicion < $2 AND id <> $3`,
          [etapaId, ref2[0].posicion, oportunidadId],
        );
        posicion = prev2[0].p === null ? ref2[0].posicion - SEPARACION : (prev2[0].p + ref2[0].posicion) / 2;
      }
    } else {
      const { rows: fin } = await cliente.query(
        `SELECT coalesce(max(posicion), 0) + $2 AS p FROM crm_oportunidades WHERE etapa_id = $1 AND id <> $3`,
        [etapaId, SEPARACION, oportunidadId],
      );
      posicion = fin[0].p as number;
    }

    let motivoId: string | null = null;
    if (tipo === "perdida") {
      if (motivoPerdida) {
        const { rows } = await cliente.query(
          `SELECT id, clave FROM crm_motivos_perdida WHERE sucursal_id = $1 AND nombre = $2 AND activo`,
          [sucursalId, motivoPerdida],
        );
        if (!rows[0] || rows[0].clave === "pidio_baja") {
          await cliente.query("ROLLBACK");
          return { ok: false, estado: 400, error: rows[0] ? "«Pidió baja» se registra con «Pidió no ser contactado» en la ficha." : "El motivo de pérdida no existe." };
        }
        motivoId = rows[0].id as string;
      } else if (!cambioEtapa) {
        motivoId = actual.motivo_perdida_id; // reordenar dentro de Perdido no borra su motivo
      }
    }

    if (cambioEtapa) {
      await cliente.query(
        `UPDATE crm_oportunidades
            SET etapa_id = $3, posicion = $4, estado = $5, motivo_perdida_id = $6, entro_a_etapa_en = now(),
                cerrada_en = CASE WHEN $5 = 'abierta' THEN NULL ELSE now() END
          WHERE id = $1 AND sucursal_id = $2`,
        [oportunidadId, sucursalId, etapaId, posicion, tipo, motivoId],
      );
      const autor = usuarioId
        ? (await cliente.query(`SELECT id FROM usuarios WHERE id = $1`, [usuarioId])).rows[0]?.id ?? null
        : null;
      await cliente.query(
        `INSERT INTO crm_historial_etapas
           (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, motivo_perdida_id, usuario_id, origen)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
        [sucursalId, oportunidadId, actual.etapa_id, etapaId, motivoId, autor],
      );
    } else {
      await cliente.query(
        `UPDATE crm_oportunidades SET posicion = $3, motivo_perdida_id = coalesce($4, motivo_perdida_id)
          WHERE id = $1 AND sucursal_id = $2`,
        [oportunidadId, sucursalId, posicion, motivoId],
      );
    }
    // Moverlo de estado (o cambiarle el motivo en Perdido) pone el resultado que corresponde.
    if (cambioEtapa || motivoId !== actual.motivo_perdida_id) await ajustarResultados(cliente, sucursalId, [oportunidadId]);

    await cliente.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}
