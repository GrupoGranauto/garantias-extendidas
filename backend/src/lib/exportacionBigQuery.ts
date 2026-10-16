import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { getBigQuery } from "./bigquery.js";
import { ahoraLocal, ZONA_ENVIOS } from "./campanasLogica.js";
import { getPool } from "./db.js";
import {
  TABLAS_ENVIO,
  VERSION_CONTRATO,
  enVentanaExportacion,
  filaFeedbackVin,
  filaSupresion,
  problemaContraAnterior,
  resumirEnvio,
  type ConteoEnvio,
  type LeadParaEnvio,
  type SupresionParaEnvio,
} from "./exportacionBigQueryLogica.js";
import { TABLA_MAESTRA } from "./sincronizacionCrm.js";

/** Supresión vigente: no liberada y sin vencer. */
const SQL_VIGENTE = `(sp.revocada_en IS NULL AND (sp.vigente_hasta IS NULL OR sp.vigente_hasta > now()))`;

const SQL_LEADS = `
  SELECT s.subdominio AS sucursal, v.vin, o.campana, o.estado_cartera, o.estado AS estado_lead, et.nombre AS etapa,
         o.resultado_bdc, o.estado_contacto, mp.clave AS motivo_perdida, o.ejecutivo,
         o.fecha_ultimo_contacto::text AS fecha_ultimo_contacto, o.ultimo_contacto_efectivo_en,
         (o.fecha_pago IS NOT NULL OR o.fecha_compra IS NOT NULL OR EXISTS (
            SELECT 1 FROM crm_contratos ct WHERE ct.oportunidad_id = o.id
               AND ct.estado IN ('pago_confirmado', 'certificado_entregado', 'cobertura_iniciada'))) AS pagado,
         (EXISTS (SELECT 1 FROM crm_contratos ct WHERE ct.oportunidad_id = o.id AND ct.estado = 'cancelado')
          AND NOT EXISTS (SELECT 1 FROM crm_contratos ct WHERE ct.oportunidad_id = o.id
                             AND ct.estado IN ('pago_confirmado', 'certificado_entregado', 'cobertura_iniciada'))) AS contrato_cancelado,
         coalesce(o.fecha_compra, o.fecha_pago,
                  -- Pago solo en el contrato: el día en que entró a un estado pagado (o su última actualización).
                  (SELECT min(CASE WHEN e->>'en' ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN ((e->>'en')::timestamptz AT TIME ZONE '${ZONA_ENVIOS}')::date
                                   ELSE (ct.actualizado_en AT TIME ZONE '${ZONA_ENVIOS}')::date END)
                     FROM crm_contratos ct LEFT JOIN LATERAL jsonb_array_elements(ct.eventos) e
                          ON e->>'estado' IN ('pago_confirmado', 'certificado_entregado', 'cobertura_iniciada')
                    WHERE ct.oportunidad_id = o.id
                      AND ct.estado IN ('pago_confirmado', 'certificado_entregado', 'cobertura_iniciada')),
                  CASE WHEN o.estado = 'ganada' THEN (o.cerrada_en AT TIME ZONE '${ZONA_ENVIOS}')::date END)::text AS fecha_venta,
         o.declara_ge, o.conserva_auto,
         (SELECT sp.motivo FROM crm_supresiones sp
           WHERE sp.sucursal_id = o.sucursal_id AND sp.alcance = 'vin' AND sp.valor = v.vin AND ${SQL_VIGENTE}
           ORDER BY sp.creado_en LIMIT 1) AS descarte_vin,
         (SELECT sp.motivo FROM crm_supresiones sp
           WHERE sp.sucursal_id = o.sucursal_id AND sp.alcance = 'telefono' AND sp.valor = crm_tel10(k.telefono) AND ${SQL_VIGENTE}
           ORDER BY (sp.motivo = 'baja') DESC, sp.creado_en LIMIT 1) AS bloqueo_telefono
    FROM crm_oportunidades o
    JOIN crm_vehiculos v ON v.id = o.vehiculo_id
    JOIN sucursales s ON s.id = o.sucursal_id
    LEFT JOIN crm_contactos k ON k.id = o.contacto_id
    LEFT JOIN crm_etapas et ON et.id = o.etapa_id
    LEFT JOIN crm_motivos_perdida mp ON mp.id = o.motivo_perdida_id
   WHERE o.sucursal_id = ANY($1::uuid[])
   ORDER BY s.subdominio, v.vin`;

