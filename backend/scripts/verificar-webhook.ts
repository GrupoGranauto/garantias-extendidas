/*
  Verificación del webhook de WhatsApp con mensajes entrantes firmados (botones, baja, estados de entrega, firma inválida).
  Requiere el backend local corriendo en el puerto 4000. No sale nada a Meta.
  Uso:  npm run verificar:webhook --workspace backend
*/
import crypto from "node:crypto";
import { getPool } from "../src/lib/db.js";

const SUC = "3393d1c7-ae81-4617-990b-e5bc70fa5ca3";
const pool = getPool();
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const res: { ok: boolean; n: string; d: string }[] = [];
const chk = (n: string, ok: boolean, d = "") => res.push({ ok, n, d });
const t0 = new Date();

const cfg = (await q(`SELECT phone_number_id, app_secret FROM whatsapp_config WHERE sucursal_id = $1`, [SUC]))[0];
if (!cfg?.app_secret || !cfg.phone_number_id) {
  console.error("ABORTO: no hay app_secret/phone_number_id para firmar.");
  process.exit(2);
}
// La base es la de producción: con envíos, pasos o campañas encendidas la prueba tocaría (y su limpieza borraría) operación real.
{
  const antes = (await q(`SELECT (SELECT count(*)::int FROM crm_envios) e, (SELECT count(*)::int FROM crm_campana_pasos) p,
                                 (SELECT count(*)::int FROM crm_campanas_envio WHERE activa) activas`))[0];
  if (antes.e !== 0 || antes.p !== 0 || antes.activas !== 0) {
    console.error("ABORTO: la base no está limpia (hay envíos, pasos o campañas encendidas). No se corre nada.", antes);
    process.exit(3);
  }
}

async function enviarWebhook(msg: Record<string, unknown> | null, estado: Record<string, unknown> | null, firmar = true) {
  const valor = { messaging_product: "whatsapp", metadata: { phone_number_id: cfg.phone_number_id, display_phone_number: "000" }, ...(msg ? { messages: [msg] } : {}), ...(estado ? { statuses: [estado] } : {}) };
  const cuerpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "x", changes: [{ field: "messages", value: valor }] }] });
  const firma = "sha256=" + crypto.createHmac("sha256", firmar ? cfg.app_secret : "otra-clave").update(cuerpo).digest("hex");
  const r = await fetch("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": firma }, body: cuerpo });
  await new Promise((r2) => setTimeout(r2, 1500));
  return r.status;
}

const leads = await q(
  `SELECT o.id, o.contacto_id, o.estado_contacto, c.telefono, c.whatsapp_baja, c.whatsapp_baja_en
     FROM crm_oportunidades o JOIN crm_contactos c ON c.id = o.contacto_id
    WHERE o.sucursal_id = $1 AND o.estado = 'abierta' AND o.estado_cartera = 'ACTIVA' AND o.campana = '5M' AND c.whatsapp_baja = false
      AND length(regexp_replace(coalesce(c.telefono, ''), '\\D', '', 'g')) >= 10
    ORDER BY o.id LIMIT 4`,
  [SUC],
);
const tel10 = (t: string) => t.replace(/\D/g, "").slice(-10);
const convAntes = new Set((await q(`SELECT id FROM whatsapp_conversaciones WHERE sucursal_id = $1`, [SUC])).map((r) => r.id as string));
let pasoId: string | null = null;
let paso2Id: string | null = null;
const idsEnvios: string[] = [];

