/*
  Verificación del motor de envíos con un Meta SIMULADO (nada sale a WhatsApp de verdad).
  Uso:  npm run verificar:motor --workspace backend
  Se niega a correr si la base ya tiene envíos, pasos, seguimientos o campañas encendidas, y deja todo como lo encontró.
*/
export {};

// 1) Primero se instala el Meta simulado: nada de lo que se mande a graph.facebook.com sale de esta máquina.
const stub = { llamadas: [] as { url: string; cuerpo: any }[], modo: "ok" as "ok" | "permanente" | "5xx" | "timeout" | "sinred", n: 0 };
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://graph.facebook.com")) {
    stub.llamadas.push({ url, cuerpo: init?.body ? JSON.parse(String(init.body)) : null });
    if (stub.modo === "ok") return new Response(JSON.stringify({ messages: [{ id: `wamid.STUB${++stub.n}` }] }), { status: 200 });
    if (stub.modo === "permanente") return new Response(JSON.stringify({ error: { message: "(#131026) Message undeliverable", code: 131026 } }), { status: 400 });
    if (stub.modo === "5xx") return new Response(JSON.stringify({ error: { message: "Internal error", code: 2 } }), { status: 500 });
    if (stub.modo === "timeout") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  }
  return fetchOriginal(input, init);
}) as typeof fetch;
{
  const r = await fetch("https://graph.facebook.com/v21.0/autoprueba", { method: "POST", body: JSON.stringify({ x: 1 }) });
  if (r.status !== 200 || stub.llamadas.length !== 1) {
    console.error("ABORTO: el Meta simulado no está interceptando. No se corre nada.");
    process.exit(2);
  }
  stub.llamadas.length = 0;
  stub.n = 0;
}

const { getPool } = await import("../src/lib/db.js");
const { planificarEnvios, despacharEnvios } = await import("../src/lib/campanasEnvio.js");
const { planificarSeguimientos, ejecutarSeguimientos } = await import("../src/lib/seguimientos.js");

const SUC = "3393d1c7-ae81-4617-990b-e5bc70fa5ca3";
const pool = getPool();
const resultados: { ok: boolean; nombre: string; detalle: string }[] = [];
const chk = (nombre: string, ok: boolean, detalle = "") => resultados.push({ ok, nombre, detalle });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

let original: any = null;
let varOriginal: any = null;
let fuenteOriginal: string | null = null;
let tieneConfigFila = false;
const idsConversacionesAntes = new Set<string>();
let pasoId: string | null = null;
const segIds: string[] = [];
let leads: { id: string; contacto_id: string; vehiculo_id: string; agencia: string | null; motivo: string | null; baja: boolean }[] = [];
const t0 = new Date();

async function limpiarEnvios() {
  await pool.query(`DELETE FROM crm_envios WHERE sucursal_id = $1`, [SUC]);
}
async function encolar(ids: string[], estado = "pendiente", motivo: string | null = null) {
  for (const id of ids) {
    await pool.query(
      `INSERT INTO crm_envios (sucursal_id, oportunidad_id, paso_id, campana, plantilla_id, programado_para, estado, motivo, inicio)
       SELECT $1, $2, $3, '5M', plantilla_id, now() - interval '1 minute', $4, $5, current_date FROM crm_campana_pasos WHERE id = $3`,
      [SUC, id, pasoId, estado, motivo],
    );
  }
}
const configurar = (modo: "simulacion" | "real", extra: Record<string, unknown> = {}) =>
  pool.query(
    `UPDATE crm_campanas_envio SET activa = true, modo = $2, dias_semana = '{1,2,3,4,5,6,7}', hora_inicio = '00:00', hora_fin = '23:59',
            max_por_dia = $3, dias_entre_mensajes = 0, piloto_agencias = $4, rampa_activa = $5, rampa_inicial = $6, rampa_incremento = $7
      WHERE sucursal_id = $1 AND campana = '5M'`,
    [SUC, modo, extra.max ?? 1000, extra.piloto ?? [], extra.rampa ?? false, extra.rampaInicial ?? 20, extra.rampaInc ?? 20],
  );
