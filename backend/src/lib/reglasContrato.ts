import { getPool } from "./db.js";
import { emitirBroadcast } from "./realtime.js";
import { ZONA_ENVIOS, ahoraLocal, dentroDeVentana, siguienteApertura } from "./campanasLogica.js";
import { rellenarTexto } from "./seguimientosLogica.js";
import {
  ESTADOS_CON_REGLA,
  coberturaYaInicio,
  dentroDeVigencia,
  entradaAlEstado,
  validarReglasContrato,
  type AccionRegla,
  type ReglaContratoEntrada,
} from "./contratoLogica.js";
import { armarEnvioUnico } from "./masivos.js";
import { plantillaNoUsable, usoDePlantilla, VENTANA_MASIVOS, type Componentes } from "./masivosLogica.js";
import { guardarContrato } from "./crmProceso.js";
import { motivoSinTarea } from "./noContactarLogica.js";

/**
 * Pago y cierre automáticos.
 *
 *  - Reglas del contrato: cuando un contrato lleva N horas en un estado, se crea una tarea para el ejecutivo de la oportunidad
 *    (la liga de pago por vencer, reemitir la orden de pago, pedir los datos para facturar…). Nacen apagadas. Nunca para
 *    quien está en baja, no contactable o con una supresión vigente: esa tarea queda omitida con su motivo.
 *  - Cobertura automática: cuando termina la garantía original (36 meses desde la factura), los contratos en «Certificado
 *    entregado» pasan solos a «Cobertura iniciada».
 *
 * Cada regla hace una de dos cosas: crea la tarea para el ejecutivo o manda una plantilla de WhatsApp de servicio (aviso de
 * la liga de pago, recordatorio, liga vencida, póliza contratada…; pedido de Miguel Borbón, 20-oct-2026). Los mensajes pasan
 * por el mismo freno que un masivo pero no por el límite de uno al día (son de una compra en curso), salen dentro del horario
 * de envíos y solo mientras sigan vigentes.
 */

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export const ETIQUETA_ESTADO: Record<string, string> = {
  cotizado: "Cotizado",
  aceptado: "Aceptado por el cliente",
  orden_pago: "Orden de pago generada",
  pago_confirmado: "Pago confirmado",
  certificado_entregado: "Certificado entregado",
  cobertura_iniciada: "Cobertura iniciada",
};

/** Las tres reglas que se proponen la primera vez (apagadas): la liga de pago de Openpay dura 24 horas. */
const SEMILLAS: ReglaContratoEntrada[] = [
  {
    nombre: "Liga de pago por vencer",
    activa: false,
    estado: "orden_pago",
    espera_horas: 20,
    titulo: "La liga de pago de {cliente} vence en 4 horas",
    descripcion: "La orden de pago que llegó por correo dura 24 horas. Contacta al cliente para que pague antes de que venza.",
    vence_horas: 2,
    accion: "tarea",
    plantilla_id: null,
    telefonos_prueba: [],
  },
  {
    nombre: "Reemitir orden de pago",
    activa: false,
    estado: "orden_pago",
    espera_horas: 25,
    titulo: "Reemitir la orden de pago de {cliente}",
    descripcion: "La liga de pago ya venció sin pago. Genera una nueva orden en el portal de emisión y avisa al cliente.",
    vence_horas: 8,
    accion: "tarea",
    plantilla_id: null,
    telefonos_prueba: [],
  },
  {
    nombre: "Pedir datos para facturar",
    activa: false,
    estado: "certificado_entregado",
    espera_horas: 24,
    titulo: "Pedir los datos de facturación de {cliente}",
    descripcion: "Solicita la constancia de situación fiscal. Para facturar se necesita también el recibo de pago y la carátula del certificado.",
    vence_horas: 48,
    accion: "tarea",
    plantilla_id: null,
    telefonos_prueba: [],
  },
  // Mensajes al cliente (apagados y sin plantilla: cada grupo elige la suya). La vigencia evita mandar algo que ya no aplica.
  ...(
    [
      ["Aviso de liga de pago", "orden_pago", 0, 20],
      ["Recordatorio de pago", "orden_pago", 20, 3],
      ["Liga vencida", "orden_pago", 25, 48],
      ["Póliza contratada", "pago_confirmado", 0, 72],
      ["Cómo mantenerla vigente", "certificado_entregado", 24, 72],
    ] as const
  ).map(
    ([nombre, estado, espera, vigencia]): ReglaContratoEntrada => ({
      nombre,
      activa: false,
      estado,
      espera_horas: espera,
      titulo: "",
      descripcion: null,
      vence_horas: vigencia,
      accion: "whatsapp",
      plantilla_id: null,
      telefonos_prueba: [],
    }),
  ),
];

