import { getPool } from "./db.js";
import { CAMPANAS_CONOCIDAS, ZONA_ENVIOS, ahoraLocal, dentroDeVentana } from "./campanasLogica.js";
import { crearMasivoDePaso, type Resultado } from "./masivos.js";
import { etiquetaCampana, ordenCampana, plantillaNoUsable, usoDePlantilla, VENTANA_MASIVOS, type Componentes } from "./masivosLogica.js";
import { ESPERA_POR_OMISION_HORAS, validarConfigSeguimiento, type ConfigSeguimiento } from "./seguimientoLogica.js";

/**
 * Mensaje automático de seguimiento para leads en «Contactado» (pedido de Miguel Borbón, 19-oct-2026): la configuración por
 * campaña y el repaso del motor. La lógica pura está en seguimientoLogica.ts.
 */

const aConfig = (r: Record<string, any> | undefined): ConfigSeguimiento => ({
  activa: r?.activa === true,
  plantillaId: (r?.plantilla_id as string | null) ?? null,
  esperaHoras: (r?.espera_horas as number | undefined) ?? ESPERA_POR_OMISION_HORAS,
  telefonosPrueba: (r?.telefonos_prueba as string[] | null) ?? [],
});

/**
 * Última interacción del lead: su última llamada registrada, el último mensaje de su conversación de WhatsApp (enviado o
 * recibido) o su «Fecha último contacto» (la pone cada llamada y se captura a mano; la traen los leads migrados del Sheet,
 * que no tienen llamadas registradas), desde el inicio de ese día.
 */
const SQL_ULTIMA_INTERACCION = `GREATEST(
   (SELECT max(a.creado_en) FROM crm_actividades a WHERE a.oportunidad_id = o.id AND a.tipo = 'llamada'),
   (o.fecha_ultimo_contacto::timestamp AT TIME ZONE '${ZONA_ENVIOS}'),
   (SELECT max(w.ultimo_mensaje_en) FROM whatsapp_conversaciones w
     WHERE w.sucursal_id = o.sucursal_id AND (w.contacto_id = o.contacto_id OR crm_tel10(w.wa_id) = crm_tel10(k.telefono))))`;

/** El paso ya tiene su seguimiento: en cola, mandado, fallido u omitido para siempre (una sola vez por paso). */
const SQL_YA_ENVIADO = `EXISTS (SELECT 1 FROM crm_envios e JOIN crm_masivos m ON m.id = e.masivo_id
   WHERE e.campana_id = p.id AND m.origen = 'seguimiento')`;

/** Lead abierto en «Contactado», sin su seguimiento todavía y sin un freno para siempre (baja, supresión, GE, pago). */
const SQL_EN_CONTACTADO = `o.estado = 'abierta' AND et.clave = 'contactado'
   AND NOT ${SQL_YA_ENVIADO}
   AND (cfg.plantilla_id IS NULL OR crm_motivo_no_enviar(o.id, cfg.plantilla_id, 'masivo') IS NULL)`;

/** Ya pasó la espera desde su última interacción. */
const SQL_YA_TOCA = `${SQL_ULTIMA_INTERACCION} <= now() - make_interval(hours => cfg.espera_horas)`;

/** En modo prueba solo cuentan los teléfonos de prueba. */
const SQL_EN_PRUEBA = `(cardinality(cfg.telefonos_prueba) = 0 OR crm_tel10(k.telefono) = ANY(cfg.telefonos_prueba))`;

const DESDE_PASOS = `crm_oportunidad_campanas p
   JOIN crm_oportunidades o ON o.id = p.oportunidad_id
   JOIN crm_contactos k ON k.id = o.contacto_id
   JOIN crm_etapas et ON et.id = o.etapa_id`;