const estados = async (ids: string[]) =>
  q(`SELECT o.id AS oid, e.estado, e.motivo, e.intentos, e.error, e.wa_message_id, e.programado_para FROM crm_envios e JOIN crm_oportunidades o ON o.id = e.oportunidad_id WHERE e.oportunidad_id = ANY($1::uuid[]) AND e.seguimiento_id IS NULL ORDER BY o.id`, [ids]);
const cuenta = (filas: any[], estado: string, motivo?: string) => filas.filter((f) => f.estado === estado && (motivo === undefined || f.motivo === motivo)).length;

try {
  // ---------- Seguridad previa ----------
  const antes = (await q(`SELECT (SELECT count(*)::int FROM crm_envios) e, (SELECT count(*)::int FROM crm_campana_pasos) p, (SELECT count(*)::int FROM crm_seguimientos) s,
                                (SELECT count(*)::int FROM crm_campanas_envio WHERE activa) activas`))[0];
  if (antes.e !== 0 || antes.p !== 0 || antes.s !== 0 || antes.activas !== 0) {
    console.error("ABORTO: la base no está limpia (hay envíos, pasos, seguimientos o campañas encendidas).", antes);
    process.exit(3);
  }
  original = (await q(`SELECT * FROM crm_campanas_envio WHERE sucursal_id = $1 AND campana = '5M'`, [SUC]))[0];
  varOriginal = (await q(`SELECT v.id, v.columna_tecnica FROM whatsapp_plantilla_variables v JOIN whatsapp_plantillas p ON p.id = v.plantilla_id WHERE p.sucursal_id = $1 AND p.estado = 'aprobada' LIMIT 1`, [SUC]))[0];
  const cfgFila = await q(`SELECT campanas_fuente FROM crm_config WHERE sucursal_id = $1`, [SUC]);
  tieneConfigFila = cfgFila.length > 0;
  fuenteOriginal = (cfgFila[0]?.campanas_fuente as string | undefined) ?? "bigquery";
  for (const r of await q(`SELECT id FROM whatsapp_conversaciones WHERE sucursal_id = $1`, [SUC])) idsConversacionesAntes.add(r.id as string);

  const plantilla = (await q(`SELECT id FROM whatsapp_plantillas WHERE sucursal_id = $1 AND estado = 'aprobada' LIMIT 1`, [SUC]))[0].id as string;
  leads = (
    await q(
      `SELECT o.id, o.contacto_id, o.vehiculo_id, v.agencia, v.etapa_vehiculo_motivo AS motivo, c.whatsapp_baja AS baja
         FROM crm_oportunidades o JOIN crm_vehiculos v ON v.id = o.vehiculo_id JOIN crm_contactos c ON c.id = o.contacto_id
        WHERE o.sucursal_id = $1 AND o.campana = '5M' AND o.estado_cartera = 'ACTIVA' AND o.estado = 'abierta' AND v.agencia IS NOT NULL
          AND length(regexp_replace(coalesce(c.telefono, ''), '\\D', '', 'g')) >= 10 AND c.tiene_celular IS NOT FALSE AND c.whatsapp_baja = false AND v.tiene_ge IS NOT TRUE
        ORDER BY o.id LIMIT 4`,
      [SUC],
    )
  ).map((r) => ({ ...r, baja: false }));
  if (leads.length < 4) throw new Error("no hay 4 leads de prueba");
  const ids = leads.map((l) => l.id);
  const [A, B, C, D] = ids;

  const cfg = (await q(`SELECT id FROM crm_campanas_envio WHERE sucursal_id = $1 AND campana = '5M'`, [SUC]))[0].id;
  pasoId = (await q(`INSERT INTO crm_campana_pasos (config_id, orden, plantilla_id, dias_despues, vigencia_dias) VALUES ($1, 0, $2, 0, 5) RETURNING id`, [cfg, plantilla]))[0].id;

  // ---------- S0: el planificador crea un envío por lead de la campaña (fuente BigQuery) ----------
  await configurar("simulacion");
  const esperados = (await q(`SELECT count(*)::int n FROM crm_oportunidades WHERE sucursal_id = $1 AND campana = '5M' AND estado_cartera = 'ACTIVA' AND estado = 'abierta' AND fecha_inicio_campana IS NOT NULL`, [SUC]))[0].n;
  const planificados = await planificarEnvios();
  chk("S0 planificador (BigQuery): un envío por lead de 5M", planificados === esperados && esperados > 100, `planificados=${planificados} esperados=${esperados}`);
  const otra = (await q(`SELECT count(*)::int n FROM crm_envios WHERE campana <> '5M'`))[0].n;
  chk("S0 planificador: no toca campañas apagadas", otra === 0, `otras=${otra}`);
  chk("S0 planificador: idempotente (segunda pasada no duplica)", (await planificarEnvios()) === 0);
  await limpiarEnvios();

  // ---------- S1: variable sin dato (la plantilla de prueba ya traía una variable ligada a una columna inexistente) ----------
  await configurar("real");
  stub.modo = "ok";
  await encolar(ids);
  await despacharEnvios(20_000, 50);
  let f = await estados(ids);
  chk("S1 variable vacía: no se envía, queda omitido", cuenta(f, "omitido", "variable_vacia") === 4 && stub.llamadas.length === 0, JSON.stringify(f.map((x) => x.estado + ":" + x.motivo)));
  await limpiarEnvios();

  // Desde aquí la variable {{1}} se liga a una columna real: la agencia.
  await pool.query(`UPDATE whatsapp_plantilla_variables SET columna_tecnica = 'agencia' WHERE id = $1`, [varOriginal.id]);

  // ---------- S2: simulación ----------
  await configurar("simulacion");
  await encolar(ids);
  stub.llamadas.length = 0;
  await despacharEnvios(20_000, 50);
  f = await estados(ids);
  chk("S2 simulación: 4 simulados y NADA llega a Meta", cuenta(f, "simulado") === 4 && stub.llamadas.length === 0, JSON.stringify(f.map((x) => x.estado)));

  // ---------- S3 + S4: real con Meta simulado; después los seguimientos ----------
  await limpiarEnvios();
  await configurar("real");
  stub.modo = "ok";
  stub.llamadas.length = 0;
  await encolar(ids);
  await despacharEnvios(20_000, 50);
  f = await estados(ids);
  chk("S3 real: 4 enviados con id de WhatsApp", cuenta(f, "enviado") === 4 && f.every((x) => String(x.wa_message_id ?? "").startsWith("wamid.STUB")), JSON.stringify(f.map((x) => x.estado)));
  chk("S3 real: una sola llamada a Meta por lead", stub.llamadas.length === 4, `llamadas=${stub.llamadas.length}`);
  const cuerpo0 = stub.llamadas[0]?.cuerpo;
  chk("S3 real: plantilla y variable correctas", cuerpo0?.type === "template" && cuerpo0?.template?.components?.[0]?.parameters?.[0]?.text && !/\n/.test(cuerpo0.template.components[0].parameters[0].text), JSON.stringify(cuerpo0?.template));
  const msgs = await q(`SELECT count(*)::int n FROM whatsapp_mensajes WHERE wa_message_id LIKE 'wamid.STUB%'`);
  chk("S3 real: los mensajes quedan en el chat", msgs[0].n === 4, `mensajes=${msgs[0].n}`);
  const acts = await q(`SELECT count(*)::int n FROM crm_actividades WHERE oportunidad_id = ANY($1::uuid[]) AND tipo = 'envio_campana' AND creado_en >= $2`, [ids, t0]);
  chk("S3 real: queda el historial en cada oportunidad", acts[0].n === 4, `actividades=${acts[0].n}`);
  await despacharEnvios(5_000, 50);
  chk("S3 real: una segunda pasada no reenvía", stub.llamadas.length === 4, `llamadas=${stub.llamadas.length}`);

  // Seguimientos: una llamada (si no respondió) y otro WhatsApp (si no tiene km)
  const nuevoSeg = async (nombre: string, accion: string, condiciones: unknown, orden: number) => {
    const r = await q(
      `INSERT INTO crm_seguimientos (sucursal_id, campana, orden, nombre, activa, desde, espera_horas, accion, condiciones, titulo, vence_horas, hora, plantilla_id, vigencia_horas)
       VALUES ($1, '5M', $2, $3, true, 'primer_envio', 0, $4, $5::jsonb, $6, 0, $7, $8, 48) RETURNING id`,
      [SUC, orden, nombre, accion, JSON.stringify(condiciones), accion === "whatsapp" ? null : "Llamar a {cliente}", accion === "whatsapp" ? null : "10:00", accion === "whatsapp" ? plantilla : null],
    );
    segIds.push(r[0].id as string);
    return r[0].id as string;
  };
  const sLlamada = await nuevoSeg("T-llamada", "llamada", [{ campo: "respondio_whatsapp", operador: "igual", valor: "false" }], 90);
  const sWa = await nuevoSeg("T-wa", "whatsapp", [{ campo: "kilometraje", operador: "vacio", valor: "" }], 91);
  const plan = await planificarSeguimientos();
  chk("S4 seguimientos: se planifican 2 por lead", plan === 8, `planificados=${plan}`);
  const ej = await ejecutarSeguimientos(20_000, 50);
  const tareas = await q(`SELECT count(*)::int n FROM crm_tareas WHERE seguimiento_id = $1`, [sLlamada]);
  chk("S4 seguimientos: 4 llamadas agendadas como tarea", tareas[0].n === 4 && ej === 8, `tareas=${tareas[0].n} ejecutadas=${ej}`);
  const envSeg = await q(`SELECT count(*)::int n FROM crm_envios WHERE seguimiento_id = $1`, [sWa]);
  chk("S4 seguimientos: 4 WhatsApp de seguimiento quedan en cola", envSeg[0].n === 4, `envios=${envSeg[0].n}`);
  stub.llamadas.length = 0;
  await despacharEnvios(20_000, 50);
  const enviadosSeg = await q(`SELECT estado, count(*)::int n FROM crm_envios WHERE seguimiento_id = $1 GROUP BY 1`, [sWa]);
  chk("S4 seguimientos: el WhatsApp de seguimiento se envía por el mismo camino", enviadosSeg.length === 1 && enviadosSeg[0].estado === "enviado" && stub.llamadas.length === 4, JSON.stringify(enviadosSeg));
  chk("S4 seguimientos: idempotente", (await planificarSeguimientos()) === 0 && (await ejecutarSeguimientos(5_000, 50)) === 0);
  await pool.query(`DELETE FROM crm_tareas WHERE seguimiento_id = ANY($1::uuid[])`, [segIds]);
  await pool.query(`DELETE FROM crm_seguimientos WHERE id = ANY($1::uuid[])`, [segIds]);
  segIds.length = 0;
  await limpiarEnvios();

  // ---------- S5: rechazo definitivo de Meta ----------
  stub.modo = "permanente";
  stub.llamadas.length = 0;
  await encolar(ids);
  await despacharEnvios(20_000, 50);
  await despacharEnvios(5_000, 50);
  f = await estados(ids);
  chk("S5 rechazo definitivo: fallido sin reintentos", cuenta(f, "fallido") === 4 && stub.llamadas.length === 4 && f.every((x) => /131026/.test(String(x.error))), `llamadas=${stub.llamadas.length} ${JSON.stringify(f.map((x) => x.estado))}`);
  await limpiarEnvios();

  // ---------- S6: error pasajero (500): reintenta hasta 3 veces y luego falla ----------
  stub.modo = "5xx";
  stub.llamadas.length = 0;
  await encolar([A]);
  await despacharEnvios(5_000, 10);
  f = await estados([A]);
  chk("S6 error 500: queda pendiente para reintentar en ~15 min", f[0].estado === "pendiente" && f[0].motivo === "reintento" && f[0].intentos === 1 && new Date(f[0].programado_para).getTime() > Date.now() + 10 * 60_000, JSON.stringify(f[0]));
  for (let i = 0; i < 2; i++) {
    await pool.query(`UPDATE crm_envios SET programado_para = now() - interval '1 minute' WHERE oportunidad_id = $1`, [A]);
    await despacharEnvios(5_000, 10);
  }
  f = await estados([A]);
  chk("S6 error 500: tras 3 intentos queda fallido (3 llamadas, no más)", f[0].estado === "fallido" && f[0].intentos === 3 && stub.llamadas.length === 3, JSON.stringify(f[0]) + " llamadas=" + stub.llamadas.length);
  await limpiarEnvios();

  // ---------- S7: sin respuesta de Meta (no se sabe si salió) ----------
  stub.modo = "timeout";
  stub.llamadas.length = 0;
  await encolar([B]);
  await despacharEnvios(5_000, 10);
  await despacharEnvios(5_000, 10);
  f = await estados([B]);
  chk("S7 sin respuesta: fallido y NO se reintenta (evita duplicar)", f[0].estado === "fallido" && stub.llamadas.length === 1 && /no se reintenta/i.test(String(f[0].error)), JSON.stringify(f[0]) + " llamadas=" + stub.llamadas.length);
  await limpiarEnvios();

  // ---------- S8: no se pudo ni conectar (DNS): sí es seguro reintentar ----------
  stub.modo = "sinred";
  stub.llamadas.length = 0;
  await encolar([C]);
  await despacharEnvios(5_000, 10);
  f = await estados([C]);
  chk("S8 sin conexión: se reintenta más tarde", f[0].estado === "pendiente" && f[0].motivo === "reintento", JSON.stringify(f[0]));
  await limpiarEnvios();

  // ---------- S9: el proceso se cayó a medias de un envío ----------
  stub.modo = "ok";
  stub.llamadas.length = 0;
  await encolar([D], "pendiente", "enviando");
  await despacharEnvios(5_000, 10);
  f = await estados([D]);
  chk("S9 caída a medias: no se reenvía; queda fallido", f[0].estado === "fallido" && stub.llamadas.length === 0, JSON.stringify(f[0]) + " llamadas=" + stub.llamadas.length);
  await limpiarEnvios();

  // ---------- S10: piloto por agencia ----------
  await configurar("real", { piloto: ["__otra_agencia__"] });
  stub.llamadas.length = 0;
  await encolar(ids);
  await despacharEnvios(10_000, 20);
  f = await estados(ids);
  chk("S10 piloto: los de otras agencias esperan, no se envían", cuenta(f, "pendiente", "fuera_del_piloto") === 4 && stub.llamadas.length === 0, JSON.stringify(f.map((x) => x.estado + ":" + x.motivo)));
  await configurar("real", { piloto: [leads[0].agencia as string] });
  await pool.query(`UPDATE crm_envios SET programado_para = now() - interval '1 minute' WHERE estado = 'pendiente'`);
  stub.llamadas.length = 0;
  await despacharEnvios(10_000, 20);
  f = await estados(ids);
  const delPiloto = leads.filter((l) => l.agencia === leads[0].agencia).length;
  chk("S10 piloto: al ampliarlo salen solo los de la agencia elegida", cuenta(f, "enviado") === delPiloto && stub.llamadas.length === delPiloto, `enviados=${cuenta(f, "enviado")} esperados=${delPiloto}`);
  await limpiarEnvios();

  // ---------- S11: rampa del tope diario ----------
  await configurar("real", { rampa: true, rampaInicial: 2, rampaInc: 0 });
  stub.llamadas.length = 0;
  await encolar(ids);
  await despacharEnvios(10_000, 20);
  f = await estados(ids);
  chk("S11 rampa: sale el tope (2) y el resto espera al día siguiente", cuenta(f, "enviado") === 2 && cuenta(f, "pendiente", "tope_diario") === 2 && stub.llamadas.length === 2, JSON.stringify(f.map((x) => x.estado + ":" + x.motivo)));
  await limpiarEnvios();

  // ---------- S12: baja del cliente ----------
  await configurar("real");
  await pool.query(`UPDATE crm_contactos SET whatsapp_baja = true WHERE id = $1`, [leads[0].contacto_id]);
  stub.llamadas.length = 0;
  await encolar([A]);
  await despacharEnvios(5_000, 10);
  f = await estados([A]);
  chk("S12 baja: se omite y no se manda nada", f[0].estado === "omitido" && f[0].motivo === "baja" && stub.llamadas.length === 0, JSON.stringify(f[0]));
  await pool.query(`UPDATE crm_contactos SET whatsapp_baja = false WHERE id = $1`, [leads[0].contacto_id]);
  await limpiarEnvios();

  // ---------- S13: vehículo excluido por las etapas (fuente BigQuery) ----------
  await pool.query(`UPDATE crm_vehiculos SET etapa_vehiculo_motivo = 'excluido_km' WHERE id = $1`, [leads[1].vehiculo_id]);
  stub.llamadas.length = 0;
  await encolar([B]);
  await despacharEnvios(5_000, 10);
  f = await estados([B]);
  chk("S13 excluido por etapas: se omite y no se manda nada", f[0].estado === "omitido" && f[0].motivo === "ya_no_aplica" && stub.llamadas.length === 0, JSON.stringify(f[0]));
  await pool.query(`UPDATE crm_vehiculos SET etapa_vehiculo_motivo = $2 WHERE id = $1`, [leads[1].vehiculo_id, leads[1].motivo]);
  await limpiarEnvios();

  // ---------- S14: fuente web ----------
  await pool.query(`INSERT INTO crm_config (sucursal_id, campanas_fuente) VALUES ($1, 'web') ON CONFLICT (sucursal_id) DO UPDATE SET campanas_fuente = 'web'`, [SUC]);
  await configurar("simulacion");
  const esperadosWeb = (await q(`SELECT count(*)::int n FROM crm_campana_calculada w JOIN crm_oportunidades o ON o.id = w.oportunidad_id WHERE w.sucursal_id = $1 AND w.campana = '5M' AND w.inicio IS NOT NULL AND o.estado = 'abierta'`, [SUC]))[0].n;
  const planificadosWeb = await planificarEnvios();
  chk("S14 planificador (web): un envío por lead calculado por la web", planificadosWeb === esperadosWeb && esperadosWeb > 100, `planificados=${planificadosWeb} esperados=${esperadosWeb}`);
  const sinInicio = (await q(`SELECT count(*)::int n FROM crm_envios WHERE inicio IS NULL`))[0].n;
  chk("S14 planificador (web): todos con su fecha de inicio", sinInicio === 0, `sinInicio=${sinInicio}`);
  await limpiarEnvios();
} catch (err) {
  chk("ERROR INESPERADO en la prueba", false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  // ---------- Limpieza y restauración total ----------
  try {
    await pool.query(`DELETE FROM crm_tareas WHERE seguimiento_id IS NOT NULL`);
    await pool.query(`DELETE FROM crm_seguimientos WHERE sucursal_id = $1`, [SUC]);
    await limpiarEnvios();
    if (pasoId) await pool.query(`DELETE FROM crm_campana_pasos WHERE id = $1`, [pasoId]);
    if (original) {
      await pool.query(
        `UPDATE crm_campanas_envio SET activa = $2, modo = $3, dias_semana = $4, hora_inicio = $5, hora_fin = $6, max_por_dia = $7, dias_entre_mensajes = $8,
                piloto_agencias = $9, rampa_activa = $10, rampa_inicial = $11, rampa_incremento = $12 WHERE id = $1`,
        [original.id, original.activa, original.modo, original.dias_semana, original.hora_inicio, original.hora_fin, original.max_por_dia, original.dias_entre_mensajes, original.piloto_agencias, original.rampa_activa, original.rampa_inicial, original.rampa_incremento],
      );
    }
    if (varOriginal) await pool.query(`UPDATE whatsapp_plantilla_variables SET columna_tecnica = $2 WHERE id = $1`, [varOriginal.id, varOriginal.columna_tecnica]);
    if (tieneConfigFila) await pool.query(`UPDATE crm_config SET campanas_fuente = $2 WHERE sucursal_id = $1`, [SUC, fuenteOriginal]);
    else await pool.query(`DELETE FROM crm_config WHERE sucursal_id = $1`, [SUC]);
    for (const l of leads) {
      await pool.query(`UPDATE crm_contactos SET whatsapp_baja = $2 WHERE id = $1`, [l.contacto_id, l.baja]);
      await pool.query(`UPDATE crm_vehiculos SET etapa_vehiculo_motivo = $2 WHERE id = $1`, [l.vehiculo_id, l.motivo]);
    }
    await pool.query(`DELETE FROM whatsapp_mensajes WHERE wa_message_id LIKE 'wamid.STUB%'`);
    const conv = await q(`SELECT id FROM whatsapp_conversaciones WHERE sucursal_id = $1`, [SUC]);
    const nuevas = conv.map((c) => c.id as string).filter((id) => !idsConversacionesAntes.has(id));
    if (nuevas.length) {
      await pool.query(`DELETE FROM whatsapp_mensajes WHERE conversacion_id = ANY($1::uuid[])`, [nuevas]);
      await pool.query(`DELETE FROM whatsapp_conversaciones WHERE id = ANY($1::uuid[])`, [nuevas]);
    }
    // Las conversaciones que ya existían quedaron con «último mensaje» de la prueba: se avisa si pasó.
    await pool.query(`DELETE FROM crm_actividades WHERE tipo IN ('envio_campana', 'seguimiento') AND creado_en >= $1`, [t0]);
    const rest = (
      await q(`SELECT (SELECT count(*)::int FROM crm_envios) envios, (SELECT count(*)::int FROM crm_campana_pasos) pasos, (SELECT count(*)::int FROM crm_seguimientos) seguimientos,
                      (SELECT count(*)::int FROM crm_seguimiento_ejecuciones) ejecuciones, (SELECT count(*)::int FROM crm_tareas WHERE seguimiento_id IS NOT NULL) tareas_seg,
                      (SELECT count(*)::int FROM crm_campanas_envio WHERE activa) activas, (SELECT count(*)::int FROM whatsapp_mensajes WHERE wa_message_id LIKE 'wamid.STUB%') mensajes_stub,
                      (SELECT count(*)::int FROM crm_actividades WHERE tipo IN ('envio_campana','seguimiento') AND creado_en >= $1) actividades_prueba,
                      (SELECT count(*)::int FROM whatsapp_conversaciones WHERE sucursal_id = $2) conversaciones,
                      (SELECT campanas_fuente FROM crm_config WHERE sucursal_id = $2) fuente`, [t0, SUC])
    )[0];
    chk("LIMPIEZA: la base quedó como estaba", rest.envios === 0 && rest.pasos === 0 && rest.seguimientos === 0 && rest.ejecuciones === 0 && rest.tareas_seg === 0 && rest.activas === 0 && rest.mensajes_stub === 0 && rest.actividades_prueba === 0 && rest.conversaciones === idsConversacionesAntes.size, JSON.stringify(rest));
  } catch (e) {
    chk("LIMPIEZA falló", false, e instanceof Error ? e.message : String(e));
  }
  const fallos = resultados.filter((r) => !r.ok);
  for (const r of resultados) console.log(`${r.ok ? "OK   " : "FALLA"} ${r.nombre}${r.ok ? "" : "  -> " + r.detalle}`);
  console.log(`\nTOTAL: ${resultados.length - fallos.length}/${resultados.length} correctas. Llamadas a Meta simulado: ${stub.n} aceptadas.`);
  await pool.end();
  process.exit(fallos.length ? 1 : 0);
}
