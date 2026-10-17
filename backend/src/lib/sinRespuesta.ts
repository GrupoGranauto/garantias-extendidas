import { getPool } from "./db.js";
import { CAMPANAS_CONOCIDAS, ZONA_ENVIOS, ahoraLocal, dentroDeVentana } from "./campanasLogica.js";
import { ETIQUETA_LLAMADA } from "./gestionLogica.js";
import { crearMasivoSinRespuesta, type Resultado } from "./masivos.js";
import {
  TEXTO_MOTIVO,
  etiquetaCampana,
  ordenCampana,
  plantillaNoUsable,
  usoDePlantilla,
  VENTANA_MASIVOS,
  type Componentes,
} from "./masivosLogica.js";
import {
  INTENTOS_POR_OMISION,
  RESULTADOS_LLAMADA,
  RESULTADOS_POR_OMISION,
  avanceSinRespuesta,
  validarConfigSinRespuesta,
  type ConfigSinRespuesta,
} from "./sinRespuestaLogica.js";

/**
 * Mensaje automático por llamadas sin respuesta (pedido de Miguel Borbón, 16-oct-2026): la configuración por campaña, lo que
 * muestra la ficha del lead y el programador que corre el motor. La lógica pura está en sinRespuestaLogica.ts.
 */

const aConfig = (r: Record<string, any> | undefined): ConfigSinRespuesta => ({
  activa: r?.activa === true,
  plantillaId: (r?.plantilla_id as string | null) ?? null,
  intentos: (r?.intentos as number | undefined) ?? INTENTOS_POR_OMISION,
  resultados: (r?.resultados as string[] | undefined) ?? [...RESULTADOS_POR_OMISION],
  telefonosPrueba: (r?.telefonos_prueba as string[] | null) ?? [],
});

/** Llamadas de un paso que cuentan para el mensaje: las registradas con alguno de los resultados elegidos. */
const SQL_LLAMADAS_QUE_CUENTAN = `(SELECT count(*)::int FROM crm_actividades a
   WHERE a.campana_id = p.id AND a.tipo = 'llamada' AND a.detalle ->> 'resultado_llamada' = ANY(cfg.resultados))`;

/** El paso ya tiene su mensaje de este origen: en cola, mandado, fallido u omitido para siempre (una sola vez por paso). */
const SQL_YA_ENVIADO = `EXISTS (SELECT 1 FROM crm_envios e JOIN crm_masivos m ON m.id = e.masivo_id
   WHERE e.campana_id = p.id AND m.origen = 'sin_respuesta')`;

/** La última llamada del paso fue sin respuesta: si después contestó el titular, ya no se le manda. */
const SQL_ULTIMA_CUENTA = `(SELECT a.detalle ->> 'resultado_llamada' FROM crm_actividades a
   WHERE a.campana_id = p.id AND a.tipo = 'llamada' ORDER BY a.creado_en DESC LIMIT 1) = ANY(cfg.resultados)`;

/**
 * Listo para el mensaje (sin contar el modo prueba): lead abierto, con el número de llamadas que cuentan, la última sin
 * respuesta, sin el mensaje todavía y sin un freno para siempre (baja, supresión, GE, pago).
 */
const SQL_LISTO = `o.estado = 'abierta'
   AND ${SQL_LLAMADAS_QUE_CUENTAN} >= cfg.intentos
   AND ${SQL_ULTIMA_CUENTA}
   AND NOT ${SQL_YA_ENVIADO}
   AND (cfg.plantilla_id IS NULL OR crm_motivo_no_enviar(o.id, cfg.plantilla_id, 'masivo') IS NULL)`;

const textoMotivo = (m: string) => TEXTO_MOTIVO[m] ?? (m === "no_encontrada" ? "ya no está en la base" : m);

/** En modo prueba solo cuentan los teléfonos de prueba. */
const SQL_EN_PRUEBA = `(cardinality(cfg.telefonos_prueba) = 0 OR crm_tel10(k.telefono) = ANY(cfg.telefonos_prueba))`;

