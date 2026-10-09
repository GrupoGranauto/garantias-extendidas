import { getPool } from "./db.js";
import { esPeticionDeBaja, telefono10 } from "./campanasLogica.js";

/**
 * Vínculo automático entre WhatsApp y la base cargada en la web.
 *
 * Cada conversación se cruza por los últimos 10 dígitos del teléfono con los contactos del CRM: así el
 * chat sabe quién es la persona, de qué campaña y etapa viene y qué ejecutivo la lleva, sin depender de
 * ninguna columna configurada a mano. Lo que escribe el cliente y lo que se le manda desde el chat queda
 * también en el historial de su oportunidad.
 */

export type Vinculo = {
  contacto_id: string;
  nombre: string | null;
  oportunidad_id: string | null;
  ejecutivo: string | null;
};

const ZONA = "America/Hermosillo";

/** Contacto de la base que corresponde a un wa_id, con su oportunidad más relevante (activa y abierta primero). */
export async function buscarVinculo(sucursalId: string, waId: string): Promise<Vinculo | null> {
  const tel = telefono10(waId);
  if (!tel) return null;
  const { rows } = await getPool().query(
    `SELECT c.id AS contacto_id, c.nombre, o.id AS oportunidad_id, o.ejecutivo
       FROM crm_contactos c
       LEFT JOIN LATERAL (
         SELECT x.id, x.ejecutivo FROM crm_oportunidades x WHERE x.contacto_id = c.id
          ORDER BY (x.estado_cartera = 'ACTIVA' AND x.estado = 'abierta') DESC, x.creado_en DESC LIMIT 1
       ) o ON true
      WHERE c.sucursal_id = $1 AND right(regexp_replace(coalesce(c.telefono, ''), '\\D', '', 'g'), 10) = $2
      ORDER BY c.actualizado_en DESC LIMIT 1`,
    [sucursalId, tel],
  );
  return (rows[0] as Vinculo | undefined) ?? null;
}

/**
 * Alguien escribió desde el teléfono del cliente: queda en el historial de su oportunidad y la respuesta cae en la cola
 * «por clasificar» (Notion). Todavía no se sabe quién escribió, así que no cuenta como contacto efectivo: si el ejecutivo
 * la clasifica como «Titular», ahí pasa a Contactado («Solicita info por WhatsApp»); otra persona, spam o número
 * equivocado no lo mueven. Una petición de baja la atiende el webhook aparte y no necesita clasificarse.
 */
export async function registrarEntrante(sucursalId: string, v: Vinculo, resumen: string | null): Promise<void> {
  if (!v.oportunidad_id) return;
  await getPool().query(
    `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle) VALUES ($1, $2, 'mensaje_entrante', 'WhatsApp: el cliente escribió', $3)`,
    [sucursalId, v.oportunidad_id, { resumen: resumen ? resumen.slice(0, 140) : null }],
  );
  if (resumen !== null && esPeticionDeBaja(resumen)) return;
  // Si ya se identificó al titular en esta campaña, sus mensajes siguientes no se vuelven a clasificar (y la clasificación
  // no se pierde). A una persona dada de baja no se le abre la cola.
  await getPool().query(
    `UPDATE crm_oportunidades o
        SET fecha_ultimo_contacto = (now() AT TIME ZONE '${ZONA}')::date,
            respuesta_por_clasificar = (o.clasificacion_respuesta IS DISTINCT FROM 'TITULAR')
       FROM crm_contactos c
      WHERE o.id = $1 AND o.sucursal_id = $2 AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta'
        AND c.id = o.contacto_id AND NOT c.whatsapp_baja AND o.estado_contacto <> 'baja'`,
    [v.oportunidad_id, sucursalId],
  );
}

/** Un ejecutivo escribió desde el chat: queda en el historial de la oportunidad activa de ese contacto. */
export async function registrarSalienteChat(sucursalId: string, conversacionId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle)
     SELECT $1, o.id, 'whatsapp', 'WhatsApp: mensaje enviado desde el chat', '{"origen":"chat"}'::jsonb
       FROM whatsapp_conversaciones cv
       JOIN LATERAL (
         SELECT x.id FROM crm_oportunidades x WHERE x.contacto_id = cv.contacto_id AND x.estado_cartera = 'ACTIVA' AND x.estado = 'abierta'
          ORDER BY x.creado_en DESC LIMIT 1
       ) o ON true
      WHERE cv.id = $2 AND cv.sucursal_id = $1`,
    [sucursalId, conversacionId],
  );
}

/** Liga las conversaciones que ya coinciden con la base (idempotente). Sin sucursal, revisa todas. */
export async function vincularConversaciones(sucursalId: string | null = null): Promise<number> {
  const { rows } = await getPool().query(`SELECT crm_vincular_conversaciones($1) AS n`, [sucursalId]);
  return (rows[0]?.n as number | undefined) ?? 0;
}

/** Datos del lead de cada conversación para el chat: nombre en la base, campaña, etapa y ejecutivo. */
export async function leadsDeContactos(contactoIds: string[]) {
  if (contactoIds.length === 0) return new Map<string, Record<string, unknown>>();
  const { rows } = await getPool().query(
    `SELECT c.id AS contacto_id, c.nombre, c.whatsapp_baja AS baja,
            o.id AS oportunidad_id, o.campana, o.ejecutivo, e.nombre AS etapa
       FROM crm_contactos c
       LEFT JOIN LATERAL (
         SELECT x.id, x.campana, x.ejecutivo, x.etapa_id FROM crm_oportunidades x WHERE x.contacto_id = c.id
          ORDER BY (x.estado_cartera = 'ACTIVA' AND x.estado = 'abierta') DESC, x.creado_en DESC LIMIT 1
       ) o ON true
       LEFT JOIN crm_etapas e ON e.id = o.etapa_id
      WHERE c.id = ANY($1::uuid[])`,
    [contactoIds],
  );
  return new Map(rows.map((r) => [r.contacto_id as string, r as Record<string, unknown>]));
}
