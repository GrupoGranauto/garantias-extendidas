import { getPool } from "./db.js";
import { CAMPANAS_CONOCIDAS, ZONA_ENVIOS, ahoraLocal } from "./campanasLogica.js";
import { crearMasivoAutomatico, type Resultado } from "./masivos.js";
import { etiquetaCampana, ordenCampana, plantillaNoUsable, VENTANA_MASIVOS, type Componentes } from "./masivosLogica.js";
import { HORA_SIN_BASE, hayQueEsperarBase, proximoEnvio, tocaCorrer, validarConfig, type ConfigPrimerMensaje } from "./primerMensajeLogica.js";

/**
 * Primer mensaje automático por campaña. Lo único que sale solo: cada día permitido, a partir de su hora, el motor arma un
 * masivo por campaña con los leads que aún no lo reciben (crearMasivoAutomatico). Aquí vive la configuración y el programador.
 */

const hhmm = (v: unknown) => String(v ?? "").slice(0, 5);

const aConfig = (r: Record<string, any> | undefined): ConfigPrimerMensaje => ({
  activa: r?.activa === true,
  plantillaId: (r?.plantilla_id as string | null) ?? null,
  diasSemana: ((r?.dias_semana as number[] | null) ?? [1, 2, 3, 4, 5, 6]).map(Number),
  hora: r?.hora ? hhmm(r.hora) : "10:30",
  telefonosPrueba: (r?.telefonos_prueba as string[] | null) ?? [],
});

/**
 * Si ya no hay que esperar la actualización de la base de hoy: ya corrió, el grupo no la usa, o lleva tanto sin correr
 * que no va a llegar (entonces sale a su hora con la base que hay).
 */
