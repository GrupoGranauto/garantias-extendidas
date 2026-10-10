import { getPool } from "./db.js";
import { configPorSucursalId, enviarMensaje, ErrorEnvioMeta } from "./whatsapp.js";
import { emitirEventoChat } from "./eventosChat.js";
import { ZONA_ENVIOS, ahoraLocal, dentroDeVentana, sanearParametro, siguienteApertura, telefono10 } from "./campanasLogica.js";
import { RESULTADOS_BDC } from "./resultadoBdcLogica.js";
import {
  MAX_DESTINATARIOS,
  TEXTO_MOTIVO,
  VENTANA_MASIVOS,
  clasificarDestinatarios,
  contarOmitidos,
  etiquetaCampana,
  indicesCuerpo,
  llenarCuerpo,
  motivoPorReglas,
  ordenCampana,
  plantillaNoUsable,
  vistaMensaje,
  type Componentes,
  type DatosLead,
  type Destinatario,
  type ReglasPlantilla,
} from "./masivosLogica.js";

/**
 * Masivos manuales de WhatsApp. El admin del grupo elige filas en la Base de Datos y una plantilla aprobada:
 *  - revisarMasivo: cuántos sí lo reciben, por qué se omite a los demás y cómo se ve el mensaje (no guarda nada);
 *  - crearMasivo: deja cada fila como un envío del masivo, con los datos de la plantilla congelados, y vuelve enseguida;
 *  - despacharMasivos: el motor del servidor los manda en segundo plano, uno por uno, dentro del horario.
 * Respeta lo de siempre: la baja gana, un mensaje por teléfono al día y nunca se manda dos veces el mismo mensaje.
 */

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export type Resultado<T> = { ok: true; valor: T } | { ok: false; error: string };