/** Para la pantalla: cada campaña con su configuración, las plantillas posibles y cómo va. */
export async function leerSinRespuesta(sucursalId: string) {
  const pool = getPool();
  const [{ rows: cfgs }, { rows: plantillas }, { rows: porContactar }, { rows: estado }] = await Promise.all([
    pool.query(
      `SELECT campana, activa, plantilla_id, intentos, resultados, telefonos_prueba FROM crm_sin_respuesta_config WHERE sucursal_id = $1`,
      [sucursalId],
    ),
    pool.query(
      `SELECT p.id, coalesce(p.nombre, p.nombre_tecnico) AS nombre, p.estado, p.componentes, coalesce(r.campanas, '{}') AS campanas,
              coalesce(r.estados::text[], '{}') AS estados, r.uso, p.categoria,
              coalesce((SELECT array_agg(v.indice) FROM whatsapp_plantilla_variables v WHERE v.plantilla_id = p.id), '{}') AS indices
         FROM whatsapp_plantillas p
         LEFT JOIN crm_plantilla_reglas r ON r.plantilla_id = p.id
        WHERE p.sucursal_id = $1 AND p.estado = 'aprobada'
        ORDER BY 2`,
      [sucursalId],
    ),
    pool.query(`SELECT id::text AS id FROM crm_etapas WHERE sucursal_id = $1 AND clave = 'por_contactar'`, [sucursalId]),
    // Por campaña configurada: cuántos leads ya llegaron al número de llamadas y esperan su mensaje (sin contar el modo
    // prueba: es a cuántos les llegaría con la regla abierta a todos), y cuántos mensajes salieron hoy.
    pool.query(
      `SELECT cfg.campana,
              (SELECT count(*)::int FROM crm_oportunidad_campanas p
                 JOIN crm_oportunidades o ON o.id = p.oportunidad_id
                WHERE p.sucursal_id = cfg.sucursal_id AND p.campana = cfg.campana AND p.cerrada_en IS NULL AND ${SQL_LISTO}) AS esperando,
              (SELECT count(*)::int FROM crm_envios e JOIN crm_masivos m ON m.id = e.masivo_id
                WHERE m.sucursal_id = cfg.sucursal_id AND m.origen = 'sin_respuesta' AND m.campana = cfg.campana
                  AND e.estado IN ('enviado', 'entregado', 'leido')
                  AND (e.enviado_en AT TIME ZONE '${ZONA_ENVIOS}')::date = (now() AT TIME ZONE '${ZONA_ENVIOS}')::date) AS hoy
         FROM crm_sin_respuesta_config cfg
        WHERE cfg.sucursal_id = $1`,
      [sucursalId],
    ),
  ]);

  const porCampana = new Map(cfgs.map((c) => [c.campana as string, c]));
  const campanas = [...new Set<string>([...CAMPANAS_CONOCIDAS, ...cfgs.map((c) => c.campana as string)])].sort(
    (a, b) => ordenCampana(a) - ordenCampana(b),
  );
  // Igual que el primer mensaje: plantillas de campaña, aprobadas, con sus datos ligados y para leads «Por contactar».
  const idsPorContactar = new Set(porContactar.map((e) => e.id as string));
  const usables = plantillas
    .filter((p) => usoDePlantilla(p.uso as string | null, p.categoria as string | null) === "campana")
    .filter((p) => !plantillaNoUsable({ estado: p.estado, componentes: p.componentes as Componentes }, (p.indices as number[]).map(Number)))
    .filter((p) => (p.estados as string[]).length === 0 || (p.estados as string[]).some((id) => idsPorContactar.has(id)))
    .map((p) => ({ id: p.id as string, nombre: p.nombre as string, campanas: p.campanas as string[] }));

  return {
    horario: { inicio: VENTANA_MASIVOS.hora_inicio, fin: VENTANA_MASIVOS.hora_fin },
    resultados: RESULTADOS_LLAMADA.filter((r) => r !== "CONTESTA_TITULAR").map((r) => ({ valor: r, texto: ETIQUETA_LLAMADA[r] })),
    campanas: campanas.map((campana) => {
      const cfg = aConfig(porCampana.get(campana));
      const e = estado.find((x) => x.campana === campana);
      return {
        campana,
        etiqueta: etiquetaCampana(campana),
        activa: cfg.activa,
        plantilla_id: cfg.plantillaId,
        intentos: cfg.intentos,
        resultados: cfg.resultados,
        telefonos_prueba: cfg.telefonosPrueba,
        plantillas: [
          ...usables.filter((p) => p.campanas.includes(campana)).map((p) => ({ id: p.id, nombre: p.nombre, de_la_campana: true })),
          ...usables.filter((p) => p.campanas.length === 0).map((p) => ({ id: p.id, nombre: p.nombre, de_la_campana: false })),
        ],
        esperando: (e?.esperando as number | undefined) ?? 0,
        enviados_hoy: (e?.hoy as number | undefined) ?? 0,
      };
    }),
  };
}