const SQL_SUPRESIONES = `
  SELECT s.subdominio AS sucursal, sp.alcance, sp.valor, sp.motivo, sp.canal, ${SQL_VIGENTE} AS vigente,
         sp.creado_en AS creada_en, sp.revocada_en AS liberada_en, sp.motivo_revocacion AS motivo_liberacion
    FROM crm_supresiones sp
    JOIN sucursales s ON s.id = sp.sucursal_id
   WHERE sp.sucursal_id = ANY($1::uuid[])
   ORDER BY s.subdominio, sp.creado_en, sp.id`;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

/**
 * Foto de la web para el envío: todos los leads y todas las supresiones de las sucursales que trabajan con la base
 * maestra real (activas; las de prueba no). Se lee en una sola transacción de solo lectura con la misma foto para todo.
 */
export async function armarEnvio(): Promise<{
  corte: string;
  fechaNegocio: string;
  leads: LeadParaEnvio[];
  supresiones: SupresionParaEnvio[];
}> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: t } = await cliente.query(`SELECT now() AS corte, (now() AT TIME ZONE '${ZONA_ENVIOS}')::date::text AS fecha`);
    const { rows: suc } = await cliente.query(
      `SELECT c.sucursal_id FROM crm_config c JOIN sucursales s ON s.id = c.sucursal_id
        WHERE c.sync_bigquery AND s.activa AND (c.bq_tabla_fuente IS NULL OR c.bq_tabla_fuente = $1)`,
      [TABLA_MAESTRA],
    );
    const ids = suc.map((r) => r.sucursal_id as string);
    const { rows: leads } = await cliente.query(SQL_LEADS, [ids]);
    const { rows: supresiones } = await cliente.query(SQL_SUPRESIONES, [ids]);
    await cliente.query("COMMIT");
    return {
      corte: iso(t[0].corte)!,
      fechaNegocio: t[0].fecha as string,
      leads: leads.map((l) => ({ ...l, ultimo_contacto_efectivo_en: iso(l.ultimo_contacto_efectivo_en) }) as LeadParaEnvio),
      supresiones: supresiones.map(
        (s) => ({ ...s, creada_en: iso(s.creada_en)!, liberada_en: iso(s.liberada_en) }) as SupresionParaEnvio,
      ),
    };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** El último envío completo (el que tiene su fila en ge_web_envios), o null si todavía no hay ninguno. */
async function ultimoEnvio(): Promise<(ConteoEnvio & { fechaNegocio: string }) | null> {
  const [filas] = await getBigQuery().query({
    query: `SELECT CAST(fecha_negocio AS STRING) AS fecha, filas_vin, filas_supresiones FROM \`${TABLAS_ENVIO.envios}\`
             WHERE version_contrato = @version ORDER BY corte DESC LIMIT 1`,
    params: { version: VERSION_CONTRATO },
    location: env.BIGQUERY_LOCATION,
  });
  const f = (filas as { fecha: string; filas_vin: number; filas_supresiones: number }[])[0];
  return f ? { fechaNegocio: f.fecha, filasVin: Number(f.filas_vin), filasSupresiones: Number(f.filas_supresiones) } : null;
}

/** Agrega filas a una tabla con un trabajo de carga (por lote, sin streaming: atómico y sin costo). */
async function cargar(tabla: string, filas: object[]): Promise<void> {
  if (filas.length === 0) return;
  const [proyecto, dataset, nombre] = tabla.split(".");
  const destino = getBigQuery().dataset(dataset, { projectId: proyecto }).table(nombre);
  await new Promise<void>((resolve, reject) => {
    const flujo = destino.createWriteStream({
      sourceFormat: "NEWLINE_DELIMITED_JSON",
      writeDisposition: "WRITE_APPEND",
      createDisposition: "CREATE_NEVER",
      location: env.BIGQUERY_LOCATION,
    });
    flujo.on("error", reject);
    flujo.on("complete", () => resolve());
    flujo.end(filas.map((f) => JSON.stringify(f)).join("\n") + "\n");
  });
}

/** El freno contra el envío anterior se activó: no se reintenta en la misma noche (volvería a frenar igual). */
export class FrenoEnvio extends Error {}

export type ResultadoExportacion = ReturnType<typeof resumirEnvio> & {
  runId: string;
  corte: string;
  enviado: boolean;
  nota: string | null;
};

