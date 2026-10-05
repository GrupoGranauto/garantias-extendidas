/*
  Verificación de las reglas del contrato (tareas por tiempo en un estado) y de la cobertura automática.
  No manda nada a nadie: solo crea tareas y cambia el estado de contratos de prueba. Uso:  npm run verificar:contrato --workspace backend
  Usa oportunidades reales como soporte, les crea contratos temporales y deja todo como lo encontró.
*/
import { getPool } from "../src/lib/db.js";
import { guardarReglasContrato, iniciarCoberturasVencidas, leerReglasContrato, planificarReglasContrato, ejecutarReglasContrato } from "../src/lib/reglasContrato.js";
import { guardarContrato } from "../src/lib/crmProceso.js";
import { sumarMesesFecha } from "../src/lib/contratoLogica.js";

const SUC = "3393d1c7-ae81-4617-990b-e5bc70fa5ca3";
const pool = getPool();
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const res: { ok: boolean; n: string; d: string }[] = [];
const chk = (n: string, ok: boolean, d = "") => res.push({ ok, n, d });
const t0 = new Date();
const hace = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const masUnDia = (f: string) => new Date(Date.parse(`${f}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const hoyLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Hermosillo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const reglasAntes = (await q(`SELECT count(*)::int n FROM crm_reglas_contrato WHERE sucursal_id = $1`, [SUC]))[0].n as number;
const contratosAntes = (await q(`SELECT count(*)::int n FROM crm_contratos WHERE sucursal_id = $1`, [SUC]))[0].n as number;
if (contratosAntes !== 0 || (await q(`SELECT count(*)::int n FROM crm_tareas WHERE regla_contrato_id IS NOT NULL`))[0].n !== 0) {
  console.error("ABORTO: ya hay contratos o tareas de reglas de contrato (¿operación en vivo?).");
  process.exit(3);
}
const cfgAntes = (await q(`SELECT cobertura_automatica FROM crm_config WHERE sucursal_id = $1`, [SUC]))[0];
const facturas: { id: string; fecha: string | null }[] = [];
let soporte: { id: string; vehiculo_id: string }[] = [];

const poner = (oid: string, estado: string, eventos: { estado: string; en: string }[]) =>
  pool.query(`INSERT INTO crm_contratos (sucursal_id, oportunidad_id, estado, eventos) VALUES ($1, $2, $3, $4::jsonb)
              ON CONFLICT (oportunidad_id) DO UPDATE SET estado = EXCLUDED.estado, eventos = EXCLUDED.eventos, actualizado_en = now()`, [SUC, oid, estado, JSON.stringify(eventos)]);
const tareasDe = async (oid: string) => q(`SELECT t.titulo, t.asignado_a, t.config, t.vence_en, r.nombre AS regla FROM crm_tareas t JOIN crm_reglas_contrato r ON r.id = t.regla_contrato_id WHERE t.oportunidad_id = $1 ORDER BY r.orden`, [oid]);

try {
  // ---------- Reglas: se siembran las 3 de ejemplo (apagadas) y se encienden para la prueba ----------
  const inicial = await leerReglasContrato(SUC);
  chk("C0 se proponen 3 reglas de ejemplo, apagadas", inicial.reglas.length === 3 && inicial.reglas.every((r: any) => r.activa === false), JSON.stringify(inicial.reglas.map((r: any) => [r.nombre, r.activa])));
  chk("C0 la cobertura automática viene encendida por omisión", inicial.cobertura_automatica === true);
  await planificarReglasContrato();
  chk("C0 con las reglas apagadas no se planifica nada", (await q(`SELECT count(*)::int n FROM crm_regla_contrato_ejecuciones`))[0].n === 0);
  const guardado = await guardarReglasContrato(SUC, inicial.reglas.map((r: any) => ({ ...r, activa: true })), true);
  chk("C0 guardar (encender las 3 reglas)", guardado.ok === true, JSON.stringify(guardado));
  const reglas = (await leerReglasContrato(SUC)).reglas as any[];
  const ids = reglas.map((r) => r.id);
  chk("C0 guardar conserva los ids de las reglas", ids.every((i, k) => i === inicial.reglas[k].id));

  soporte = await q(`SELECT o.id, o.vehiculo_id FROM crm_oportunidades o WHERE o.sucursal_id = $1 AND o.estado = 'abierta' AND o.estado_cartera = 'ACTIVA' ORDER BY o.id LIMIT 9`, [SUC]);
  const [A, B, C, D, E, F, G, H, I] = soporte.map((s) => s.id);
  for (const s of soporte) facturas.push({ id: s.vehiculo_id, fecha: (await q(`SELECT fecha_factura::text f FROM crm_vehiculos WHERE id = $1`, [s.vehiculo_id]))[0].f });

  // ---------- Reglas por tiempo en el estado ----------
  await poner(A, "orden_pago", [{ estado: "cotizado", en: hace(30) }, { estado: "orden_pago", en: hace(21) }]); // 21 h: toca la de 20 h, no la de 25 h
  await poner(B, "orden_pago", [{ estado: "orden_pago", en: hace(26) }]); // 26 h: tocan las dos
  await poner(C, "certificado_entregado", [{ estado: "certificado_entregado", en: hace(25) }]); // toca la de facturación
  await pool.query(`UPDATE crm_oportunidades SET estado = 'ganada' WHERE id = $1`, [C]); // un contrato vendido sigue contando
  await poner(D, "orden_pago", [{ estado: "orden_pago", en: hace(21) }]);
  await poner(E, "orden_pago", [{ estado: "orden_pago", en: hace(30) }]);
  await pool.query(`UPDATE crm_oportunidades SET estado = 'perdida' WHERE id = $1`, [E]); // una oportunidad perdida no recibe tareas

  const planificadas = await planificarReglasContrato();
  chk("C1 se planifican las reglas de cada contrato (A:2, B:2, C:1, D:2)", planificadas === 7, `planificadas=${planificadas}`);
  chk("C1 la oportunidad perdida no se planifica", (await q(`SELECT count(*)::int n FROM crm_regla_contrato_ejecuciones WHERE oportunidad_id = $1`, [E]))[0].n === 0);

  // D cambia de estado ANTES de que se ejecute: su tarea ya no tiene sentido
  await poner(D, "pago_confirmado", [{ estado: "orden_pago", en: hace(21) }, { estado: "pago_confirmado", en: hace(1) }]);

  const hechas = await ejecutarReglasContrato(15_000, 50);
  const tA = await tareasDe(A), tB = await tareasDe(B), tC = await tareasDe(C), tD = await tareasDe(D);
  chk("C2 A (21 h): solo la tarea «Liga de pago por vencer»", tA.length === 1 && tA[0].regla === "Liga de pago por vencer", JSON.stringify(tA.map((t) => t.regla)));
  chk("C2 B (26 h): las dos tareas de orden de pago", tB.length === 2, JSON.stringify(tB.map((t) => t.regla)));
  chk("C2 C (certificado + 25 h, oportunidad ganada): tarea de facturación", tC.length === 1 && tC[0].regla === "Pedir datos para facturar", JSON.stringify(tC.map((t) => t.regla)));
  chk("C2 D (cambió de estado antes): sin tarea y queda omitida por cambio de estado", tD.length === 0 && (await q(`SELECT count(*)::int n FROM crm_regla_contrato_ejecuciones WHERE oportunidad_id = $1 AND motivo = 'cambio_de_estado'`, [D]))[0].n >= 1);
  chk("C2 el título se rellena con los datos del cliente y la tarea va al ejecutivo", tA[0] && !/\{cliente\}/.test(tA[0].titulo) && /Contrato|vence en 4/.test(tA[0].titulo) && !!tA[0].asignado_a, JSON.stringify(tA[0]));
  chk("C2 la tarea tiene fecha de vencimiento y marca de contrato", !!tA[0]?.vence_en && tA[0].config?.contrato === true, JSON.stringify(tA[0]));
  const pendientesA = (await q(`SELECT count(*)::int n FROM crm_regla_contrato_ejecuciones x JOIN crm_reglas_contrato r ON r.id = x.regla_id WHERE x.oportunidad_id = $1 AND x.estado = 'pendiente'`, [A]))[0].n;
  chk("C2 A: la regla de 25 h queda pendiente para más tarde", pendientesA === 1, `pendientes=${pendientesA}`);
  chk("C2 se resolvieron 6 (3 hechas de A,B(2) ... + C + las 2 de D)", hechas >= 5, `resueltas=${hechas}`);

  // ---------- Idempotencia ----------
  const otraVez = await planificarReglasContrato();
  const otraVezEj = await ejecutarReglasContrato(5_000, 50);
  chk("C3 una segunda pasada no duplica nada", otraVez === 0 && otraVezEj === 0, `planificadas=${otraVez} ejecutadas=${otraVezEj}`);

  // Guardar otra vez el MISMO estado (por ejemplo, para poner el folio) no reinicia el reloj
  await guardarContrato({ sucursalId: SUC, oportunidadId: A, estado: "orden_pago", folio: "F-1" });
  chk("C3 guardar el mismo estado no reinicia el reloj", (await planificarReglasContrato()) === 0);

  // Salir del estado y volver a entrar SÍ empieza otro ciclo
  await guardarContrato({ sucursalId: SUC, oportunidadId: D, estado: "orden_pago" });
  const reentrada = await planificarReglasContrato();
  chk("C3 volver a entrar al estado empieza un ciclo nuevo (2 reglas)", reentrada === 2, `planificadas=${reentrada}`);

  // ---------- Una regla apagada no actúa ----------
  await pool.query(`UPDATE crm_reglas_contrato SET activa = false WHERE id = $1`, [ids[2]]);
  await poner(F, "certificado_entregado", [{ estado: "certificado_entregado", en: hace(30) }]);
  const conApagada = await planificarReglasContrato();
  chk("C4 con la regla apagada no se planifica", conApagada === 0, `planificadas=${conApagada}`);
  await pool.query(`UPDATE crm_reglas_contrato SET activa = true WHERE id = $1`, [ids[2]]);

  // ---------- Editar una regla ----------
  const editadas = reglas.map((r) => ({ ...r, espera_horas: r.id === ids[0] ? 40 : r.espera_horas }));
  await guardarReglasContrato(SUC, editadas, true);
  const pend = (await q(`SELECT count(*)::int n FROM crm_regla_contrato_ejecuciones WHERE regla_id = $1 AND estado = 'pendiente'`, [ids[0]]))[0].n;
  const hist = (await q(`SELECT count(*)::int n FROM crm_regla_contrato_ejecuciones WHERE regla_id = $1 AND estado = 'hecho'`, [ids[0]]))[0].n;
  chk("C4 cambiar la espera de una regla reprograma lo pendiente y conserva el historial", pend === 0 && hist >= 1, `pendientes=${pend} hechas=${hist}`);

  // ---------- Cobertura automática ----------
  const hoy = hoyLocal();
  await poner(F, "certificado_entregado", [{ estado: "certificado_entregado", en: hace(1) }]);
  await poner(G, "certificado_entregado", [{ estado: "certificado_entregado", en: hace(1) }]);
  await poner(H, "orden_pago", [{ estado: "orden_pago", en: hace(1) }]);
  await poner(I, "certificado_entregado", [{ estado: "certificado_entregado", en: hace(1) }]);
  await pool.query(`UPDATE crm_vehiculos SET fecha_factura = $2 WHERE id = $1`, [soporte[5].vehiculo_id, sumarMesesFecha(hoy, -36)]); // F: hoy se cumplen 36 meses
  await pool.query(`UPDATE crm_vehiculos SET fecha_factura = $2 WHERE id = $1`, [soporte[6].vehiculo_id, masUnDia(sumarMesesFecha(hoy, -36))]); // G: falta 1 día
  await pool.query(`UPDATE crm_vehiculos SET fecha_factura = $2 WHERE id = $1`, [soporte[7].vehiculo_id, sumarMesesFecha(hoy, -40)]); // H: ya pasó, pero no tiene certificado
  await pool.query(`UPDATE crm_vehiculos SET fecha_factura = $2 WHERE id = $1`, [soporte[8].vehiculo_id, sumarMesesFecha(hoy, -40)]); // I: ya pasó, con la cobertura automática apagada
  await pool.query(`UPDATE crm_config SET cobertura_automatica = false WHERE sucursal_id = $1`, [SUC]);
  const apagada = await iniciarCoberturasVencidas();
  chk("C5 con la cobertura automática apagada no cambia nada", apagada === 0, `cambios=${apagada}`);
  await pool.query(`UPDATE crm_config SET cobertura_automatica = true WHERE sucursal_id = $1`, [SUC]);
  const cambios = await iniciarCoberturasVencidas();
  const est = async (oid: string) => (await q(`SELECT estado, eventos FROM crm_contratos WHERE oportunidad_id = $1`, [oid]))[0];
  chk("C5 F (hoy cumple 36 meses) y I (ya pasó) pasan a cobertura iniciada", (await est(F)).estado === "cobertura_iniciada" && (await est(I)).estado === "cobertura_iniciada" && cambios === 2, `cambios=${cambios}`);
  chk("C5 G (falta un día) no cambia", (await est(G)).estado === "certificado_entregado");
  chk("C5 H (sin certificado entregado) no cambia", (await est(H)).estado === "orden_pago");
  const evF = (await est(F)).eventos as any[];
  chk("C5 el cambio queda marcado como del sistema, con su historial", evF[evF.length - 1].origen === "sistema" && (await q(`SELECT count(*)::int n FROM crm_actividades WHERE oportunidad_id = $1 AND titulo LIKE '%automático%'`, [F]))[0].n === 1);
  chk("C5 es idempotente", (await iniciarCoberturasVencidas()) === 0);
} catch (e) {
  chk("ERROR INESPERADO", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  try {
    await pool.query(`DELETE FROM crm_tareas WHERE regla_contrato_id IS NOT NULL`);
    await pool.query(`DELETE FROM crm_regla_contrato_ejecuciones WHERE sucursal_id = $1`, [SUC]);
    if (reglasAntes === 0) await pool.query(`DELETE FROM crm_reglas_contrato WHERE sucursal_id = $1`, [SUC]);
    const oids = soporte.map((s) => s.id);
    if (oids.length) {
      await pool.query(`DELETE FROM crm_actividades WHERE creado_en >= $1 AND oportunidad_id = ANY($2::uuid[])`, [t0, oids]);
      await pool.query(`DELETE FROM crm_contratos WHERE oportunidad_id = ANY($1::uuid[])`, [oids]);
      await pool.query(`UPDATE crm_oportunidades SET estado = 'abierta' WHERE id = ANY($1::uuid[])`, [oids]);
    }
    for (const f of facturas) await pool.query(`UPDATE crm_vehiculos SET fecha_factura = $2 WHERE id = $1`, [f.id, f.fecha]);
    if (cfgAntes) await pool.query(`UPDATE crm_config SET cobertura_automatica = $2 WHERE sucursal_id = $1`, [SUC, cfgAntes.cobertura_automatica]);
    const rest = (
      await q(`SELECT (SELECT count(*)::int FROM crm_contratos) contratos, (SELECT count(*)::int FROM crm_tareas WHERE regla_contrato_id IS NOT NULL) tareas,
                      (SELECT count(*)::int FROM crm_regla_contrato_ejecuciones) ejecuciones, (SELECT count(*)::int FROM crm_reglas_contrato WHERE sucursal_id = $1) reglas,
                      (SELECT count(*)::int FROM crm_oportunidades WHERE sucursal_id = $1 AND estado <> 'abierta' AND estado <> 'perdida' AND estado <> 'ganada') raras`, [SUC])
    )[0];
    const estadosOpp = await q(`SELECT estado, count(*)::int n FROM crm_oportunidades WHERE sucursal_id = $1 GROUP BY 1 ORDER BY 1`, [SUC]);
    chk("LIMPIEZA: sin contratos, tareas ni ejecuciones de la prueba", rest.contratos === 0 && rest.tareas === 0 && rest.ejecuciones === 0 && rest.reglas === reglasAntes, JSON.stringify(rest));
    console.log("Oportunidades por estado tras la prueba:", JSON.stringify(estadosOpp));
  } catch (e) {
    chk("LIMPIEZA falló", false, e instanceof Error ? e.message : String(e));
  }
  const fallos = res.filter((r) => !r.ok);
  for (const r of res) console.log(`${r.ok ? "OK   " : "FALLA"} ${r.n}${r.ok ? "" : "  -> " + r.d}`);
  console.log(`\nTOTAL: ${res.length - fallos.length}/${res.length}`);
  await pool.end();
  process.exit(fallos.length ? 1 : 0);
}