const COLUMNAS = `id, orden, nombre, activa, estado, espera_horas, titulo, descripcion, vence_horas, accion, plantilla_id, telefonos_prueba`;

export type ReglaContrato = ReglaContratoEntrada & { id: string; orden: number };

const aRegla = (r: any): ReglaContrato => ({
  id: r.id,
  orden: r.orden,
  nombre: r.nombre,
  activa: r.activa,
  estado: r.estado,
  espera_horas: r.espera_horas,
  titulo: r.titulo,
  descripcion: r.descripcion,
  vence_horas: r.vence_horas,
  accion: r.accion as AccionRegla,
  plantilla_id: r.plantilla_id ?? null,
  telefonos_prueba: r.telefonos_prueba ?? [],
});

async function sembrarSiVacio(sucursalId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM crm_reglas_contrato WHERE sucursal_id = $1`, [sucursalId]);
  if ((rows[0]?.n as number) > 0) return;
  await pool.query(
    `INSERT INTO crm_reglas_contrato (sucursal_id, orden, nombre, activa, estado, espera_horas, titulo, descripcion, vence_horas, accion)
     SELECT $1, r.orden, r.nombre, r.activa, r.estado, r.espera_horas, r.titulo, r.descripcion, r.vence_horas, r.accion
       FROM jsonb_to_recordset($2::jsonb) AS r(orden int, nombre text, activa boolean, estado text, espera_horas int, titulo text, descripcion text, vence_horas int, accion text)
     ON CONFLICT (sucursal_id, orden) DO NOTHING`,
    [sucursalId, JSON.stringify(SEMILLAS.map((s, i) => ({ ...s, orden: i + 1 })))],
  );
}

const plantillasDeServicio = (filas: Record<string, any>[]) =>
  filas
    .filter((p) => usoDePlantilla(p.uso as string | null, p.categoria as string | null) === "servicio")
    .filter((p) => !plantillaNoUsable({ estado: p.estado, componentes: p.componentes as Componentes }, (p.indices as number[]).map(Number)))
    .map((p) => ({ id: p.id as string, nombre: p.nombre as string }));

export async function leerReglasContrato(sucursalId: string) {
  await sembrarSiVacio(sucursalId);
  const pool = getPool();
  const [reglas, resumen, recientes, cfg, enCertificado, plantillas] = await Promise.all([
    pool.query(`SELECT ${COLUMNAS} FROM crm_reglas_contrato WHERE sucursal_id = $1 ORDER BY orden`, [sucursalId]),
    pool.query(`SELECT regla_id, estado, count(*)::int AS n FROM crm_regla_contrato_ejecuciones WHERE sucursal_id = $1 GROUP BY 1, 2`, [sucursalId]),
    pool.query(
      `SELECT x.id, r.nombre AS regla, x.estado, x.motivo, x.programado_para, x.actualizado_en, c.nombre AS cliente
         FROM crm_regla_contrato_ejecuciones x
         JOIN crm_reglas_contrato r ON r.id = x.regla_id
         JOIN crm_oportunidades o ON o.id = x.oportunidad_id
         JOIN crm_contactos c ON c.id = o.contacto_id
        WHERE x.sucursal_id = $1 ORDER BY x.actualizado_en DESC LIMIT 30`,
      [sucursalId],
    ),
    pool.query(`SELECT cobertura_automatica FROM crm_config WHERE sucursal_id = $1`, [sucursalId]),
    pool.query(
      `SELECT count(*)::int AS total, min(v.fecha_factura)::text AS factura_mas_antigua
         FROM crm_contratos c JOIN crm_oportunidades o ON o.id = c.oportunidad_id JOIN crm_vehiculos v ON v.id = o.vehiculo_id
        WHERE c.sucursal_id = $1 AND c.estado = 'certificado_entregado'`,
      [sucursalId],
    ),
    pool.query(
      `SELECT p.id, coalesce(p.nombre, p.nombre_tecnico) AS nombre, p.estado, p.componentes, r.uso, p.categoria,
              coalesce((SELECT array_agg(v.indice) FROM whatsapp_plantilla_variables v WHERE v.plantilla_id = p.id), '{}') AS indices
         FROM whatsapp_plantillas p LEFT JOIN crm_plantilla_reglas r ON r.plantilla_id = p.id
        WHERE p.sucursal_id = $1 AND p.estado = 'aprobada'
        ORDER BY 2`,
      [sucursalId],
    ),
  ]);
  const n = (id: string, estado: string) => (resumen.rows.find((r) => r.regla_id === id && r.estado === estado)?.n as number | undefined) ?? 0;
  return {
    reglas: reglas.rows.map((r) => ({ ...aRegla(r), resumen: { pendientes: n(r.id, "pendiente"), hechos: n(r.id, "hecho"), omitidos: n(r.id, "omitido") } })),
    estados: ESTADOS_CON_REGLA.map((valor) => ({ valor, etiqueta: ETIQUETA_ESTADO[valor] })),
    cobertura_automatica: cfg.rows[0]?.cobertura_automatica !== false,
    contratos_en_certificado: (enCertificado.rows[0]?.total as number | undefined) ?? 0,
    recientes: recientes.rows,
    // Las que puede mandar una regla: de servicio, aprobadas y con sus datos ligados.
    plantillas: plantillasDeServicio(plantillas.rows),
  };
}

export type ResultadoGuardarReglas = { ok: true } | { ok: false; error: string };

/**
 * Guarda las reglas y el interruptor de la cobertura automática. Las reglas que ya existían se actualizan (conservan su historial);
 * lo pendiente de una regla cuyo estado o espera cambió se reprograma. Las que ya no vienen se borran.
 */
export async function guardarReglasContrato(
  sucursalId: string,
  lista: (ReglaContratoEntrada & { id?: string })[],
  coberturaAutomatica: boolean,
): Promise<ResultadoGuardarReglas> {
  lista = lista.map((r) => ({
    ...r,
    telefonos_prueba: [...new Set((r.telefonos_prueba ?? []).map((t) => t.replace(/\D/g, "").slice(-10)).filter(Boolean))],
    titulo: r.accion === "whatsapp" ? "" : r.titulo,
  }));
  const error = validarReglasContrato(lista);
  if (error) return { ok: false, error };
  // Una regla encendida de WhatsApp solo puede mandar una plantilla de servicio aprobada y con sus datos ligados.
  const conPlantilla = lista.filter((r) => r.accion === "whatsapp" && r.activa && r.plantilla_id);
  if (conPlantilla.length > 0) {
    const { rows } = await getPool().query(
      `SELECT p.id, coalesce(p.nombre, p.nombre_tecnico) AS nombre, p.estado, p.componentes, r.uso, p.categoria,
              coalesce((SELECT array_agg(v.indice) FROM whatsapp_plantilla_variables v WHERE v.plantilla_id = p.id), '{}') AS indices
         FROM whatsapp_plantillas p LEFT JOIN crm_plantilla_reglas r ON r.plantilla_id = p.id
        WHERE p.sucursal_id = $1 AND p.id = ANY($2::uuid[])`,
      [sucursalId, conPlantilla.map((r) => r.plantilla_id)],
    );
    const validas = new Set(plantillasDeServicio(rows).map((p) => p.id));
    const mala = conPlantilla.find((r) => !validas.has(r.plantilla_id!));
    if (mala) return { ok: false, error: `«${mala.nombre.trim()}»: esa plantilla no se puede usar; tiene que ser de servicio, estar aprobada y con sus datos ligados.` };
  }

  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows: existentes } = await cliente.query(`SELECT ${COLUMNAS} FROM crm_reglas_contrato WHERE sucursal_id = $1`, [sucursalId]);
    const porId = new Map(existentes.map((r) => [r.id as string, aRegla(r)]));
    const conservadas = new Set<string>();

    // Se libera el orden para no chocar con la unicidad al reordenar.
    await cliente.query(`UPDATE crm_reglas_contrato SET orden = orden + 1000 WHERE sucursal_id = $1`, [sucursalId]);
    for (const [i, r] of lista.entries()) {
      const valores = [
        i + 1,
        r.nombre.trim(),
        r.activa,
        r.estado,
        r.espera_horas,
        r.titulo.trim(),
        (r.descripcion ?? "").trim() || null,
        r.vence_horas,
        r.accion,
        r.accion === "whatsapp" ? r.plantilla_id : null,
        r.accion === "whatsapp" ? r.telefonos_prueba : [],
      ];
      const previa = r.id ? porId.get(r.id) : undefined;
      if (previa) {
        conservadas.add(previa.id);
        await cliente.query(
          `UPDATE crm_reglas_contrato SET orden = $2, nombre = $3, activa = $4, estado = $5, espera_horas = $6, titulo = $7, descripcion = $8,
                  vence_horas = $9, accion = $10, plantilla_id = $11, telefonos_prueba = $12::text[] WHERE id = $1`,
          [previa.id, ...valores],
        );
        if (previa.estado !== r.estado || previa.espera_horas !== r.espera_horas || previa.accion !== r.accion) {
          await cliente.query(`DELETE FROM crm_regla_contrato_ejecuciones WHERE regla_id = $1 AND estado = 'pendiente'`, [previa.id]);
        }
      } else {
        await cliente.query(
          `INSERT INTO crm_reglas_contrato (sucursal_id, orden, nombre, activa, estado, espera_horas, titulo, descripcion, vence_horas, accion, plantilla_id, telefonos_prueba)
           VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[])`,
          [...valores, sucursalId],
        );
      }
    }
    const aBorrar = existentes.map((r) => r.id as string).filter((id) => !conservadas.has(id));
    if (aBorrar.length > 0) await cliente.query(`DELETE FROM crm_reglas_contrato WHERE id = ANY($1::uuid[])`, [aBorrar]);

    await cliente.query(
      `INSERT INTO crm_config (sucursal_id, cobertura_automatica) VALUES ($1, $2)
       ON CONFLICT (sucursal_id) DO UPDATE SET cobertura_automatica = EXCLUDED.cobertura_automatica, actualizado_en = now()`,
      [sucursalId, coberturaAutomatica],
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

/* ============================================================
   Planificador
   ============================================================ */

/** Programa la tarea de cada contrato que está en el estado de una regla activa. */
export async function planificarReglasContrato(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.sucursal_id, c.oportunidad_id, c.estado, c.eventos, c.actualizado_en::text AS actualizado_en, r.id AS regla_id, r.espera_horas
       FROM crm_reglas_contrato r
       JOIN crm_contratos c ON c.sucursal_id = r.sucursal_id AND c.estado = r.estado
       JOIN crm_oportunidades o ON o.id = c.oportunidad_id AND o.estado <> 'perdida'
      WHERE r.activa
      LIMIT 5000`,
  );
  const lote: { sucursal_id: string; regla_id: string; oportunidad_id: string; estado_desde: string; programado_para: string }[] = [];
  for (const r of rows) {
    const desde = entradaAlEstado(r.eventos, r.estado as string, r.actualizado_en as string);
    if (!desde) continue;
    lote.push({
      sucursal_id: r.sucursal_id,
      regla_id: r.regla_id,
      oportunidad_id: r.oportunidad_id,
      estado_desde: desde,
      programado_para: new Date(new Date(desde).getTime() + (r.espera_horas as number) * 3_600_000).toISOString(),
    });
  }
  let nuevas = 0;
  for (let i = 0; i < lote.length; i += 1000) {
    const { rowCount } = await pool.query(
      `INSERT INTO crm_regla_contrato_ejecuciones (sucursal_id, regla_id, oportunidad_id, estado_desde, programado_para)
       SELECT r.sucursal_id, r.regla_id, r.oportunidad_id, r.estado_desde, r.programado_para
         FROM jsonb_to_recordset($1::jsonb) AS r(sucursal_id uuid, regla_id uuid, oportunidad_id uuid, estado_desde timestamptz, programado_para timestamptz)
       ON CONFLICT (regla_id, oportunidad_id, estado_desde) DO NOTHING`,
      [JSON.stringify(lote.slice(i, i + 1000))],
    );
    nuevas += rowCount ?? 0;
  }
  return nuevas;
}