/** Fecha de la base (2026-10-09) como la lee el cliente (09/10/2026). */
const dd = (v: unknown): string => {
  const s = String(v ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};

type Plantilla = {
  id: string;
  nombre: string;
  nombre_tecnico: string;
  idioma: string;
  estado: string;
  componentes: Componentes | null;
  variables: { indice: number; columna: string }[];
  reglas: ReglasPlantilla;
};

const SQL_PLANTILLA = `
  SELECT p.id, coalesce(p.nombre, p.nombre_tecnico) AS nombre, p.nombre_tecnico, p.idioma, p.estado, p.componentes,
         coalesce((SELECT json_agg(json_build_object('indice', v.indice, 'columna', v.columna_tecnica) ORDER BY v.indice)
                     FROM whatsapp_plantilla_variables v WHERE v.plantilla_id = p.id), '[]'::json) AS variables,
         coalesce(r.campanas, '{}') AS r_campanas, coalesce(r.estados::text[], '{}') AS r_estados,
         coalesce(r.resultados, '{}') AS r_resultados, coalesce(r.etapas_vehiculo::text[], '{}') AS r_etapas_vehiculo
    FROM whatsapp_plantillas p
    LEFT JOIN crm_plantilla_reglas r ON r.plantilla_id = p.id`;

const aPlantilla = (r: Record<string, any>): Plantilla => ({
  id: r.id,
  nombre: r.nombre,
  nombre_tecnico: r.nombre_tecnico,
  idioma: r.idioma,
  estado: r.estado,
  componentes: r.componentes,
  variables: r.variables,
  reglas: { campanas: r.r_campanas, estados: r.r_estados, resultados: r.r_resultados, etapasVehiculo: r.r_etapas_vehiculo },
});

/** Lo del lead que se compara con las reglas de una plantilla. */
const SQL_DATOS_LEAD = `o.campana AS campana_lead, o.etapa_id::text AS estado_id, o.resultado_bdc, veh.etapa_vehiculo_id::text AS etapa_vehiculo_id`;
const aDatosLead = (r: Record<string, any>): DatosLead => ({
  campana: r.campana_lead ?? null,
  estadoId: r.estado_id ?? null,
  resultado: r.resultado_bdc ?? null,
  etapaVehiculoId: r.etapa_vehiculo_id ?? null,
});

/**
 * Lo que necesita la ventana de envío para las filas elegidas: las plantillas aprobadas (con sus reglas, a cuántas de las
 * filas elegidas les corresponde cada una y, si no sirve para un masivo, por qué), las campañas para el filtro rápido
 * (con cuántas de las filas elegidas son de cada una) y los estados del lead para agrupar.
 */
export async function opcionesMasivo(sucursalId: string, ids: string[]) {
  const pool = getPool();
  const unicos = [...new Set(ids)].slice(0, MAX_DESTINATARIOS);
  const [ps, leads, estados, etapas] = await Promise.all([
    pool.query(`${SQL_PLANTILLA} WHERE p.sucursal_id = $1 AND p.estado = 'aprobada' ORDER BY 2`, [sucursalId]),
    pool.query(
      `SELECT ${SQL_DATOS_LEAD} FROM crm_oportunidades o JOIN crm_vehiculos veh ON veh.id = o.vehiculo_id
        WHERE o.sucursal_id = $1 AND o.id = ANY($2::uuid[])`,
      [sucursalId, unicos],
    ),
    pool.query(`SELECT id::text AS id, nombre, color FROM crm_etapas WHERE sucursal_id = $1 AND activa ORDER BY orden`, [sucursalId]),
    pool.query(`SELECT id::text AS id, nombre FROM crm_ciclo_etapas WHERE sucursal_id = $1 ORDER BY orden`, [sucursalId]),
  ]);
  const etapasVehiculo = etapas.rows;
  const datos = leads.rows.map(aDatosLead);

  const plantillas = ps.rows.map(aPlantilla).map((p) => {
    const cuerpo = p.componentes?.body?.texto ?? "";
    // En la vista de la lista, cada dato se ve como [columna]: los valores reales salen de cada fila al revisar.
    const marcas = indicesCuerpo(cuerpo).map((i) => `[${p.variables.find((v) => v.indice === i)?.columna ?? `dato ${i}`}]`);
    return {
      id: p.id,
      nombre: p.nombre,
      no_usable: plantillaNoUsable(p, p.variables.map((v) => v.indice)),
      vista: p.componentes ? vistaMensaje(p.componentes, marcas) : null,
      reglas: p.reglas,
      coinciden: datos.filter((d) => !motivoPorReglas(p.reglas, d)).length,
    };
  });

  const porCampana = new Map<string, number>();
  for (const d of datos) if (d.campana) porCampana.set(d.campana, (porCampana.get(d.campana) ?? 0) + 1);
  const codigos = new Set([...porCampana.keys(), ...plantillas.flatMap((p) => p.reglas.campanas)]);
  const campanas = [...codigos]
    .sort((a, b) => ordenCampana(a) - ordenCampana(b) || a.localeCompare(b))
    .map((c) => ({ valor: c, etiqueta: etiquetaCampana(c), n: porCampana.get(c) ?? 0 }));

  return { plantillas, campanas, estados: estados.rows, etapas_vehiculo: etapasVehiculo };
}

const capitalizar = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

/** Para la pantalla Plantillas: las opciones de cada regla (campañas, estados, resultados, etapas del vehículo) y las reglas de cada plantilla. */
export async function reglasDePlantillas(sucursalId: string) {
  const pool = getPool();
  const [campanas, estados, etapas, reglas] = await Promise.all([
    pool.query(`SELECT DISTINCT campana FROM crm_oportunidades WHERE sucursal_id = $1 AND campana IS NOT NULL AND campana <> ''`, [sucursalId]),
    pool.query(`SELECT id::text AS valor, nombre AS etiqueta, color FROM crm_etapas WHERE sucursal_id = $1 AND activa ORDER BY orden`, [sucursalId]),
    pool.query(`SELECT id::text AS valor, nombre AS etiqueta FROM crm_ciclo_etapas WHERE sucursal_id = $1 ORDER BY orden`, [sucursalId]),
    pool.query(
      `SELECT plantilla_id, campanas, estados::text[] AS estados, resultados, etapas_vehiculo::text[] AS etapas_vehiculo
         FROM crm_plantilla_reglas WHERE sucursal_id = $1`,
      [sucursalId],
    ),
  ]);
  return {
    catalogo: {
      campanas: campanas.rows
        .map((r) => r.campana as string)
        .sort((a, b) => ordenCampana(a) - ordenCampana(b) || a.localeCompare(b))
        .map((c) => ({ valor: c, etiqueta: etiquetaCampana(c) })),
      estados: estados.rows,
      resultados: RESULTADOS_BDC.map((r) => ({ valor: r, etiqueta: capitalizar(r) })),
      etapas_vehiculo: etapas.rows,
    },
    reglas: Object.fromEntries(
      reglas.rows.map((r) => [
        r.plantilla_id as string,
        { campanas: r.campanas as string[], estados: r.estados as string[], resultados: r.resultados as string[], etapas_vehiculo: r.etapas_vehiculo as string[] },
      ]),
    ),
  };
}

/** Guarda a quién se le puede mandar una plantilla. Solo acepta valores que existen en el grupo. */
export async function guardarReglas(
  sucursalId: string,
  plantillaId: string,
  r: { campanas: string[]; estados: string[]; resultados: string[]; etapas_vehiculo: string[] },
): Promise<Resultado<null>> {
  const pool = getPool();
  const { rows: p } = await pool.query(`SELECT 1 FROM whatsapp_plantillas WHERE id = $1 AND sucursal_id = $2`, [plantillaId, sucursalId]);
  if (!p[0]) return { ok: false, error: "No se encontró la plantilla." };
  const unicos = (xs: string[]) => [...new Set(xs)];
  const estados = unicos(r.estados);
  const etapas = unicos(r.etapas_vehiculo);
  const resultados = unicos(r.resultados);
  if (resultados.some((x) => !(RESULTADOS_BDC as readonly string[]).includes(x))) return { ok: false, error: "Hay un Resultado BDC que no existe." };
  if (estados.length > 0) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM crm_etapas WHERE sucursal_id = $1 AND id = ANY($2::uuid[])`, [sucursalId, estados]);
    if (rows[0].n !== estados.length) return { ok: false, error: "Hay un estado del lead que no existe en este grupo." };
  }
  if (etapas.length > 0) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM crm_ciclo_etapas WHERE sucursal_id = $1 AND id = ANY($2::uuid[])`, [sucursalId, etapas]);
    if (rows[0].n !== etapas.length) return { ok: false, error: "Hay una etapa del vehículo que no existe en este grupo." };
  }
  await pool.query(
    `INSERT INTO crm_plantilla_reglas (plantilla_id, sucursal_id, campanas, estados, resultados, etapas_vehiculo, actualizado_en)
     VALUES ($1, $2, $3, $4::uuid[], $5, $6::uuid[], now())
     ON CONFLICT (plantilla_id) DO UPDATE SET campanas = excluded.campanas, estados = excluded.estados, resultados = excluded.resultados,
            etapas_vehiculo = excluded.etapas_vehiculo, actualizado_en = now()`,
    [plantillaId, sucursalId, unicos(r.campanas), estados, resultados, etapas],
  );
  return { ok: true, valor: null };
}

