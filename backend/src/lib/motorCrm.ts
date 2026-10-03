import { z } from "zod";
import { getPool } from "./db.js";
import { emitirBroadcast } from "./realtime.js";
import { validarFechaCoherente } from "./entidades.js";

/**
 * Motor de automatizaciones del CRM: "cuando una oportunidad entra a una etapa -> entonces
 * crea una tarea / una pregunta para el ejecutivo". Lee la bandeja crm_eventos (que llena un
 * trigger de la BD), así que no depende de qué ruta o proceso movió la oportunidad.
 *
 * Idempotente: crm_ejecuciones tiene unicidad (automatización, oportunidad, evento), así que un
 * reintento nunca duplica una tarea. Las automatizaciones de WhatsApp solo se configuran: el
 * envío está fuera del motor hasta definir la fuente de consentimiento.
 */

/** Columnas de la tabla donde una pregunta puede dejar la respuesta del cliente. */
export const DESTINOS_PREGUNTA = ["comentarios", "fecha_ultimo_contacto", "fecha_compra"] as const;
export type DestinoPregunta = (typeof DESTINOS_PREGUNTA)[number];
const DESTINO_ES_FECHA: Record<DestinoPregunta, boolean> = { comentarios: false, fecha_ultimo_contacto: true, fecha_compra: true };

export const TIPOS_RESPUESTA = ["texto", "opcion", "fecha", "numero", "si_no"] as const;

const horas = z.number().int().min(0).max(24 * 365).nullable().default(null);

/** Opciones del disparador por tiempo; solo se usan cuando el evento es tiempo_en_etapa. */
const disparoTiempo = {
  horas: z.number().int().min(1).max(24 * 365).nullable().default(null),
  solo_sin_contacto: z.boolean().default(false),
  aplicar_a_existentes: z.boolean().default(false),
};

const tareaConfig = z.object({
  titulo: z.string().trim().min(1, "La tarea necesita un título.").max(160),
  descripcion: z.string().trim().max(1000).default(""),
  vence_horas: horas,
  ...disparoTiempo,
});

const preguntaConfig = z
  .object({
    texto: z.string().trim().min(1, "La pregunta necesita su texto.").max(300),
    tipo_respuesta: z.enum(TIPOS_RESPUESTA),
    opciones: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    campo_destino: z.enum(DESTINOS_PREGUNTA).nullable().default(null),
    obligatoria: z.boolean().default(false),
    vence_horas: horas,
    ...disparoTiempo,
  })
  .superRefine((c, ctx) => {
    if (c.tipo_respuesta === "opcion" && c.opciones.length < 2) {
      ctx.addIssue({ code: "custom", message: "Una pregunta de opción necesita al menos dos opciones." });
    }
    if (c.campo_destino && DESTINO_ES_FECHA[c.campo_destino] && c.tipo_respuesta !== "fecha") {
      ctx.addIssue({ code: "custom", message: "Una columna de fecha solo recibe respuestas de tipo fecha." });
    }
    if (c.campo_destino && !DESTINO_ES_FECHA[c.campo_destino] && c.tipo_respuesta === "fecha") {
      ctx.addIssue({ code: "custom", message: "Una respuesta de fecha debe guardarse en una columna de fecha." });
    }
  });

const whatsappConfig = z.object({
  plantilla_id: z.string().uuid().nullable().default(null),
  retraso_horas: z.number().int().min(0).max(720).default(0),
});