/* ============================================================
   Ejecutor
   ============================================================ */

const cerrar = (cl: Consulta, id: string, estado: "hecho" | "omitido", motivo: string | null, tareaId: string | null = null) =>
  cl.query(`UPDATE crm_regla_contrato_ejecuciones SET estado = $2, motivo = $3, tarea_id = $4 WHERE id = $1`, [id, estado, motivo, tareaId]);

/**
 * La acción de una regla de WhatsApp, dentro de la transacción del ejecutor: deja el mensaje en cola (el despachador de
 * masivos lo manda) o devuelve por qué no sale. En modo prueba solo a los teléfonos de prueba; fuera del horario de envíos
 * sale en la siguiente apertura, pero solo si para entonces sigue vigente.
 */
async function mandarWhatsappDeRegla(cl: Consulta, x: Record<string, any>): Promise<string | null> {
  if (!x.plantilla_id) return "sin_plantilla";
  const pruebas = (x.telefonos_prueba as string[] | null) ?? [];
  if (pruebas.length > 0) {
    const { rows } = await cl.query(
      `SELECT crm_tel10(k.telefono) AS tel FROM crm_oportunidades o JOIN crm_contactos k ON k.id = o.contacto_id WHERE o.id = $1`,
      [x.oportunidad_id],
    );
    if (!pruebas.includes((rows[0]?.tel as string | null) ?? "")) return "modo_prueba";
  }
  const ahora = ahoraLocal();
  let salida = new Date();
  if (!dentroDeVentana(ahora, VENTANA_MASIVOS)) {
    const abre = siguienteApertura(ahora, VENTANA_MASIVOS);
    const { rows } = await cl.query(`SELECT ($1::timestamp AT TIME ZONE '${ZONA_ENVIOS}') AS t`, [`${abre.fecha} ${abre.hora}:00`]);
    salida = new Date(rows[0].t as string);
  }
  if (!dentroDeVigencia(salida, new Date(x.programado_para as string), (x.vence_horas as number | null) ?? null)) return "vencido";

  const r = await armarEnvioUnico(cl, {
    origen: "contrato",
    sucursalId: x.sucursal_id as string,
    oportunidadId: x.oportunidad_id as string,
    pasoId: null,
    campana: null,
    plantillaId: x.plantilla_id as string,
    telefonosPrueba: pruebas,
    sinLimiteDiario: true,
    registrarOmitido: false,
  });
  if (!r.creado) return r.general ? "plantilla_no_disponible" : (r.motivo ?? "no_enviado");
  await cl.query(`INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle) VALUES ($1, $2, 'regla_contrato', $3, $4)`, [
    x.sucursal_id,
    x.oportunidad_id,
    `Contrato: WhatsApp «${x.nombre}» en cola`,
    { regla: x.nombre, estado: x.estado_regla, envio_id: r.envioId },
  ]);
  await cl.query(`UPDATE crm_regla_contrato_ejecuciones SET estado = 'hecho', motivo = NULL, envio_id = $2 WHERE id = $1`, [x.id, r.envioId]);
  return null;
}