async function baseActualizadaHoy(sucursalId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT coalesce((SELECT sync_bigquery FROM crm_config WHERE sucursal_id = $1), false) AS usa,
            u.creado_en IS NOT NULL AND (u.creado_en AT TIME ZONE '${ZONA_ENVIOS}')::date = (now() AT TIME ZONE '${ZONA_ENVIOS}')::date AS hoy,
            extract(epoch FROM now() - u.creado_en) / 3600 AS horas
       FROM (SELECT max(creado_en) AS creado_en FROM crm_sync_corridas
              WHERE sucursal_id = $1 AND modo = 'real' AND estado = 'ok') u`,
    [sucursalId],
  );
  const r = rows[0];
  return !hayQueEsperarBase({
    usaActualizacion: r?.usa === true,
    actualizadaHoy: r?.hoy === true,
    horasDesdeUltima: r?.horas === null || r?.horas === undefined ? null : Number(r.horas),
  });
}

/** Para la pantalla: cada campaña con su configuración, sus plantillas posibles, cuántos esperan y cómo le fue la última vez. */
export async function leerPrimerMensaje(sucursalId: string) {
  const pool = getPool();
  const hoy = ahoraLocal();
  const [{ rows: cfgs }, { rows: plantillas }, { rows: pendientes }, { rows: ultimas }, base, { rows: porContactar }] = await Promise.all([
    pool.query(
      `SELECT campana, activa, plantilla_id, dias_semana, hora::text AS hora, telefonos_prueba FROM crm_primer_mensaje_config WHERE sucursal_id = $1`,
      [sucursalId],
    ),
    pool.query(
      `SELECT p.id, coalesce(p.nombre, p.nombre_tecnico) AS nombre, p.estado, p.componentes, coalesce(r.campanas, '{}') AS campanas,
              coalesce(r.estados::text[], '{}') AS estados,
              coalesce((SELECT array_agg(v.indice) FROM whatsapp_plantilla_variables v WHERE v.plantilla_id = p.id), '{}') AS indices
         FROM whatsapp_plantillas p
         LEFT JOIN crm_plantilla_reglas r ON r.plantilla_id = p.id
        WHERE p.sucursal_id = $1 AND p.estado = 'aprobada'
        ORDER BY 2`,
      [sucursalId],
    ),
    // Leads con su paso abierto que todavía no reciben ningún mensaje en esa campaña (antes de las reglas de la plantilla).
    pool.query(
      `SELECT p.campana, count(*)::int AS n
         FROM crm_oportunidad_campanas p
         JOIN crm_oportunidades o ON o.id = p.oportunidad_id AND o.estado = 'abierta'
        WHERE p.sucursal_id = $1 AND p.cerrada_en IS NULL
          AND NOT EXISTS (SELECT 1 FROM crm_envios x WHERE x.campana_id = p.id AND (x.primer_mensaje_intento IS NOT NULL OR x.estado IN ('pendiente', 'enviado', 'entregado', 'leido')))
        GROUP BY p.campana`,
      [sucursalId],
    ),
    pool.query(
      `SELECT DISTINCT ON (m.campana) m.id, m.campana, m.fecha_local::text AS fecha, m.creado_en, m.estado, m.nota,
              (SELECT count(*) FROM crm_envios e WHERE e.masivo_id = m.id AND e.estado IN ('enviado', 'entregado', 'leido'))::int AS enviados,
              (SELECT count(*) FROM crm_envios e WHERE e.masivo_id = m.id AND e.estado = 'pendiente')::int AS en_cola,
              (SELECT count(*) FROM crm_envios e WHERE e.masivo_id = m.id AND e.estado = 'fallido')::int AS fallidos,
              coalesce((SELECT sum((x->>'n')::int) FROM jsonb_array_elements(m.omitidos_resumen) x), 0)::int AS omitidos,
              coalesce(m.omitidos_resumen, '[]'::jsonb) AS omitidos_resumen
         FROM crm_masivos m
        WHERE m.sucursal_id = $1 AND m.automatico
        ORDER BY m.campana, m.creado_en DESC`,
      [sucursalId],
    ),
    baseActualizadaHoy(sucursalId),
    pool.query(`SELECT id::text AS id FROM crm_etapas WHERE sucursal_id = $1 AND clave = 'por_contactar'`, [sucursalId]),
  ]);

  const porCampana = new Map(cfgs.map((c) => [c.campana as string, c]));
  const campanas = [...new Set<string>([...CAMPANAS_CONOCIDAS, ...cfgs.map((c) => c.campana as string)])].sort(
    (a, b) => ordenCampana(a) - ordenCampana(b),
  );
  // Un primer mensaje es para leads «Por contactar»: las plantillas de otro estado (pago, póliza…) nunca les llegarían.
  const idsPorContactar = new Set(porContactar.map((e) => e.id as string));
  const usables = plantillas
    .filter((p) => !plantillaNoUsable({ estado: p.estado, componentes: p.componentes as Componentes }, (p.indices as number[]).map(Number)))
    .filter((p) => (p.estados as string[]).length === 0 || (p.estados as string[]).some((id) => idsPorContactar.has(id)))
    .map((p) => ({ id: p.id as string, nombre: p.nombre as string, campanas: p.campanas as string[] }));

  return {
    horario: { inicio: VENTANA_MASIVOS.hora_inicio, fin: VENTANA_MASIVOS.hora_fin },
    hora_sin_base: HORA_SIN_BASE,
    base_actualizada_hoy: base,
    campanas: campanas.map((campana) => {
      const cfg = aConfig(porCampana.get(campana));
      const ultima = ultimas.find((u) => u.campana === campana) ?? null;
      const corrioHoy = ultima?.fecha === hoy.fecha;
      const t = tocaCorrer(cfg, hoy, { yaCorrioHoy: corrioHoy, baseActualizadaHoy: base });
      return {
        campana,
        etiqueta: etiquetaCampana(campana),
        activa: cfg.activa,
        plantilla_id: cfg.plantillaId,
        dias_semana: cfg.diasSemana,
        hora: cfg.hora,
        telefonos_prueba: cfg.telefonosPrueba,
        // Primero las de esta campaña; luego las generales (sin campaña en «A quién»).
        plantillas: [
          ...usables.filter((p) => p.campanas.includes(campana)).map((p) => ({ id: p.id, nombre: p.nombre, de_la_campana: true })),
          ...usables.filter((p) => p.campanas.length === 0).map((p) => ({ id: p.id, nombre: p.nombre, de_la_campana: false })),
        ],
        sin_primer_mensaje: (pendientes.find((p) => p.campana === campana)?.n as number | undefined) ?? 0,
        proximo: proximoEnvio(cfg, hoy, corrioHoy),
        esperando_base: !t.toca && t.espera === "base",
        ultima: ultima
          ? {
              id: ultima.id as string,
              fecha: ultima.fecha as string,
              creado_en: ultima.creado_en as string,
              enviados: ultima.enviados as number,
              en_cola: ultima.en_cola as number,
              fallidos: ultima.fallidos as number,
              omitidos: ultima.omitidos as number,
              omitidos_resumen: ultima.omitidos_resumen as { motivo: string; texto: string; n: number }[],
              nota: (ultima.nota as string | null) ?? null,
            }
          : null,
      };
    }),
  };
}

/** Guarda la configuración de una campaña (solo campañas conocidas o ya configuradas, y una plantilla que sí se pueda mandar). */
export async function guardarPrimerMensaje(
  sucursalId: string,
  campana: string,
  datos: { activa: boolean; plantilla_id: string | null; dias_semana: number[]; hora: string; telefonos_prueba: string[] },
  usuarioId: string | null,
): Promise<Resultado<null>> {
  const cfg: ConfigPrimerMensaje = {
    activa: datos.activa,
    plantillaId: datos.plantilla_id,
    diasSemana: [...new Set(datos.dias_semana)].sort((a, b) => a - b),
    hora: datos.hora,
    telefonosPrueba: [...new Set(datos.telefonos_prueba.map((t) => t.replace(/\D/g, "").slice(-10)).filter(Boolean))],
  };
  const error = validarConfig(cfg);
  if (error) return { ok: false, error };

  const info = await leerPrimerMensaje(sucursalId);
  const fila = info.campanas.find((c) => c.campana === campana);
  if (!fila) return { ok: false, error: "Esa campaña no existe." };
  if (cfg.plantillaId && !fila.plantillas.some((p) => p.id === cfg.plantillaId)) {
    return { ok: false, error: "Esa plantilla no se puede usar: tiene que estar aprobada, con sus datos ligados y ser de esta campaña o general." };
  }

  await getPool().query(
    `INSERT INTO crm_primer_mensaje_config (sucursal_id, campana, activa, plantilla_id, dias_semana, hora, telefonos_prueba, actualizado_en, actualizado_por)
     VALUES ($1, $2, $3, $4, $5::smallint[], $6::time, $7::text[], now(), (SELECT id FROM usuarios WHERE id = $8))
     ON CONFLICT (sucursal_id, campana) DO UPDATE
       SET activa = excluded.activa, plantilla_id = excluded.plantilla_id, dias_semana = excluded.dias_semana, hora = excluded.hora,
           telefonos_prueba = excluded.telefonos_prueba, actualizado_en = now(), actualizado_por = excluded.actualizado_por`,
    [sucursalId, campana, cfg.activa, cfg.plantillaId, cfg.diasSemana, cfg.hora, cfg.telefonosPrueba, usuarioId],
  );
  return { ok: true, valor: null };
}

/**
 * Lo corre el motor cada minuto: para cada campaña encendida, si hoy le toca (día, hora, base del día) y todavía no corre,
 * arma su masivo del día. El índice único de crm_masivos garantiza uno por campaña y día aunque corran dos procesos.
 */
export async function programarPrimerosMensajes(): Promise<number> {
  const pool = getPool();
  const ahora = ahoraLocal();
  const { rows } = await pool.query(
    `SELECT c.sucursal_id, c.campana, c.activa, c.plantilla_id, c.dias_semana, c.hora::text AS hora, c.telefonos_prueba,
            EXISTS (SELECT 1 FROM crm_masivos m WHERE m.sucursal_id = c.sucursal_id AND m.automatico AND m.campana = c.campana
                                                 AND m.fecha_local = $1::date) AS ya_corrio
       FROM crm_primer_mensaje_config c
      WHERE c.activa AND c.plantilla_id IS NOT NULL`,
    [ahora.fecha],
  );
  const bases = new Map<string, boolean>();
  let armados = 0;
  for (const r of rows) {
    const sucursalId = r.sucursal_id as string;
    if (!bases.has(sucursalId)) bases.set(sucursalId, await baseActualizadaHoy(sucursalId));
    const t = tocaCorrer(aConfig(r), ahora, { yaCorrioHoy: r.ya_corrio === true, baseActualizadaHoy: bases.get(sucursalId)! });
    if (!t.toca) continue;
    const res = await crearMasivoAutomatico(sucursalId, r.campana as string, r.plantilla_id as string, ahora.fecha, (r.telefonos_prueba as string[]) ?? []);
    if (res.creado) {
      armados++;
      console.log(
        `[primer-mensaje] ${r.campana}: ${res.enviar} en cola, ${res.omitidos} omitidos${res.nota ? ` (${res.nota})` : ""} (sucursal ${sucursalId})`,
      );
    }
  }
  return armados;
}