/** Guarda la configuración de una campaña: campañas conocidas o ya configuradas, y una plantilla de las que se ofrecen. */
export async function guardarSinRespuesta(
  sucursalId: string,
  campana: string,
  datos: { activa: boolean; plantilla_id: string | null; intentos: number; resultados: string[]; telefonos_prueba: string[] },
  usuarioId: string | null,
): Promise<Resultado<null>> {
  const cfg: ConfigSinRespuesta = {
    activa: datos.activa,
    plantillaId: datos.plantilla_id,
    intentos: datos.intentos,
    resultados: [...new Set(datos.resultados)],
    telefonosPrueba: [...new Set(datos.telefonos_prueba.map((t) => t.replace(/\D/g, "").slice(-10)).filter(Boolean))],
  };
  const error = validarConfigSinRespuesta(cfg);
  if (error) return { ok: false, error };
  const info = await leerSinRespuesta(sucursalId);
  const fila = info.campanas.find((c) => c.campana === campana);
  if (!fila) return { ok: false, error: "Esa campaña no existe." };
  // Solo para encenderla: apagada se puede guardar aunque su plantilla ya no se ofrezca (por ejemplo, la pausó Meta).
  if (cfg.activa && cfg.plantillaId && !fila.plantillas.some((p) => p.id === cfg.plantillaId)) {
    return { ok: false, error: "Esa plantilla no se puede usar: tiene que ser de campaña, estar aprobada, con sus datos ligados y ser de esta campaña o general." };
  }
  await getPool().query(
    `INSERT INTO crm_sin_respuesta_config (sucursal_id, campana, activa, plantilla_id, intentos, resultados, telefonos_prueba, actualizado_en, actualizado_por)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], now(), (SELECT id FROM usuarios WHERE id = $8))
     ON CONFLICT (sucursal_id, campana) DO UPDATE
       SET activa = excluded.activa, plantilla_id = excluded.plantilla_id, intentos = excluded.intentos, resultados = excluded.resultados,
           telefonos_prueba = excluded.telefonos_prueba, actualizado_en = now(), actualizado_por = excluded.actualizado_por`,
    [sucursalId, campana, cfg.activa, cfg.plantillaId, cfg.intentos, cfg.resultados, cfg.telefonosPrueba, usuarioId],
  );
  return { ok: true, valor: null };
}

/**
 * Para la ficha del lead: cómo va su paso abierto hacia el mensaje de sin respuesta (null si su campaña no lo tiene
 * encendido o el lead no tiene paso abierto). `envio` es el mensaje de ese paso, si ya hay uno (en cola, mandado, fallido u
 * omitido, con su motivo).
 */
export async function avanceDelLead(sucursalId: string, oportunidadId: string) {
  const { rows } = await getPool().query(
    `SELECT cfg.intentos, cfg.resultados, ${SQL_LLAMADAS_QUE_CUENTAN} AS contadas, ${SQL_EN_PRUEBA} AS en_prueba,
            coalesce(${SQL_ULTIMA_CUENTA}, false) AS ultima_cuenta,
            (SELECT count(*)::int FROM crm_actividades a WHERE a.campana_id = p.id AND a.tipo = 'llamada') AS llamadas,
            (SELECT jsonb_build_object('estado', e.estado, 'motivo', e.motivo) FROM crm_envios e JOIN crm_masivos m ON m.id = e.masivo_id
              WHERE e.campana_id = p.id AND m.origen = 'sin_respuesta' ORDER BY e.creado_en DESC LIMIT 1) AS envio
       FROM crm_oportunidad_campanas p
       JOIN crm_oportunidades o ON o.id = p.oportunidad_id
       JOIN crm_contactos k ON k.id = o.contacto_id
       JOIN crm_sin_respuesta_config cfg ON cfg.sucursal_id = p.sucursal_id AND cfg.campana = p.campana AND cfg.activa
      WHERE p.sucursal_id = $1 AND p.oportunidad_id = $2 AND p.cerrada_en IS NULL
      LIMIT 1`,
    [sucursalId, oportunidadId],
  );
  const r = rows[0];
  if (!r) return null;
  const envio = r.envio as { estado: string; motivo: string | null } | null;
  return {
    llamadas: r.llamadas as number,
    ...avanceSinRespuesta(r.contadas as number, r.intentos as number),
    intentos: r.intentos as number,
    resultados: (r.resultados as string[]).map((x) => ETIQUETA_LLAMADA[x as keyof typeof ETIQUETA_LLAMADA] ?? x),
    // Modo prueba y este lead no es de prueba: a él no le sale.
    fuera_de_prueba: r.en_prueba !== true,
    // Su última llamada sí tuvo respuesta: ya no se le manda.
    contesto: r.ultima_cuenta !== true && (r.llamadas as number) > 0,
    envio: envio ? { estado: envio.estado, motivo: envio.motivo ? textoMotivo(envio.motivo) : null } : null,
  };
}