/** Resuelve la ejecución más antigua que ya le toca. Devuelve false si no hay nada. */
async function ejecutarUna(): Promise<{ hubo: boolean; sucursal: string | null }> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      `SELECT x.id, x.sucursal_id, x.oportunidad_id, x.estado_desde, x.programado_para, r.nombre, r.estado AS estado_regla, r.titulo, r.descripcion,
              r.vence_horas, r.accion, r.plantilla_id, r.telefonos_prueba
         FROM crm_regla_contrato_ejecuciones x JOIN crm_reglas_contrato r ON r.id = x.regla_id
        WHERE x.estado = 'pendiente' AND x.programado_para <= now() AND r.activa
        ORDER BY x.programado_para LIMIT 1 FOR UPDATE OF x SKIP LOCKED`,
    );
    const x = rows[0];
    if (!x) {
      await cliente.query("ROLLBACK");
      return { hubo: false, sucursal: null };
    }

    // El contrato debe seguir en el mismo estado y desde el mismo momento: si avanzó (o se reinició), la tarea ya no tiene sentido.
    const { rows: c } = await cliente.query(`SELECT estado, eventos, actualizado_en::text AS actualizado_en FROM crm_contratos WHERE oportunidad_id = $1`, [x.oportunidad_id]);
    const desde = c[0] ? entradaAlEstado(c[0].eventos, c[0].estado as string, c[0].actualizado_en as string) : null;
    if (!c[0] || c[0].estado !== x.estado_regla || !desde || new Date(desde).getTime() !== new Date(x.estado_desde).getTime()) {
      await cerrar(cliente, x.id, "omitido", "cambio_de_estado");
      await cliente.query("COMMIT");
      return { hubo: true, sucursal: null };
    }

    const { rows: f } = await cliente.query(`SELECT to_jsonb(v) AS f FROM crm_v_oportunidades v WHERE v.id = $1 AND v.sucursal_id = $2`, [x.oportunidad_id, x.sucursal_id]);
    const fila = (f[0]?.f ?? null) as Record<string, unknown> | null;
    if (!fila || fila.estado_oportunidad === "perdida") {
      await cerrar(cliente, x.id, "omitido", "ya_no_aplica");
      await cliente.query("COMMIT");
      return { hubo: true, sucursal: null };
    }

    // A quien no se le puede buscar no se le crea la tarea: en baja (el lead, la persona o su teléfono), no contactable o
    // con una supresión vigente por su VIN o su teléfono. Queda omitida con el motivo.
    const { rows: ct } = await cliente.query(
      `SELECT o.estado_contacto, coalesce(k.whatsapp_baja, false) AS no_contactar, crm_supresion_de_lead(o.id) AS supresion
         FROM crm_oportunidades o LEFT JOIN crm_contactos k ON k.id = o.contacto_id
        WHERE o.id = $1 AND o.sucursal_id = $2`,
      [x.oportunidad_id, x.sucursal_id],
    );
    const sinTarea = ct[0]
      ? motivoSinTarea({
          estadoContacto: (ct[0].estado_contacto as string | null) ?? null,
          noContactar: ct[0].no_contactar === true,
          supresion: (ct[0].supresion as string | null) ?? null,
        })
      : "ya_no_aplica";
    if (sinTarea) {
      await cerrar(cliente, x.id, "omitido", sinTarea);
      await cliente.query("COMMIT");
      return { hubo: true, sucursal: null };
    }

    if (x.accion === "whatsapp") {
      const motivo = await mandarWhatsappDeRegla(cliente, x);
      if (motivo) await cerrar(cliente, x.id, "omitido", motivo);
      await cliente.query("COMMIT");
      return { hubo: true, sucursal: null };
    }

    const { rows: tarea } = await cliente.query(
      `INSERT INTO crm_tareas (sucursal_id, oportunidad_id, regla_contrato_id, tipo, titulo, descripcion, config, asignado_a, vence_en)
       VALUES ($1, $2, (SELECT regla_id FROM crm_regla_contrato_ejecuciones WHERE id = $3), 'tarea', $4, $5, $6::jsonb, $7,
               CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(hours => $8::int) END)
       RETURNING id`,
      [
        x.sucursal_id,
        x.oportunidad_id,
        x.id,
        rellenarTexto(String(x.titulo), fila),
        x.descripcion ? rellenarTexto(String(x.descripcion), fila) : null,
        JSON.stringify({ contrato: true, regla: x.nombre, estado: x.estado_regla }),
        (fila.ejecutivo as string | null) ?? null,
        x.vence_horas as number | null,
      ],
    );
    await cliente.query(`INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle) VALUES ($1, $2, 'regla_contrato', $3, $4)`, [
      x.sucursal_id,
      x.oportunidad_id,
      `Contrato: tarea «${x.nombre}» creada`,
      { regla: x.nombre, estado: x.estado_regla },
    ]);
    await cerrar(cliente, x.id, "hecho", null, tarea[0].id as string);
    await cliente.query("COMMIT");
    return { hubo: true, sucursal: x.sucursal_id as string };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Ejecuta lo que ya toca, con un presupuesto de tiempo. Devuelve cuántas resolvió. */