export const automatizacionSchema = z
  .object({
    id: z.string().uuid().optional(),
    evento: z.enum(["entra_etapa", "tiempo_en_etapa"]).default("entra_etapa"),
    tipo: z.enum(["tarea", "pregunta", "whatsapp"]),
    nombre: z.string().trim().min(1, "Cada automatización necesita un nombre.").max(120),
    activa: z.boolean().default(false),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .transform((a, ctx) => {
    const esquema = a.tipo === "tarea" ? tareaConfig : a.tipo === "pregunta" ? preguntaConfig : whatsappConfig;
    const r = esquema.safeParse(a.config);
    if (!r.success) {
      ctx.addIssue({ code: "custom", message: r.error.issues[0]?.message ?? "Configuración inválida." });
      return z.NEVER;
    }
    if (a.evento === "tiempo_en_etapa") {
      if (a.tipo === "whatsapp") {
        ctx.addIssue({ code: "custom", message: "El envío de WhatsApp solo se dispara al entrar a la etapa." });
        return z.NEVER;
      }
      if (!(r.data as { horas: number | null }).horas) {
        ctx.addIssue({ code: "custom", message: "Indica después de cuántas horas en la etapa se dispara." });
        return z.NEVER;
      }
    }
    return { ...a, config: r.data as Record<string, unknown> };
  });

export type AutomatizacionEntrada = z.output<typeof automatizacionSchema>;

/** Valida y normaliza la respuesta del ejecutivo según el tipo de pregunta. */
export function validarRespuesta(
  config: Record<string, unknown>,
  crudo: unknown,
): { valor: string } | { error: string } {
  const texto = typeof crudo === "string" ? crudo.trim() : crudo === null || crudo === undefined ? "" : String(crudo);
  if (texto === "") return { error: "Escribe la respuesta." };
  switch (config.tipo_respuesta) {
    case "fecha": {
      const error = validarFechaCoherente(texto, "la respuesta");
      return error ? { error } : { valor: texto };
    }
    case "numero":
      return Number.isFinite(Number(texto)) ? { valor: texto } : { error: "La respuesta debe ser un número." };
    case "si_no":
      return texto === "Sí" || texto === "No" ? { valor: texto } : { error: "Responde Sí o No." };
    case "opcion":
      return Array.isArray(config.opciones) && config.opciones.includes(texto)
        ? { valor: texto }
        : { error: "La respuesta no está entre las opciones." };
    default:
      return texto.length <= 1000 ? { valor: texto } : { error: "La respuesta es demasiado larga." };
  }
}

/** Reemplaza {cliente}, {vin}, {campana}, {agencia} por los datos de la oportunidad. */
function rellenar(plantilla: string, datos: Record<string, unknown>): string {
  return plantilla.replace(/\{(cliente|vin|campana|agencia)\}/g, (_m, k: string) => String(datos[k] ?? ""));
}

type AccionTarea = { id: string; tipo: "tarea" | "pregunta"; config: Record<string, unknown> };
type DatosOportunidad = Record<string, unknown> & { ejecutivo: string | null };

/** Crea la tarea o pregunta de una automatización para el ejecutivo de la oportunidad. */
async function crearTarea(
  cliente: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  sucursalId: string,
  oportunidadId: string,
  a: AccionTarea,
  op: DatosOportunidad,
): Promise<void> {
  const cfg = a.config;
  const esPregunta = a.tipo === "pregunta";
  const titulo = rellenar(String(esPregunta ? cfg.texto : cfg.titulo), op);
  const descripcion = !esPregunta && cfg.descripcion ? rellenar(String(cfg.descripcion), op) : null;
  const venceHoras = typeof cfg.vence_horas === "number" ? cfg.vence_horas : null;
  await cliente.query(
    `INSERT INTO crm_tareas (sucursal_id, oportunidad_id, automatizacion_id, tipo, titulo, descripcion, config, asignado_a, vence_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9::int IS NULL THEN NULL ELSE now() + make_interval(hours => $9::int) END)`,
    [sucursalId, oportunidadId, a.id, a.tipo, titulo, descripcion, esPregunta ? cfg : {}, op.ejecutivo, venceHoras],
  );
}

const MAX_INTENTOS = 5;

/**
 * Procesa hasta `maximo` eventos pendientes. Cada evento va en su propia transacción: si uno
 * falla se anota el error y los demás siguen. SKIP LOCKED permite varios procesos sin pisarse.
 */
export async function procesarEventosCrm(maximo = 100): Promise<{ procesados: number; tareas: number }> {
  const pool = getPool();
  let procesados = 0;
  let tareas = 0;
  const sucursalesAfectadas = new Set<string>();
  const terminar = () => {
    for (const s of sucursalesAfectadas) emitirBroadcast(`datos:${s}`, "tareas", {});
    return { procesados, tareas };
  };

  for (let i = 0; i < maximo; i++) {
    const cliente = await pool.connect();
    let eventoId: string | null = null;
    try {
      await cliente.query("BEGIN");
      const { rows } = await cliente.query(
        `SELECT id, sucursal_id, oportunidad_id, datos FROM crm_eventos
          WHERE procesado_en IS NULL AND intentos < $1
          ORDER BY creado_en LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [MAX_INTENTOS],
      );
      const evento = rows[0];
      if (!evento) {
        await cliente.query("ROLLBACK");
        return terminar();
      }
      eventoId = evento.id as string;

      const destino = (evento.datos as { etapa_destino?: string }).etapa_destino;
      const { rows: oportunidades } = await cliente.query(
        `SELECT cliente, vin, campana, agencia, ejecutivo, etapa_id, estado_fuente FROM crm_v_oportunidades WHERE id = $1`,
        [evento.oportunidad_id],
      );
      const op = oportunidades[0];

      // Solo cuenta si la oportunidad sigue activa y aún está en esa etapa (no se crean tareas viejas).
      if (op && destino && op.etapa_id === destino && op.estado_fuente === "ACTIVA") {
        const { rows: acciones } = await cliente.query(
          `SELECT id, tipo, nombre, config FROM crm_automatizaciones
            WHERE etapa_id = $1 AND evento = 'entra_etapa' AND activa AND tipo IN ('tarea', 'pregunta') ORDER BY orden, creado_en`,
          [destino],
        );
        for (const a of acciones) {
          const { rowCount } = await cliente.query(
            `INSERT INTO crm_ejecuciones (automatizacion_id, oportunidad_id, evento_id) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [a.id, evento.oportunidad_id, evento.id],
          );
          if (!rowCount) continue; // ya se ejecutó para este evento

          await crearTarea(cliente, evento.sucursal_id as string, evento.oportunidad_id as string, a, op);
          tareas++;
          sucursalesAfectadas.add(evento.sucursal_id as string);
        }
      }

      await cliente.query(`UPDATE crm_eventos SET procesado_en = now(), error = NULL WHERE id = $1`, [evento.id]);
      await cliente.query("COMMIT");
      procesados++;
    } catch (err) {
      await cliente.query("ROLLBACK").catch(() => {});
      if (eventoId) {
        // Sin el texto del error de datos: solo el mensaje técnico, recortado.
        const mensaje = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        await pool
          .query(`UPDATE crm_eventos SET intentos = intentos + 1, error = $2 WHERE id = $1`, [eventoId, mensaje])
          .catch(() => {});
      }
      console.error("[motor-crm] error procesando un evento");
      return terminar();
    } finally {
      cliente.release();
    }
  }

  return terminar();
}