type Preparado = {
  plantilla: Plantilla;
  filas: { id: string; campana: string; cliente: string | null; parametros: string[] }[];
  destinatarios: Destinatario[];
  noEncontradas: number;
};

/** Carga la plantilla y las filas elegidas, arma los datos de cada mensaje y decide a quién sí le sale. */
async function preparar(cl: Consulta, sucursalId: string, ids: string[], plantillaId: string): Promise<Resultado<Preparado>> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return { ok: false, error: "Elige al menos una fila." };
  if (unicos.length > MAX_DESTINATARIOS) return { ok: false, error: `Un masivo puede llevar hasta ${MAX_DESTINATARIOS.toLocaleString("es-MX")} filas.` };

  const { rows: ps } = await cl.query(`${SQL_PLANTILLA} WHERE p.sucursal_id = $1 AND p.id = $2`, [sucursalId, plantillaId]);
  const plantilla = ps[0] ? aPlantilla(ps[0]) : undefined;
  if (!plantilla) return { ok: false, error: "No se encontró la plantilla." };
  const noUsable = plantillaNoUsable(plantilla, plantilla.variables.map((v) => v.indice));
  if (noUsable) return { ok: false, error: `Esta plantilla no se puede mandar: ${noUsable}` };
  const config = await configPorSucursalId(sucursalId).catch(() => null);
  if (!config || !config.activo) return { ok: false, error: "Primero hay que configurar y activar WhatsApp en este grupo." };

  const { rows } = await cl.query(
    `SELECT o.id, coalesce(o.campana, 'MASIVO') AS campana, o.estado_contacto, c.nombre AS cliente, c.telefono, c.tiene_celular,
            c.whatsapp_baja, to_jsonb(v) AS fila, ${SQL_DATOS_LEAD}
       FROM crm_oportunidades o
       JOIN crm_contactos c ON c.id = o.contacto_id
       JOIN crm_vehiculos veh ON veh.id = o.vehiculo_id
       JOIN crm_v_oportunidades v ON v.id = o.id
      WHERE o.sucursal_id = $1 AND o.id = ANY($2::uuid[])
      ORDER BY array_position($2::uuid[], o.id)`,
    [sucursalId, unicos],
  );

  const indices = indicesCuerpo(plantilla.componentes!.body!.texto);
  const columnaDe = new Map(plantilla.variables.map((v) => [v.indice, v.columna]));
  const filas = rows.map((r) => {
    const fila = (r.fila ?? {}) as Record<string, unknown>;
    const parametros = indices.map((i) => {
      const valor = fila[columnaDe.get(i) ?? ""];
      return valor === null || valor === undefined ? "" : sanearParametro(dd(valor));
    });
    return { id: r.id as string, campana: r.campana as string, cliente: (r.cliente as string | null) ?? null, parametros, r };
  });

  // Teléfonos que ya recibieron un mensaje hoy, o que lo tienen en cola en otro masivo.
  const { rows: ocupados } = await cl.query(
    `SELECT DISTINCT right(regexp_replace(coalesce(c.telefono, ''), '\\D', '', 'g'), 10) AS t
       FROM crm_envios e
       JOIN crm_oportunidades o ON o.id = e.oportunidad_id
       JOIN crm_contactos c ON c.id = o.contacto_id
      WHERE e.sucursal_id = $1
        AND ((e.estado IN ('enviado', 'entregado', 'leido') AND (e.enviado_en AT TIME ZONE '${ZONA_ENVIOS}')::date = $2::date)
             OR (e.estado = 'pendiente' AND e.masivo_id IS NOT NULL))`,
    [sucursalId, ahoraLocal().fecha],
  );

  const destinatarios = clasificarDestinatarios(
    filas.map((f) => ({
      oportunidadId: f.id,
      fueraDeReglas: motivoPorReglas(plantilla.reglas, aDatosLead(f.r)),
      telefono: f.r.telefono,
      tieneCelular: (f.r.tiene_celular as boolean | null) ?? null,
      baja: f.r.whatsapp_baja === true,
      estadoContacto: (f.r.estado_contacto as string | null) ?? null,
      parametros: f.parametros,
    })),
    new Set(ocupados.map((o) => o.t as string)),
  );

  return {
    ok: true,
    valor: {
      plantilla,
      filas: filas.map(({ id, campana, cliente, parametros }) => ({ id, campana, cliente, parametros })),
      destinatarios,
      noEncontradas: unicos.length - rows.length,
    },
  };
}