/** Cada cuánto el motor repasa a los que se tuvieron que posponer; lo normal es que el mensaje salga al registrar la llamada. */
const REPASO_MS = 15 * 60_000;
let ultimoRepaso = 0;

/**
 * Leads listos para el mensaje (SQL_LISTO, y en modo prueba solo los teléfonos de prueba). Con `oportunidadId`, solo ese
 * lead. Si la plantilla o WhatsApp no están disponibles, no se insiste con los demás leads de esa campaña en esta vuelta.
 */
async function listos(oportunidadId: string | null) {
  const { rows } = await getPool().query(
    `SELECT cfg.sucursal_id, cfg.campana, cfg.plantilla_id, cfg.telefonos_prueba, p.id AS paso_id, o.id AS oportunidad_id
       FROM crm_sin_respuesta_config cfg
       JOIN crm_oportunidad_campanas p ON p.sucursal_id = cfg.sucursal_id AND p.campana = cfg.campana AND p.cerrada_en IS NULL
       JOIN crm_oportunidades o ON o.id = p.oportunidad_id
       JOIN crm_contactos k ON k.id = o.contacto_id
      WHERE cfg.activa AND cfg.plantilla_id IS NOT NULL
        AND ($1::uuid IS NULL OR o.id = $1::uuid)
        AND ${SQL_EN_PRUEBA}
        AND ${SQL_LISTO}
      ORDER BY p.id
      LIMIT 200`,
    [oportunidadId],
  );
  let armados = 0;
  const caidas = new Set<string>();
  for (const r of rows) {
    const clave = `${r.sucursal_id}|${r.campana}`;
    if (caidas.has(clave)) continue;
    const res = await crearMasivoSinRespuesta({
      sucursalId: r.sucursal_id as string,
      oportunidadId: r.oportunidad_id as string,
      pasoId: r.paso_id as string,
      campana: r.campana as string,
      plantillaId: r.plantilla_id as string,
      telefonosPrueba: (r.telefonos_prueba as string[]) ?? [],
    });
    if (res.creado) armados++;
    if (res.general) {
      caidas.add(clave);
      console.error(`[sin-respuesta] ${r.campana}: ${res.motivo}`);
    }
  }
  return armados;
}

/**
 * Al registrar una llamada: si con ella el lead llegó al número de llamadas, el mensaje queda en cola en ese momento (fuera
 * del horario de envíos, para la siguiente apertura). Nunca falla el registro de la llamada.
 */
export async function revisarSinRespuestaDelLead(oportunidadId: string): Promise<void> {
  try {
    if ((await listos(oportunidadId)) > 0) console.log(`[sin-respuesta] mensaje en cola al registrar la llamada (${oportunidadId})`);
  } catch (err) {
    console.error("[sin-respuesta] no se pudo revisar el lead al registrar la llamada", err);
  }
}

/**
 * Repaso del motor cada 15 minutos, dentro del horario de envíos: los que llegaron al número de llamadas pero no pudieron
 * recibir el mensaje en ese momento (por ejemplo, ya habían recibido otro mensaje ese día). crearMasivoSinRespuesta lo
 * despacha con el freno de siempre.
 */
export async function programarSinRespuesta(): Promise<number> {
  if (Date.now() - ultimoRepaso < REPASO_MS) return 0;
  if (!dentroDeVentana(ahoraLocal(), VENTANA_MASIVOS)) return 0;
  ultimoRepaso = Date.now();
  const armados = await listos(null);
  if (armados > 0) console.log(`[sin-respuesta] ${armados} mensaje(s) en cola por llamadas sin respuesta`);
  return armados;
}