/**
 * Arma el envío y, si `aplicar`, lo carga en BigQuery: primero los VIN y las supresiones, al final la fila del envío.
 * Sin `aplicar` es una prueba en seco: lee todo, calcula y revisa el freno, pero no carga nada. Un día con envío completo
 * no se vuelve a enviar.
 */
export async function exportarABigQuery(aplicar: boolean): Promise<ResultadoExportacion> {
  const envio = await armarEnvio();
  const runId = randomUUID();
  const vin = envio.leads.map((l) => filaFeedbackVin(l, runId, envio.corte));
  const supresiones = envio.supresiones.map((s) => filaSupresion(s, runId, envio.corte));
  const resumen = { ...resumirEnvio(vin, supresiones), runId, corte: envio.corte };

  let anterior: Awaited<ReturnType<typeof ultimoEnvio>>;
  try {
    anterior = await ultimoEnvio();
  } catch (err) {
    // Sin la tabla de envíos (aún no se crea) solo puede correr la prueba en seco.
    if (aplicar) throw err;
    return { ...resumen, enviado: false, nota: "Prueba en seco: no se pudo leer el envío anterior en BigQuery; no se cargó nada." };
  }
  if (aplicar && anterior?.fechaNegocio === envio.fechaNegocio) {
    return { ...resumen, enviado: false, nota: "Ya hay un envío completo de hoy." };
  }
  const problema = problemaContraAnterior(resumen, anterior);
  if (problema) {
    // Salida para una baja legítima (p. ej. se desactivó una sucursal): CRM_EXPORT_BQ_FORZAR=<fecha de hoy> la acepta ese día.
    if (process.env.CRM_EXPORT_BQ_FORZAR !== envio.fechaNegocio) throw new FrenoEnvio(problema);
    console.warn(`[export-bq] freno aceptado por CRM_EXPORT_BQ_FORZAR=${envio.fechaNegocio}: ${problema}`);
  }
  if (!aplicar) return { ...resumen, enviado: false, nota: "Prueba en seco: no se cargó nada." };

  await cargar(TABLAS_ENVIO.vin, vin);
  await cargar(TABLAS_ENVIO.supresiones, supresiones);
  await cargar(TABLAS_ENVIO.envios, [
    {
      run_id: runId,
      corte: envio.corte,
      fecha_negocio: envio.fechaNegocio,
      version_contrato: VERSION_CONTRATO,
      filas_vin: vin.length,
      filas_supresiones: supresiones.length,
    },
  ]);
  return { ...resumen, enviado: true, nota: null };
}

/* ---------- Envío nocturno programado ---------- */

let temporizador: NodeJS.Timeout | null = null;
let exportando = false;
/** Día (Hermosillo) que ya quedó enviado en este proceso: evita volver a consultar BigQuery el resto de la ventana. */
let diaEnviado: string | null = null;

async function exportarSiToca(): Promise<void> {
  const { fecha, minutos } = ahoraLocal();
  if (!enVentanaExportacion(minutos) || diaEnviado === fecha) return;
  try {
    const r = await exportarABigQuery(true);
    diaEnviado = fecha;
    // Solo conteos: nunca datos de clientes.
    console.log(
      r.enviado
        ? `[export-bq] ok: ${r.filasVin} VIN, ${r.filasSupresiones} supresiones, ${r.ventasBdc} ventas del BDC`
        : `[export-bq] sin cambios: ${r.nota}`,
    );
  } catch (err) {
    if (err instanceof FrenoEnvio) diaEnviado = fecha;
    console.error(`[export-bq] abortado: ${err instanceof Error ? err.message : "error"}`);
  }
}

/**
 * Arranca el envío nocturno en este proceso: revisa cada 10 minutos y, entre las 02:00 y las 07:30 de Hermosillo, envía
 * una vez por día (si falla, lo reintenta en la siguiente revisión). Solo se enciende con CRM_EXPORT_BQ=true.
 */
export function iniciarExportacionProgramada(): void {
  if (temporizador) return;
  temporizador = setInterval(() => {
    if (exportando) return;
    exportando = true;
    exportarSiToca()
      .catch(() => console.error("[export-bq] falló la revisión programada"))
      .finally(() => {
        exportando = false;
      });
  }, 10 * 60 * 1000);
  temporizador.unref();
}