export async function ejecutarReglasContrato(presupuestoMs = 15_000, maximo = 200): Promise<number> {
  const inicio = Date.now();
  const conTareas = new Set<string>();
  let hechas = 0;
  while (hechas < maximo && Date.now() - inicio < presupuestoMs) {
    let r: { hubo: boolean; sucursal: string | null };
    try {
      r = await ejecutarUna();
    } catch (err) {
      console.error("[reglas-contrato] error ejecutando una regla", err instanceof Error ? err.message : err);
      break;
    }
    if (!r.hubo) break;
    if (r.sucursal) conTareas.add(r.sucursal);
    hechas++;
  }
  for (const s of conTareas) emitirBroadcast(`datos:${s}`, "tareas", {});
  return hechas;
}

/* ============================================================
   Cobertura automática
   ============================================================ */

/** Pasa a «Cobertura iniciada» los contratos con certificado entregado cuya garantía original ya terminó. */
export async function iniciarCoberturasVencidas(maximo = 200): Promise<number> {
  const hoy = ahoraLocal().fecha;
  const { rows } = await getPool().query(
    `SELECT c.sucursal_id, c.oportunidad_id, v.fecha_factura::text AS fecha_factura, pg.meses_garantia_original
       FROM crm_contratos c
       JOIN crm_oportunidades o ON o.id = c.oportunidad_id
       JOIN crm_vehiculos v ON v.id = o.vehiculo_id
       LEFT JOIN crm_config cc ON cc.sucursal_id = c.sucursal_id
       LEFT JOIN crm_programa_ge pg ON pg.sucursal_id = c.sucursal_id
      WHERE c.estado = 'certificado_entregado' AND coalesce(cc.cobertura_automatica, true) AND v.fecha_factura IS NOT NULL`,
  );
  let cambios = 0;
  for (const r of rows) {
    if (cambios >= maximo) break;
    // Los meses de la garantía original son del programa de la sucursal (36 si nunca se configuró).
    if (!coberturaYaInicio(r.fecha_factura as string, hoy, (r.meses_garantia_original as number | null) ?? undefined)) continue;
    try {
      const res = await guardarContrato({ sucursalId: r.sucursal_id, oportunidadId: r.oportunidad_id, estado: "cobertura_iniciada", origen: "sistema" });
      if (res.ok) cambios++;
    } catch (err) {
      console.error("[reglas-contrato] no se pudo iniciar una cobertura", err instanceof Error ? err.message : err);
    }
  }
  return cambios;
}