/** Cuándo empiezan a salir: null si es ahora (dentro del horario), o la próxima apertura (fecha y hora de Hermosillo). */
function salida(): { fecha: string; hora: string } | null {
  const ahora = ahoraLocal();
  return dentroDeVentana(ahora, VENTANA_MASIVOS) ? null : siguienteApertura(ahora, VENTANA_MASIVOS);
}

function resumen(p: Preparado) {
  const enviar = p.destinatarios.filter((d) => !d.motivo).length;
  const omitidos = Object.entries(contarOmitidos(p.destinatarios)).map(([motivo, n]) => ({ motivo, texto: TEXTO_MOTIVO[motivo] ?? motivo, n }));
  if (p.noEncontradas > 0) omitidos.push({ motivo: "no_encontrada", texto: "ya no están en la base", n: p.noEncontradas });
  // El ejemplo es el primero que sí lo recibe (o el primero elegido, si nadie): así se ve el mensaje con datos reales.
  const i = Math.max(0, p.destinatarios.findIndex((d) => !d.motivo));
  const f = p.filas[i];
  return {
    enviar,
    omitidos,
    ejemplo: f ? { cliente: f.cliente, ...vistaMensaje(p.plantilla.componentes!, f.parametros) } : null,
    sale: salida(),
    horario: { inicio: VENTANA_MASIVOS.hora_inicio, fin: VENTANA_MASIVOS.hora_fin },
  };
}