/** Para la pantalla: cada campaña con su configuración, las plantillas posibles y cómo va. */
export async function leerSeguimiento(sucursalId: string) {
  const pool = getPool();
  const [{ rows: cfgs }, { rows: plantillas }, { rows: contactado }, { rows: estado }] = await Promise.all([
    pool.query(`SELECT campana, activa, plantilla_id, espera_horas, telefonos_prueba FROM crm_seguimiento_config WHERE sucursal_id = $1`, [
      sucursalId,
    ]),
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
    pool.query(`SELECT id::text AS id FROM crm_etapas WHERE sucursal_id = $1 AND clave = 'contactado'`, [sucursalId]),
    // Por campaña configurada: leads en «Contactado» esperando su seguimiento, a cuántos ya les toca (sin contar el modo
    // prueba: es a cuántos les llegaría con la regla abierta a todos) y cuántos seguimientos salieron hoy.
    pool.query(
      `SELECT cfg.campana,
              (SELECT count(*)::int FROM ${DESDE_PASOS}
                WHERE p.sucursal_id = cfg.sucursal_id AND p.campana = cfg.campana AND p.cerrada_en IS NULL AND ${SQL_EN_CONTACTADO}) AS en_contactado,
              (SELECT count(*)::int FROM ${DESDE_PASOS}
                WHERE p.sucursal_id = cfg.sucursal_id AND p.campana = cfg.campana AND p.cerrada_en IS NULL
                  AND ${SQL_EN_CONTACTADO} AND ${SQL_YA_TOCA}) AS ya_toca,
              (SELECT count(*)::int FROM crm_envios e JOIN crm_masivos m ON m.id = e.masivo_id
                WHERE m.sucursal_id = cfg.sucursal_id AND m.origen = 'seguimiento' AND m.campana = cfg.campana
                  AND e.estado IN ('enviado', 'entregado', 'leido')
                  AND (e.enviado_en AT TIME ZONE '${ZONA_ENVIOS}')::date = (now() AT TIME ZONE '${ZONA_ENVIOS}')::date) AS hoy
         FROM crm_seguimiento_config cfg
        WHERE cfg.sucursal_id = $1`,
      [sucursalId],
    ),
  ]);

  const porCampana = new Map(cfgs.map((c) => [c.campana as string, c]));
  const campanas = [...new Set<string>([...CAMPANAS_CONOCIDAS, ...cfgs.map((c) => c.campana as string)])].sort(
    (a, b) => ordenCampana(a) - ordenCampana(b),
  );
  // Plantillas de campaña, aprobadas, con sus datos ligados y para leads «Contactado».
  const idsContactado = new Set(contactado.map((e) => e.id as string));
  const usables = plantillas
    .filter((p) => usoDePlantilla(p.uso as string | null, p.categoria as string | null) === "campana")
    .filter((p) => !plantillaNoUsable({ estado: p.estado, componentes: p.componentes as Componentes }, (p.indices as number[]).map(Number)))
    .filter((p) => (p.estados as string[]).length === 0 || (p.estados as string[]).some((id) => idsContactado.has(id)))
    .map((p) => ({ id: p.id as string, nombre: p.nombre as string, campanas: p.campanas as string[] }));

  return {
    horario: { inicio: VENTANA_MASIVOS.hora_inicio, fin: VENTANA_MASIVOS.hora_fin },
    campanas: campanas.map((campana) => {
      const cfg = aConfig(porCampana.get(campana));
      const e = estado.find((x) => x.campana === campana);
      return {
        campana,
        etiqueta: etiquetaCampana(campana),
        activa: cfg.activa,
        plantilla_id: cfg.plantillaId,
        espera_horas: cfg.esperaHoras,
        telefonos_prueba: cfg.telefonosPrueba,
        plantillas: [
          ...usables.filter((p) => p.campanas.includes(campana)).map((p) => ({ id: p.id, nombre: p.nombre, de_la_campana: true })),
          ...usables.filter((p) => p.campanas.length === 0).map((p) => ({ id: p.id, nombre: p.nombre, de_la_campana: false })),
        ],
        en_contactado: (e?.en_contactado as number | undefined) ?? 0,
        ya_toca: (e?.ya_toca as number | undefined) ?? 0,
        enviados_hoy: (e?.hoy as number | undefined) ?? 0,
      };
    }),
  };
}