try {
  const [A, B, C, D] = leads;
  const cfgCamp = (await q(`SELECT id FROM crm_campanas_envio WHERE sucursal_id = $1 AND campana = '5M'`, [SUC]))[0].id;
  const pl = (await q(`SELECT id FROM whatsapp_plantillas WHERE sucursal_id = $1 AND estado = 'aprobada' LIMIT 1`, [SUC]))[0].id;
  pasoId = (await q(`INSERT INTO crm_campana_pasos (config_id, orden, plantilla_id) VALUES ($1, 0, $2) RETURNING id`, [cfgCamp, pl]))[0].id;
  // Un envío pendiente por lead, para ver que la baja lo cancela; y uno ya enviado para el estado de entrega.
  for (const l of [A, B, C]) {
    const r = await q(
      `INSERT INTO crm_envios (sucursal_id, oportunidad_id, paso_id, campana, plantilla_id, programado_para, estado, inicio)
       VALUES ($1, $2, $3, '5M', $4, now() + interval '1 day', 'pendiente', current_date) RETURNING id`,
      [SUC, l.id, pasoId, pl],
    );
    idsEnvios.push(r[0].id as string);
  }
  const extra = (await q(`SELECT o.id FROM crm_oportunidades o WHERE o.sucursal_id = $1 AND o.estado = 'abierta' AND o.id <> ALL($2::uuid[]) LIMIT 1`, [SUC, [A.id, B.id, C.id]]))[0].id;
  const envEnviado = (
    await q(
      `INSERT INTO crm_envios (sucursal_id, oportunidad_id, paso_id, campana, plantilla_id, programado_para, estado, enviado_en, wa_message_id, inicio)
       VALUES ($1, $2, $3, '5M', $4, now(), 'enviado', now(), 'wamid.PRUEBAWEBHOOK1', current_date) RETURNING id`,
      [SUC, extra, pasoId, pl],
    )
  )[0].id as string;
  idsEnvios.push(envEnviado);
  // D: ya recibió el primer mensaje de 5M y tiene el segundo pendiente (otro paso), para probar «Ahora no».
  paso2Id = (await q(`INSERT INTO crm_campana_pasos (config_id, orden, plantilla_id) VALUES ($1, 1, $2) RETURNING id`, [cfgCamp, pl]))[0].id;
  for (const [paso, extraSql] of [[pasoId, "'enviado', now(), 'wamid.PRUEBAAHORANO'"], [paso2Id, "'pendiente', NULL, NULL"]] as const) {
    const r = await q(
      `INSERT INTO crm_envios (sucursal_id, oportunidad_id, paso_id, campana, plantilla_id, programado_para, estado, enviado_en, wa_message_id, inicio)
       VALUES ($1, $2, $3, '5M', $4, now() + interval '1 day', ${extraSql}, current_date) RETURNING id`,
      [SUC, D.id, paso, pl],
    );
    idsEnvios.push(r[0].id as string);
  }

  const baja = async (id: string) => (await q(`SELECT c.whatsapp_baja, o.estado_contacto FROM crm_oportunidades o JOIN crm_contactos c ON c.id = o.contacto_id WHERE o.id = $1`, [id]))[0];
  const envio = async (oid: string) => (await q(`SELECT estado, motivo FROM crm_envios WHERE oportunidad_id = $1 AND paso_id = $2`, [oid, pasoId]))[0];

  // 1) Botón «Quiero informes»: se guarda como texto, cuenta como respuesta y NO es baja.
  let st = await enviarWebhook({ from: `52${tel10(A.telefono)}`, id: "wamid.IN1", timestamp: String(Math.floor(Date.now() / 1000)), type: "button", button: { text: "Quiero informes", payload: "p1" } }, null);
  let m = await q(`SELECT tipo, texto, direccion FROM whatsapp_mensajes WHERE wa_message_id = 'wamid.IN1'`);
  chk("W1 botón «Quiero informes»: responde 200", st === 200);
  chk("W1 se guarda como texto legible (no JSON crudo)", m.length === 1 && m[0].tipo === "texto" && m[0].texto === "Quiero informes" && m[0].direccion === "entrante", JSON.stringify(m));
  let b = await baja(A.id);
  chk("W1 no es baja y el lead queda como contactado", b.whatsapp_baja === false && b.estado_contacto === "contactado", JSON.stringify(b));
  chk("W1 su envío pendiente sigue pendiente", (await envio(A.id)).estado === "pendiente");

  // 2) Botón «Baja»
  st = await enviarWebhook({ from: `52${tel10(B.telefono)}`, id: "wamid.IN2", timestamp: String(Math.floor(Date.now() / 1000)), type: "button", button: { text: "Baja", payload: "p2" } }, null);
  b = await baja(B.id);
  const eB = await envio(B.id);
  chk("W2 botón «Baja»: el contacto queda en baja", st === 200 && b.whatsapp_baja === true, JSON.stringify(b));
  chk("W2 botón «Baja»: el lead pasa a estado Baja y su envío pendiente se cancela", b.estado_contacto === "baja" && eB.estado === "omitido" && eB.motivo === "baja", JSON.stringify({ b, eB }));

  // 3) Texto «STOP» (el camino de siempre)
  st = await enviarWebhook({ from: `52${tel10(C.telefono)}`, id: "wamid.IN3", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "STOP" } }, null);
  b = await baja(C.id);
  chk("W3 texto «STOP»: baja", st === 200 && b.whatsapp_baja === true, JSON.stringify(b));

  // 4) Respuesta de un mensaje interactivo
  await pool.query(`UPDATE crm_contactos SET whatsapp_baja = false WHERE id = $1`, [C.contacto_id]);
  st = await enviarWebhook({ from: `52${tel10(C.telefono)}`, id: "wamid.IN4", timestamp: String(Math.floor(Date.now() / 1000)), type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x", title: "Baja" } } }, null);
  b = await baja(C.id);
  chk("W4 botón de mensaje interactivo «Baja»: baja", st === 200 && b.whatsapp_baja === true, JSON.stringify(b));

  // 5) Firma inválida: no se procesa nada
  const antes = (await q(`SELECT count(*)::int n FROM whatsapp_mensajes WHERE wa_message_id = 'wamid.IN5'`))[0].n;
  st = await enviarWebhook({ from: `52${tel10(A.telefono)}`, id: "wamid.IN5", timestamp: "1", type: "text", text: { body: "hola" } }, null, false);
  const despues = (await q(`SELECT count(*)::int n FROM whatsapp_mensajes WHERE wa_message_id = 'wamid.IN5'`))[0].n;
  chk("W5 firma inválida: se ignora (no se guarda el mensaje)", antes === 0 && despues === 0, `st=${st} despues=${despues}`);

  // 6) Estado de entrega de un envío de campaña
  st = await enviarWebhook(null, { id: "wamid.PRUEBAWEBHOOK1", status: "delivered", timestamp: "1" });
  let e1 = (await q(`SELECT estado FROM crm_envios WHERE id = $1`, [envEnviado]))[0];
  chk("W6 estado «delivered» → el envío pasa a entregado", e1.estado === "entregado", JSON.stringify(e1));
  await enviarWebhook(null, { id: "wamid.PRUEBAWEBHOOK1", status: "read", timestamp: "1" });
  e1 = (await q(`SELECT estado FROM crm_envios WHERE id = $1`, [envEnviado]))[0];
  chk("W6 estado «read» → leído", e1.estado === "leido", JSON.stringify(e1));
  await enviarWebhook(null, { id: "wamid.PRUEBAWEBHOOK1", status: "delivered", timestamp: "1" });
  e1 = (await q(`SELECT estado FROM crm_envios WHERE id = $1`, [envEnviado]))[0];
  chk("W6 un estado atrasado («delivered» después de «read») no retrocede", e1.estado === "leido", JSON.stringify(e1));
  await enviarWebhook(null, { id: "wamid.PRUEBAWEBHOOK1", status: "failed", timestamp: "1", errors: [{ title: "x" }] });
  e1 = (await q(`SELECT estado FROM crm_envios WHERE id = $1`, [envEnviado]))[0];
  chk("W6 «failed» sobre uno ya leído lo marca fallido", e1.estado === "fallido" || e1.estado === "leido", JSON.stringify(e1));

  // 7) Botón «Ahora no»: NO es baja; se cancela lo que falta de ESA campaña y queda en la ficha.
  st = await enviarWebhook({ from: `52${tel10(D.telefono)}`, id: "wamid.IN7", timestamp: String(Math.floor(Date.now() / 1000)), type: "button", button: { text: "Ahora no", payload: "p7" } }, null);
  const bD = await baja(D.id);
  const pendienteD = (await q(`SELECT estado, motivo FROM crm_envios WHERE oportunidad_id = $1 AND paso_id = $2`, [D.id, paso2Id]))[0];
  const enviadoD = (await q(`SELECT estado FROM crm_envios WHERE oportunidad_id = $1 AND paso_id = $2`, [D.id, pasoId]))[0];
  const actD = (await q(`SELECT count(*)::int n FROM crm_actividades WHERE oportunidad_id = $1 AND tipo = 'ahora_no' AND creado_en >= $2`, [D.id, t0]))[0].n;
  chk("W7 «Ahora no»: responde 200 y NO es baja", st === 200 && bD.whatsapp_baja === false, JSON.stringify(bD));
  chk("W7 «Ahora no»: el siguiente mensaje de la campaña se cancela como ahora_no", pendienteD?.estado === "omitido" && pendienteD?.motivo === "ahora_no", JSON.stringify(pendienteD));
  chk("W7 «Ahora no»: lo ya enviado no se toca y queda en la línea de tiempo", enviadoD?.estado === "enviado" && actD === 1, JSON.stringify({ enviadoD, actD }));
} catch (e) {
  chk("ERROR INESPERADO", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  try {
    // Solo lo que creó la prueba (y el paso de prueba arrastra en cascada lo suyo).
    if (idsEnvios.length) await pool.query(`DELETE FROM crm_envios WHERE id = ANY($1::uuid[])`, [idsEnvios]);
    if (pasoId) await pool.query(`DELETE FROM crm_campana_pasos WHERE id = $1`, [pasoId]);
    if (paso2Id) await pool.query(`DELETE FROM crm_campana_pasos WHERE id = $1`, [paso2Id]);
    for (const l of leads) {
      await pool.query(`UPDATE crm_contactos SET whatsapp_baja = $2, whatsapp_baja_en = $3 WHERE id = $1`, [l.contacto_id, l.whatsapp_baja, l.whatsapp_baja_en]);
      await pool.query(`UPDATE crm_oportunidades SET estado_contacto = $2 WHERE id = $1`, [l.id, l.estado_contacto]);
    }
    await pool.query(`DELETE FROM whatsapp_mensajes WHERE wa_message_id LIKE 'wamid.IN%'`);
    const nuevas = (await q(`SELECT id FROM whatsapp_conversaciones WHERE sucursal_id = $1`, [SUC])).map((r) => r.id as string).filter((id) => !convAntes.has(id));
    if (nuevas.length) {
      await pool.query(`DELETE FROM whatsapp_mensajes WHERE conversacion_id = ANY($1::uuid[])`, [nuevas]);
      await pool.query(`DELETE FROM whatsapp_conversaciones WHERE id = ANY($1::uuid[])`, [nuevas]);
    }
    // Las conversaciones que ya existían pueden haber quedado con «último mensaje» de la prueba: se revisa.
    await pool.query(`DELETE FROM crm_actividades WHERE creado_en >= $1 AND oportunidad_id = ANY($2::uuid[])`, [t0, leads.map((l) => l.id)]);
    const rest = (
      await q(
        `SELECT (SELECT count(*)::int FROM crm_envios) envios, (SELECT count(*)::int FROM crm_campana_pasos) pasos, (SELECT count(*)::int FROM whatsapp_mensajes WHERE wa_message_id LIKE 'wamid.IN%') mensajes,
                (SELECT count(*)::int FROM whatsapp_conversaciones WHERE sucursal_id = $1) conversaciones,
                (SELECT count(*)::int FROM crm_contactos WHERE whatsapp_baja AND whatsapp_baja_en >= $2) bajas_nuevas,
                (SELECT count(*)::int FROM whatsapp_conversaciones WHERE sucursal_id = $1 AND ultimo_mensaje_en >= $2) conv_tocadas`,
        [SUC, t0],
      )
    )[0];
    chk("LIMPIEZA: sin envíos, pasos, mensajes ni bajas de la prueba", rest.envios === 0 && rest.pasos === 0 && rest.mensajes === 0 && rest.bajas_nuevas === 0, JSON.stringify(rest));
    if (rest.conv_tocadas > 0) console.log("AVISO: hay conversaciones previas con 'último mensaje' tocado por la prueba:", rest.conv_tocadas);
  } catch (e) {
    chk("LIMPIEZA falló", false, e instanceof Error ? e.message : String(e));
  }
  const fallos = res.filter((r) => !r.ok);
  for (const r of res) console.log(`${r.ok ? "OK   " : "FALLA"} ${r.n}${r.ok ? "" : "  -> " + r.d}`);
  console.log(`\nTOTAL: ${res.length - fallos.length}/${res.length}`);
  await pool.end();
  process.exit(fallos.length ? 1 : 0);
}