/** Lo que pasaría al mandar: a cuántos sale, a quién se omite y por qué, y el mensaje de ejemplo. No guarda nada. */
export async function revisarMasivo(sucursalId: string, ids: string[], plantillaId: string) {
  const p = await preparar(getPool(), sucursalId, ids, plantillaId);
  if (!p.ok) return p;
  return { ok: true as const, valor: resumen(p.valor) };
}

/** Deja el masivo en cola y vuelve enseguida; el motor lo manda. */
export async function crearMasivo(sucursalId: string, ids: string[], plantillaId: string, usuarioId: string | null) {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    // Dos admins mandando a la vez no deben esquivar la regla de un mensaje por teléfono al día.
    await cliente.query(`SELECT pg_advisory_xact_lock(hashtext('masivo:' || $1))`, [sucursalId]);
    const p = await preparar(cliente, sucursalId, ids, plantillaId);
    if (!p.ok) {
      await cliente.query("ROLLBACK");
      return p;
    }
    const r = resumen(p.valor);
    if (r.enviar === 0) {
      await cliente.query("ROLLBACK");
      return { ok: false as const, error: "Ninguna de las filas elegidas puede recibir el mensaje." };
    }

    const { rows } = await cliente.query(
      `INSERT INTO crm_masivos (sucursal_id, plantilla_id, plantilla_nombre, creado_por)
       VALUES ($1, $2, $3, (SELECT id FROM usuarios WHERE id = $4)) RETURNING id`,
      [sucursalId, p.valor.plantilla.id, p.valor.plantilla.nombre, usuarioId],
    );
    const masivoId = rows[0].id as string;
    const filas = p.valor.filas.map((f, i) => ({
      oportunidad_id: f.id,
      campana: f.campana,
      motivo: p.valor.destinatarios[i].motivo,
      parametros: p.valor.destinatarios[i].motivo ? null : f.parametros,
    }));
    await cliente.query(
      `INSERT INTO crm_envios (sucursal_id, oportunidad_id, campana, plantilla_id, programado_para, estado, motivo, masivo_id, parametros)
       SELECT $1, r.oportunidad_id, r.campana, $2,
              CASE WHEN $3::text IS NULL THEN now() ELSE ($3::timestamp AT TIME ZONE '${ZONA_ENVIOS}') END,
              CASE WHEN r.motivo IS NULL THEN 'pendiente' ELSE 'omitido' END, r.motivo, $4, r.parametros
         FROM jsonb_to_recordset($5::jsonb) AS r(oportunidad_id uuid, campana text, motivo text, parametros jsonb)`,
      [sucursalId, p.valor.plantilla.id, r.sale ? `${r.sale.fecha} ${r.sale.hora}:00` : null, masivoId, JSON.stringify(filas)],
    );
    await cliente.query("COMMIT");
    return { ok: true as const, valor: { id: masivoId, ...r } };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Los masivos del grupo, del más reciente al más viejo, con cómo va cada uno. */
export async function listarMasivos(sucursalId: string, limite = 30) {
  const { rows } = await getPool().query(
    `SELECT m.id, m.plantilla_nombre, m.estado, m.creado_en, m.terminado_en, u.nombre AS creado_por,
            count(e.id)::int AS total,
            count(e.id) FILTER (WHERE e.estado = 'pendiente')::int AS pendientes,
            count(e.id) FILTER (WHERE e.estado IN ('enviado', 'entregado', 'leido'))::int AS enviados,
            count(e.id) FILTER (WHERE e.estado IN ('entregado', 'leido'))::int AS entregados,
            count(e.id) FILTER (WHERE e.estado = 'leido')::int AS leidos,
            count(e.id) FILTER (WHERE e.estado = 'fallido')::int AS fallidos,
            count(e.id) FILTER (WHERE e.estado = 'omitido')::int AS omitidos,
            min(e.programado_para) FILTER (WHERE e.estado = 'pendiente') AS proximo
       FROM crm_masivos m
       LEFT JOIN usuarios u ON u.id = m.creado_por
       LEFT JOIN crm_envios e ON e.masivo_id = m.id
      WHERE m.sucursal_id = $1
      GROUP BY m.id, u.nombre
      ORDER BY m.creado_en DESC
      LIMIT $2`,
    [sucursalId, limite],
  );
  return rows;
}

/** Cada fila del masivo: a quién, en qué quedó y por qué no salió, si no salió. */
export async function destinatariosMasivo(sucursalId: string, masivoId: string) {
  const { rows } = await getPool().query(
    `SELECT e.oportunidad_id, v.cliente, v.telefono_principal AS telefono, v.vin, e.estado, e.motivo, e.error, e.enviado_en
       FROM crm_envios e
       JOIN crm_masivos m ON m.id = e.masivo_id
       JOIN crm_v_oportunidades v ON v.id = e.oportunidad_id
      WHERE m.id = $1 AND m.sucursal_id = $2
      ORDER BY CASE e.estado WHEN 'fallido' THEN 0 WHEN 'pendiente' THEN 1 WHEN 'omitido' THEN 3 ELSE 2 END, v.cliente
      LIMIT ${MAX_DESTINATARIOS}`,
    [masivoId, sucursalId],
  );
  return rows.map((r) => ({ ...r, motivo_texto: r.motivo ? (TEXTO_MOTIVO[r.motivo as string] ?? null) : null }));
}

/** Detiene un masivo: lo que todavía no salió ya no sale. Lo que ya se mandó no se puede deshacer. */
export async function detenerMasivo(sucursalId: string, masivoId: string): Promise<Resultado<{ detenidos: number }>> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rowCount } = await cliente.query(
      `UPDATE crm_masivos SET estado = 'detenido', terminado_en = now() WHERE id = $1 AND sucursal_id = $2 AND estado = 'enviando'`,
      [masivoId, sucursalId],
    );
    if (!rowCount) {
      await cliente.query("ROLLBACK");
      return { ok: false, error: "Este masivo ya terminó." };
    }
    // El que se está mandando en este momento («enviando») ya está en manos de WhatsApp: no se toca.
    const r = await cliente.query(
      `UPDATE crm_envios SET estado = 'omitido', motivo = 'detenido'
        WHERE masivo_id = $1 AND estado = 'pendiente' AND coalesce(motivo, '') <> 'enviando'`,
      [masivoId],
    );
    await cliente.query("COMMIT");
    return { ok: true, valor: { detenidos: r.rowCount ?? 0 } };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/* ============================================================
   Despacho (lo corre el motor del servidor desplegado)
   ============================================================ */