/** Guarda la configuración de una campaña: campañas conocidas o ya configuradas, y una plantilla de las que se ofrecen. */
export async function guardarSeguimiento(
  sucursalId: string,
  campana: string,
  datos: { activa: boolean; plantilla_id: string | null; espera_horas: number; telefonos_prueba: string[] },
  usuarioId: string | null,
): Promise<Resultado<null>> {
  const cfg: ConfigSeguimiento = {
    activa: datos.activa,
    plantillaId: datos.plantilla_id,
    esperaHoras: datos.espera_horas,
    telefonosPrueba: [...new Set(datos.telefonos_prueba.map((t) => t.replace(/\D/g, "").slice(-10)).filter(Boolean))],
  };
  const error = validarConfigSeguimiento(cfg);
  if (error) return { ok: false, error };
  const info = await leerSeguimiento(sucursalId);
  const fila = info.campanas.find((c) => c.campana === campana);
  if (!fila) return { ok: false, error: "Esa campaña no existe." };
  // Solo para encenderla: apagada se puede guardar aunque su plantilla ya no se ofrezca.
  if (cfg.activa && cfg.plantillaId && !fila.plantillas.some((p) => p.id === cfg.plantillaId)) {
    return { ok: false, error: "Esa plantilla no se puede usar: tiene que ser de campaña, estar aprobada, con sus datos ligados y para leads «Contactado»." };
  }
  await getPool().query(
    `INSERT INTO crm_seguimiento_config (sucursal_id, campana, activa, plantilla_id, espera_horas, telefonos_prueba, actualizado_en, actualizado_por)
     VALUES ($1, $2, $3, $4, $5, $6::text[], now(), (SELECT id FROM usuarios WHERE id = $7))
     ON CONFLICT (sucursal_id, campana) DO UPDATE
       SET activa = excluded.activa, plantilla_id = excluded.plantilla_id, espera_horas = excluded.espera_horas,
           telefonos_prueba = excluded.telefonos_prueba, actualizado_en = now(), actualizado_por = excluded.actualizado_por`,
    [sucursalId, campana, cfg.activa, cfg.plantillaId, cfg.esperaHoras, cfg.telefonosPrueba, usuarioId],
  );
  return { ok: true, valor: null };
}

/** Cada cuánto el motor revisa a quién ya le toca el seguimiento. */
const REPASO_MS = 15 * 60_000;
let ultimoRepaso = 0;

/**
 * Lo corre el motor cada 15 minutos, dentro del horario de envíos: a cada lead en «Contactado» al que ya le pasó la espera
 * desde su última interacción y aún no recibe su seguimiento, se lo arma (crearMasivoDePaso lo despacha con el freno de
 * siempre). En modo prueba solo a los teléfonos de prueba. Si la plantilla o WhatsApp no están disponibles, no se insiste
 * con los demás leads de esa campaña en esta vuelta.
 */
export async function programarSeguimientos(): Promise<number> {
  if (Date.now() - ultimoRepaso < REPASO_MS) return 0;
  if (!dentroDeVentana(ahoraLocal(), VENTANA_MASIVOS)) return 0;
  ultimoRepaso = Date.now();
  const { rows } = await getPool().query(
    `SELECT cfg.sucursal_id, cfg.campana, cfg.plantilla_id, cfg.telefonos_prueba, p.id AS paso_id, o.id AS oportunidad_id
       FROM crm_seguimiento_config cfg
       JOIN ${DESDE_PASOS} ON p.sucursal_id = cfg.sucursal_id AND p.campana = cfg.campana AND p.cerrada_en IS NULL
      WHERE cfg.activa AND cfg.plantilla_id IS NOT NULL
        AND ${SQL_EN_PRUEBA}
        AND ${SQL_EN_CONTACTADO}
        AND ${SQL_YA_TOCA}
      ORDER BY p.id
      LIMIT 200`,
  );
  let armados = 0;
  const caidas = new Set<string>();
  for (const r of rows) {
    const clave = `${r.sucursal_id}|${r.campana}`;
    if (caidas.has(clave)) continue;
    const res = await crearMasivoDePaso({
      origen: "seguimiento",
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
      console.error(`[seguimiento] ${r.campana}: ${res.motivo}`);
    }
  }
  if (armados > 0) console.log(`[seguimiento] ${armados} mensaje(s) de seguimiento en cola`);
  return armados;
}