/**
 * Reglas por tiempo ("después de N horas en la etapa"). Revisa las oportunidades activas que ya
 * cumplieron el plazo y aún no tienen la tarea de ese ciclo (el ciclo es el instante en que
 * entraron a la etapa: si salen y vuelven, la regla puede correr otra vez). Con
 * `solo_sin_contacto`, no dispara si ya hubo una llamada o WhatsApp desde que entró.
 */
export async function procesarReglasPorTiempo(maximo = 200): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT a.id AS aid, a.tipo, a.config, a.sucursal_id, o.id AS oid, o.entro_a_etapa_en AS ciclo,
            v.cliente, v.vin, v.campana, v.agencia, v.ejecutivo
       FROM crm_automatizaciones a
       JOIN crm_oportunidades o ON o.etapa_id = a.etapa_id AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta'
       JOIN crm_v_oportunidades v ON v.id = o.id
      WHERE a.activa AND a.evento = 'tiempo_en_etapa' AND a.tipo IN ('tarea', 'pregunta')
        AND o.entro_a_etapa_en + make_interval(hours => (a.config->>'horas')::int) <= now()
        AND (coalesce((a.config->>'aplicar_a_existentes')::boolean, false) OR o.entro_a_etapa_en >= a.activa_desde)
        AND (NOT coalesce((a.config->>'solo_sin_contacto')::boolean, false) OR NOT EXISTS (
              SELECT 1 FROM crm_actividades x
               WHERE x.oportunidad_id = o.id AND x.tipo IN ('llamada', 'whatsapp') AND coalesce(x.detalle->>'origen', '') <> 'migracion'
                 AND x.creado_en >= o.entro_a_etapa_en))
        AND NOT EXISTS (SELECT 1 FROM crm_ejecuciones e WHERE e.automatizacion_id = a.id AND e.oportunidad_id = o.id AND e.ciclo = o.entro_a_etapa_en)
      LIMIT $1`,
    [maximo],
  );

  let creadas = 0;
  const sucursales = new Set<string>();
  for (const r of rows) {
    const cliente = await pool.connect();
    try {
      await cliente.query("BEGIN");
      const { rowCount } = await cliente.query(
        `INSERT INTO crm_ejecuciones (automatizacion_id, oportunidad_id, ciclo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [r.aid, r.oid, r.ciclo],
      );
      if (rowCount) {
        await crearTarea(cliente, r.sucursal_id, r.oid, { id: r.aid, tipo: r.tipo, config: r.config }, r);
        creadas++;
        sucursales.add(r.sucursal_id as string);
      }
      await cliente.query("COMMIT");
    } catch {
      await cliente.query("ROLLBACK").catch(() => {});
      console.error("[motor-crm] error en una regla por tiempo");
    } finally {
      cliente.release();
    }
  }
  for (const sid of sucursales) emitirBroadcast(`datos:${sid}`, "tareas", {});
  return creadas;
}

let temporizador: NodeJS.Timeout | null = null;
let corriendo = false;

/** Arranca el motor en este proceso: revisa la bandeja cada pocos segundos. */
export function iniciarMotorCrm(cadaMs = 5000): void {
  if (temporizador) return;
  let vuelta = 0;
  temporizador = setInterval(() => {
    if (corriendo) return;
    corriendo = true;
    vuelta++;
    const porTiempo = vuelta % Math.max(1, Math.round(60000 / cadaMs)) === 0;
    procesarEventosCrm()
      .then(async (r) => {
        const extra = porTiempo ? await procesarReglasPorTiempo() : 0;
        if (r.tareas + extra > 0) console.log(`[motor-crm] ${r.tareas + extra} tarea(s) creada(s)`);
      })
      .catch(() => console.error("[motor-crm] fallo la revisión de la bandeja"))
      .finally(() => {
        corriendo = false;
      });
  }, cadaMs);
  temporizador.unref();
}