const MAX_INTENTOS = 3;

/** Cierra el masivo cuando ya no le queda nada en cola. */
async function cerrarSiTermino(masivoId: string) {
  await getPool().query(
    `UPDATE crm_masivos SET estado = 'terminado', terminado_en = now()
      WHERE id = $1 AND estado = 'enviando' AND NOT EXISTS (SELECT 1 FROM crm_envios WHERE masivo_id = $1 AND estado = 'pendiente')`,
    [masivoId],
  );
}

/** Deja el mensaje en el chat del cliente y en el historial del lead. Si falla, no deshace el envío (ya salió). */
async function registrarEnChat(
  e: { sucursal_id: string; oportunidad_id: string; masivo_id: string },
  conversacionId: string,
  waMessageId: string,
  texto: string,
  plantilla: string,
) {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO whatsapp_mensajes (conversacion_id, sucursal_id, wa_message_id, direccion, tipo, texto, estado)
       VALUES ($1, $2, $3, 'saliente', 'texto', $4, 'enviado')`,
      [conversacionId, e.sucursal_id, waMessageId, texto],
    );
    await pool.query(
      `UPDATE whatsapp_conversaciones SET ultimo_mensaje_en = now(), ultimo_mensaje_tipo = 'texto', ultimo_mensaje_texto = $2,
              ultimo_mensaje_direccion = 'saliente', ultimo_mensaje_wa_message_id = $3, ultimo_mensaje_estado = 'enviado'
        WHERE id = $1`,
      [conversacionId, texto, waMessageId],
    );
    await pool.query(
      `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle) VALUES ($1, $2, 'envio_masivo', $3, $4)`,
      [e.sucursal_id, e.oportunidad_id, `Masivo: ${plantilla}`, { masivo_id: e.masivo_id, plantilla }],
    );
    emitirEventoChat(e.sucursal_id, { tipo: "mensaje_saliente", conversacionId });
  } catch {
    console.error("[masivos] el mensaje salió pero no se pudo dejar en el chat");
  }
}

/** Toma el siguiente envío de un masivo que ya toca y lo resuelve. Devuelve false si no hay ninguno. */
async function procesarUno(): Promise<boolean> {
  const cliente = await getPool().connect();
  let masivoId: string | null = null;
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `SELECT e.id, e.sucursal_id, e.oportunidad_id, e.masivo_id, e.motivo, e.intentos, e.parametros,
              m.estado AS masivo_estado, m.plantilla_nombre,
              (c.whatsapp_baja OR o.estado_contacto = 'baja') AS baja, c.telefono, c.nombre AS cliente, o.ejecutivo,
              p.nombre_tecnico, p.idioma, p.estado AS plantilla_estado, p.componentes
         FROM crm_envios e
         JOIN crm_masivos m ON m.id = e.masivo_id
         JOIN crm_oportunidades o ON o.id = e.oportunidad_id
         JOIN crm_contactos c ON c.id = o.contacto_id
         LEFT JOIN whatsapp_plantillas p ON p.id = e.plantilla_id
        WHERE e.masivo_id IS NOT NULL AND e.estado = 'pendiente' AND e.programado_para <= now()
        ORDER BY e.programado_para, e.creado_en
        LIMIT 1
          FOR UPDATE OF e SKIP LOCKED`,
    );
    const e = rows[0];
    if (!e) {
      await cliente.query("ROLLBACK");
      return false;
    }
    masivoId = e.masivo_id as string;

    const omitir = async (motivo: string) => {
      await cliente.query(`UPDATE crm_envios SET estado = 'omitido', motivo = $2 WHERE id = $1`, [e.id, motivo]);
      await cliente.query("COMMIT");
      return true;
    };

    // Quedó «enviando» de un intento que no terminó (el proceso se cayó a medias): no se sabe si salió, así que NO se reenvía.
    if (e.motivo === "enviando") {
      await cliente.query(
        `UPDATE crm_envios SET estado = 'fallido', error = 'Se interrumpió durante el envío; no se reintenta para no mandar el mensaje dos veces.' WHERE id = $1`,
        [e.id],
      );
      await cliente.query("COMMIT");
      return true;
    }
    if (e.masivo_estado !== "enviando") return await omitir("detenido");
    // Pidió la baja después de que se armó el masivo: gana la baja.
    if (e.baja) return await omitir("baja");
    if (e.plantilla_estado !== "aprobada" || !e.componentes?.body?.texto) return await omitir("plantilla_no_disponible");
    const tel = telefono10(e.telefono);
    if (!tel) return await omitir("sin_telefono");

    // Fuera del horario espera a que abra (puede pasar si el masivo se armó justo antes del cierre).
    const ahora = ahoraLocal();
    if (!dentroDeVentana(ahora, VENTANA_MASIVOS)) {
      const abre = siguienteApertura(ahora, VENTANA_MASIVOS);
      await cliente.query(
        `UPDATE crm_envios SET motivo = 'fuera_de_horario', programado_para = ($2::timestamp AT TIME ZONE '${ZONA_ENVIOS}') WHERE id = $1`,
        [e.id, `${abre.fecha} ${abre.hora}:00`],
      );
      await cliente.query("COMMIT");
      return true;
    }

    const config = await configPorSucursalId(e.sucursal_id as string).catch(() => null);
    if (!config || !config.activo) {
      await cliente.query(`UPDATE crm_envios SET estado = 'fallido', error = 'WhatsApp no está configurado en este grupo.' WHERE id = $1`, [e.id]);
      await cliente.query("COMMIT");
      return true;
    }

    // Envío real, «a lo sumo una vez»: antes de hablar con Meta se deja durable la marca «enviando». Si el proceso muere o
    // no se logra anotar el resultado, jamás se reenvía solo. Es preferible perder un mensaje a mandarlo dos veces.
    await cliente.query(`UPDATE crm_envios SET motivo = 'enviando', programado_para = now() + interval '1 hour' WHERE id = $1`, [e.id]);
    await cliente.query("COMMIT");

    const parametros = (Array.isArray(e.parametros) ? e.parametros : []) as string[];
    const cuerpo = e.componentes.body.texto as string;
    const texto = llenarCuerpo(cuerpo, indicesCuerpo(cuerpo), parametros);
    const pool = getPool();

    let enviado: { waMessageId: string; conversacionId: string };
    try {
      // La conversación del teléfono (se conserva su wa_id) o una nueva.
      const { rows: conv } = await pool.query(
        `SELECT id, wa_id FROM whatsapp_conversaciones
          WHERE sucursal_id = $1 AND right(regexp_replace(wa_id, '\\D', '', 'g'), 10) = $2 ORDER BY ultimo_mensaje_en DESC NULLS LAST LIMIT 1`,
        [e.sucursal_id, tel],
      );
      let conversacionId: string;
      let waId: string;
      if (conv[0]) {
        conversacionId = conv[0].id as string;
        waId = conv[0].wa_id as string;
      } else {
        waId = `52${tel}`;
        const nueva = await pool.query(
          `INSERT INTO whatsapp_conversaciones (sucursal_id, wa_id, nombre_contacto, asignado_a, no_leidos) VALUES ($1, $2, $3, $4, 0) RETURNING id`,
          [e.sucursal_id, waId, e.cliente, e.ejecutivo],
        );
        conversacionId = nueva.rows[0].id as string;
      }
      const r = await enviarMensaje(config, waId, { tipo: "plantilla", nombreTecnico: e.nombre_tecnico, idioma: e.idioma, parametrosBody: parametros });
      enviado = { waMessageId: r.id, conversacionId };
    } catch (err) {
      const mensaje = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const intentos = (e.intentos as number) + 1;
      const resultado = err instanceof ErrorEnvioMeta ? err.resultado : "reintentar";
      if (resultado === "incierto") {
        await pool.query(`UPDATE crm_envios SET estado = 'fallido', intentos = $2, error = $3 WHERE id = $1`, [
          e.id,
          intentos,
          `${mensaje} No se confirmó el envío; no se reintenta para no mandar el mensaje dos veces.`.slice(0, 300),
        ]);
      } else if (resultado === "definitivo" || intentos >= MAX_INTENTOS) {
        await pool.query(`UPDATE crm_envios SET estado = 'fallido', intentos = $2, error = $3 WHERE id = $1`, [e.id, intentos, mensaje]);
      } else {
        await pool.query(
          `UPDATE crm_envios SET intentos = $2, error = $3, motivo = 'reintento', programado_para = now() + interval '5 minutes' WHERE id = $1`,
          [e.id, intentos, mensaje],
        );
      }
      return true;
    }

    // Meta ya aceptó el mensaje: desde aquí nada puede llevar a un reintento.
    try {
      await pool.query(
        `UPDATE crm_envios SET estado = 'enviado', motivo = NULL, wa_message_id = $2, enviado_en = now(), intentos = intentos + 1, error = NULL WHERE id = $1`,
        [e.id, enviado.waMessageId],
      );
    } catch {
      console.error("[masivos] el mensaje salió pero no se pudo anotar como enviado; queda marcado «enviando» y no se reenvía");
      return true;
    }
    await registrarEnChat(e, enviado.conversacionId, enviado.waMessageId, texto, e.plantilla_nombre as string);
    return true;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
    if (masivoId) await cerrarSiTermino(masivoId).catch(() => {});
  }
}

/** Manda lo que ya toca, con un presupuesto de tiempo y una pausa corta entre mensajes. */
export async function despacharMasivos(presupuestoMs = 20_000, maximo = 80): Promise<number> {
  const inicio = Date.now();
  let hechos = 0;
  while (hechos < maximo && Date.now() - inicio < presupuestoMs) {
    let hubo: boolean;
    try {
      hubo = await procesarUno();
    } catch {
      console.error("[masivos] error procesando un envío");
      break;
    }
    if (!hubo) break;
    hechos++;
    await new Promise((r) => setTimeout(r, 150));
  }
  return hechos;
}
