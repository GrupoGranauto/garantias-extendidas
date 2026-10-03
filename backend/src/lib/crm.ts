import { getPool } from "./db.js";
import type { CampoEntidad } from "./entidades.js";

/** Estado de contacto: la vista lo muestra con etiqueta, la tabla lo guarda con clave. */
export const ESTADOS_CONTACTO: Record<string, string> = {
  "Sin intentar": "sin_intentar",
  Intentando: "intentando",
  Contactado: "contactado",
  "Buzón de voz": "buzon",
  "No contactable": "no_contactable",
  Baja: "baja",
};

const COLOR_ESTADO_CONTACTO: Record<string, string> = {
  "Sin intentar": "#6b7280",
  Intentando: "#ff4d00",
  Contactado: "#614dff",
  "Buzón de voz": "#b89f00",
  "No contactable": "#dc2626",
  Baja: "#374151",
};

const COLOR_EJECUTIVO = "#475569";

const ETIQUETA_DE_ESTADO: Record<string, string> = Object.fromEntries(Object.entries(ESTADOS_CONTACTO).map(([etiqueta, clave]) => [clave, etiqueta]));
const TITULO_CAMPO: Record<string, string> = {
  comentarios: "Comentarios",
  fecha_ultimo_contacto: "Fecha último contacto",
  fecha_compra: "Fecha compra",
  ejecutivo: "Ejecutivo",
  estado_contacto: "Estado de contacto",
};

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/** El historial y las actividades referencian a public.usuarios: sin fila ahí (ej. admin de plataforma) queda sin autor. */
export async function autorValido(cliente: Consulta, usuarioId?: string): Promise<string | null> {
  if (!usuarioId) return null;
  return (await cliente.query(`SELECT id FROM usuarios WHERE id = $1`, [usuarioId])).rows[0]?.id ?? null;
}

/** Estados de contrato que prueban una venta: el certificado ya se entregó (implica pago confirmado). */
export const CONTRATO_CON_EVIDENCIA = ["certificado_entregado", "cobertura_iniciada"];

/**
 * Si la sucursal exige evidencia para marcar una venta, devuelve el motivo por el que aún no se
 * puede; null si se puede (o la sucursal no lo exige). Una venta es pago y certificado, no interés.
 */
export async function evidenciaFaltante(cliente: Consulta, sucursalId: string, oportunidadId: string): Promise<string | null> {
  const { rows: cfg } = await cliente.query(`SELECT exigir_evidencia_venta FROM crm_config WHERE sucursal_id = $1`, [sucursalId]);
  if (!cfg[0]?.exigir_evidencia_venta) return null;
  const { rows } = await cliente.query(`SELECT estado FROM crm_contratos WHERE oportunidad_id = $1`, [oportunidadId]);
  return rows[0] && CONTRATO_CON_EVIDENCIA.includes(rows[0].estado as string)
    ? null
    : "Para marcar una venta se necesita el certificado entregado. Registra el contrato en la ficha de la oportunidad.";
}

/**
 * Columnas de la vista que se editan desde la tabla, y a dónde van. Cualquier otra
 * columna 'back' que llegue aquí es un error de configuración, no se ignora.
 */
const COLUMNAS_DIRECTAS = new Set(["comentarios", "fecha_ultimo_contacto", "fecha_compra", "ejecutivo"]);

/**
 * Las listas desplegables del CRM salen de sus tablas (etapas, motivos) o de datos
 * vivos (ejecutivos): se inyectan en los campos para que lo que ve y valida el
 * portal sea siempre lo vigente, no una copia guardada en la configuración.
 */
export async function opcionesDinamicas(sucursalId: string): Promise<Record<string, { valor: string; color: string }[]>> {
  const pool = getPool();
  const [etapas, motivos, ejecutivos] = await Promise.all([
    pool.query(`SELECT nombre, color FROM crm_etapas WHERE sucursal_id = $1 AND activa ORDER BY orden`, [sucursalId]),
    pool.query(`SELECT nombre FROM crm_motivos_perdida WHERE sucursal_id = $1 AND activo ORDER BY orden`, [sucursalId]),
    pool.query(
      `SELECT DISTINCT ejecutivo FROM crm_oportunidades WHERE sucursal_id = $1 AND ejecutivo IS NOT NULL AND ejecutivo <> '' ORDER BY 1`,
      [sucursalId],
    ),
  ]);
  return {
    etapa_embudo: etapas.rows.map((r) => ({ valor: r.nombre as string, color: r.color as string })),
    motivo_perdida: motivos.rows.map((r) => ({ valor: r.nombre as string, color: "#6b7280" })),
    estado_contacto: Object.keys(ESTADOS_CONTACTO).map((valor) => ({ valor, color: COLOR_ESTADO_CONTACTO[valor] })),
    ejecutivo: ejecutivos.rows.map((r) => ({ valor: r.ejecutivo as string, color: COLOR_EJECUTIVO })),
  };
}

/** Pone las opciones vigentes en los campos que son lista del CRM. */
export function conOpcionesDinamicas(
  campos: CampoEntidad[],
  opciones: Record<string, { valor: string; color: string }[]>,
): CampoEntidad[] {
  return campos.map((c) =>
    opciones[c.nombre_tecnico] && c.origen === "back" ? { ...c, editor_tipo: "lista", opciones: opciones[c.nombre_tecnico] } : c,
  );
}

export type ResultadoEdicion = { ok: true; etapaCambio: boolean } | { ok: false; estado: 404 | 400; error: string };

/**
 * Aplica una edición a una oportunidad, en una sola transacción. Un cambio de etapa
 * mueve la tarjeta al final de su columna, actualiza el estado comercial (abierta,
 * ganada, perdida), y deja constancia en el historial. Lo demás va directo a la fila.
 */
export async function editarOportunidad(params: {
  sucursalId: string;
  oportunidadId: string;
  valores: Record<string, unknown>;
  usuarioId?: string;
}): Promise<ResultadoEdicion> {
  const { sucursalId, oportunidadId, valores, usuarioId } = params;
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");

    const { rows: filas } = await cliente.query(
      `SELECT o.id, o.etapa_id, o.estado, o.motivo_perdida_id, e.tipo AS tipo_etapa, o.comentarios,
              o.fecha_ultimo_contacto::text AS fecha_ultimo_contacto, o.fecha_compra::text AS fecha_compra,
              o.ejecutivo, o.estado_contacto
         FROM crm_oportunidades o LEFT JOIN crm_etapas e ON e.id = o.etapa_id
        WHERE o.id = $1 AND o.sucursal_id = $2 FOR UPDATE OF o`,
      [oportunidadId, sucursalId],
    );
    const actual = filas[0];
    if (!actual) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }

    const sets: string[] = [];
    const args: unknown[] = [];
    const asignar = (columna: string, valor: unknown) => {
      args.push(valor);
      sets.push(`${columna} = $${args.length}`);
    };

    for (const [col, valor] of Object.entries(valores)) {
      if (COLUMNAS_DIRECTAS.has(col)) asignar(col, valor);
    }

    // ---- Estado de contacto ----
    if ("estado_contacto" in valores) {
      const etiqueta = valores.estado_contacto as string | null;
      const clave = etiqueta ? ESTADOS_CONTACTO[etiqueta] : undefined;
      if (!clave) {
        await cliente.query("ROLLBACK");
        return { ok: false, estado: 400, error: "Estado de contacto inválido." };
      }
      asignar("estado_contacto", clave);
    }

    // ---- Etapa ----
    let etapaDestinoId: string = actual.etapa_id;
    let tipoDestino: string = actual.tipo_etapa ?? "abierta";
    let etapaCambio = false;

    if ("etapa_embudo" in valores) {
      const nombre = valores.etapa_embudo as string | null;
      const { rows: etapas } = nombre
        ? await cliente.query(
            `SELECT id, tipo FROM crm_etapas WHERE sucursal_id = $1 AND nombre = $2 AND activa`,
            [sucursalId, nombre],
          )
        : { rows: [] };
      if (!etapas[0]) {
        await cliente.query("ROLLBACK");
        return { ok: false, estado: 400, error: "La etapa no existe." };
      }
      etapaDestinoId = etapas[0].id as string;
      tipoDestino = etapas[0].tipo as string;
      etapaCambio = etapaDestinoId !== actual.etapa_id;

      if (etapaCambio && tipoDestino === "ganada") {
        const falta = await evidenciaFaltante(cliente, sucursalId, oportunidadId);
        if (falta) {
          await cliente.query("ROLLBACK");
          return { ok: false, estado: 400, error: falta };
        }
      }

      if (etapaCambio) {
        const { rows: pos } = await cliente.query(
          `SELECT coalesce(max(posicion), 0) + 1024 AS p FROM crm_oportunidades WHERE etapa_id = $1`,
          [etapaDestinoId],
        );
        asignar("etapa_id", etapaDestinoId);
        asignar("posicion", pos[0].p);
        asignar("estado", tipoDestino);
        sets.push(`entro_a_etapa_en = now()`);
        sets.push(tipoDestino === "abierta" ? `cerrada_en = NULL` : `cerrada_en = now()`);
        if (tipoDestino !== "perdida") sets.push(`motivo_perdida_id = NULL`);
      }
    }

    // ---- Motivo de pérdida ----
    let motivoId: string | null = actual.motivo_perdida_id;
    if ("motivo_perdida" in valores) {
      if (tipoDestino !== "perdida") {
        await cliente.query("ROLLBACK");
        return { ok: false, estado: 400, error: "Solo una oportunidad perdida lleva motivo de pérdida." };
      }
      const nombre = valores.motivo_perdida as string | null;
      motivoId = null;
      if (nombre) {
        const { rows } = await cliente.query(
          `SELECT id FROM crm_motivos_perdida WHERE sucursal_id = $1 AND nombre = $2 AND activo`,
          [sucursalId, nombre],
        );
        if (!rows[0]) {
          await cliente.query("ROLLBACK");
          return { ok: false, estado: 400, error: "El motivo de pérdida no existe." };
        }
        motivoId = rows[0].id as string;
      }
      asignar("motivo_perdida_id", motivoId);
    }

    if (sets.length === 0) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 400, error: "No hay nada que actualizar." };
    }

    args.push(oportunidadId, sucursalId);
    await cliente.query(
      `UPDATE crm_oportunidades SET ${sets.join(", ")} WHERE id = $${args.length - 1} AND sucursal_id = $${args.length}`,
      args,
    );

    // Auditoría: cada campo que cambió queda en la línea de tiempo con su valor anterior y el nuevo.
    const autorEdicion = await autorValido(cliente, usuarioId);
    const cambios: { campo: string; anterior: unknown; nuevo: unknown }[] = [];
    for (const campo of ["comentarios", "fecha_ultimo_contacto", "fecha_compra", "ejecutivo"] as const) {
      if (campo in valores && (valores[campo] ?? null) !== (actual[campo] ?? null)) {
        cambios.push({ campo, anterior: actual[campo] ?? null, nuevo: valores[campo] ?? null });
      }
    }
    if ("estado_contacto" in valores) {
      const anterior = ETIQUETA_DE_ESTADO[actual.estado_contacto as string] ?? null;
      if (anterior !== valores.estado_contacto) cambios.push({ campo: "estado_contacto", anterior, nuevo: valores.estado_contacto });
    }
    for (const c of cambios) {
      await cliente.query(
        `INSERT INTO crm_actividades (sucursal_id, oportunidad_id, tipo, titulo, detalle, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sucursalId, oportunidadId, c.campo === "ejecutivo" ? "reasignacion" : "edicion", TITULO_CAMPO[c.campo] ?? c.campo, c, autorEdicion],
      );
    }

    if (etapaCambio) {
      // El historial referencia a public.usuarios: quien no tenga fila ahí (ej. un admin de plataforma) queda sin autor.
      const autor = autorEdicion;
      await cliente.query(
        `INSERT INTO crm_historial_etapas
           (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, motivo_perdida_id, usuario_id, origen)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
        [sucursalId, oportunidadId, actual.etapa_id, etapaDestinoId, tipoDestino === "perdida" ? motivoId : null, autor],
      );
    }

    await cliente.query("COMMIT");
    return { ok: true, etapaCambio };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Etapas del embudo de la sucursal, en orden (para dibujar las columnas del tablero). */
export async function listarEtapas(sucursalId: string) {
  const { rows } = await getPool().query(
    `SELECT id, nombre, color, tipo, orden, tiempo_max_horas FROM crm_etapas WHERE sucursal_id = $1 AND activa ORDER BY orden`,
    [sucursalId],
  );
  return rows as { id: string; nombre: string; color: string; tipo: string; orden: number; tiempo_max_horas: number | null }[];
}

export type ResultadoMover = { ok: true } | { ok: false; estado: 404 | 400; error: string };

const SEPARACION = 1024;

/**
 * Mueve una tarjeta del tablero: a otra etapa o a otro lugar de la misma. `antesId`
 * es la tarjeta delante de la cual queda; sin ella, va al final de la columna. La
 * posición es un número entre sus vecinas, así un movimiento toca solo una fila.
 * Si cae en Perdido puede traer motivo; mover fuera de Perdido lo limpia.
 */
export async function moverOportunidad(params: {
  sucursalId: string;
  oportunidadId: string;
  etapaId: string;
  antesId?: string | null;
  motivoPerdida?: string | null;
  usuarioId?: string;
}): Promise<ResultadoMover> {
  const { sucursalId, oportunidadId, etapaId, antesId, motivoPerdida, usuarioId } = params;
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");

    const { rows: filas } = await cliente.query(
      `SELECT id, etapa_id, motivo_perdida_id FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2 FOR UPDATE`,
      [oportunidadId, sucursalId],
    );
    const actual = filas[0];
    if (!actual) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 404, error: "Registro no encontrado." };
    }

    const { rows: etapas } = await cliente.query(
      `SELECT id, tipo FROM crm_etapas WHERE id = $1 AND sucursal_id = $2 AND activa`,
      [etapaId, sucursalId],
    );
    if (!etapas[0]) {
      await cliente.query("ROLLBACK");
      return { ok: false, estado: 400, error: "La etapa no existe." };
    }
    const tipo = etapas[0].tipo as string;
    const cambioEtapa = etapaId !== actual.etapa_id;
    if (cambioEtapa && tipo === "ganada") {
      const falta = await evidenciaFaltante(cliente, sucursalId, oportunidadId);
      if (falta) {
        await cliente.query("ROLLBACK");
        return { ok: false, estado: 400, error: falta };
      }
    }

    // Posición entre las vecinas de la columna destino (sin contar la propia tarjeta).
    let posicion: number;
    if (antesId) {
      const { rows: ref } = await cliente.query(
        `SELECT posicion FROM crm_oportunidades WHERE id = $1 AND sucursal_id = $2 AND etapa_id = $3`,
        [antesId, sucursalId, etapaId],
      );
      if (!ref[0]) {
        await cliente.query("ROLLBACK");
        return { ok: false, estado: 400, error: "La tarjeta de referencia no está en esa etapa." };
      }
      const siguiente = ref[0].posicion as number;
      const { rows: prev } = await cliente.query(
        `SELECT max(posicion) AS p FROM crm_oportunidades WHERE etapa_id = $1 AND posicion < $2 AND id <> $3`,
        [etapaId, siguiente, oportunidadId],
      );
      const anterior = prev[0].p as number | null;
      posicion = anterior === null ? siguiente - SEPARACION : (anterior + siguiente) / 2;
      // Sin espacio numérico entre vecinas: se renumera la columna completa y se vuelve a calcular.
      if (anterior !== null && siguiente - anterior < 1e-6) {
        await cliente.query(
          `UPDATE crm_oportunidades o SET posicion = r.n * $2
             FROM (SELECT id, row_number() OVER (ORDER BY posicion, id) AS n FROM crm_oportunidades WHERE etapa_id = $1) r
            WHERE o.id = r.id`,
          [etapaId, SEPARACION],
        );
        const { rows: ref2 } = await cliente.query(`SELECT posicion FROM crm_oportunidades WHERE id = $1`, [antesId]);
        const { rows: prev2 } = await cliente.query(
          `SELECT max(posicion) AS p FROM crm_oportunidades WHERE etapa_id = $1 AND posicion < $2 AND id <> $3`,
          [etapaId, ref2[0].posicion, oportunidadId],
        );
        posicion = prev2[0].p === null ? ref2[0].posicion - SEPARACION : (prev2[0].p + ref2[0].posicion) / 2;
      }
    } else {
      const { rows: fin } = await cliente.query(
        `SELECT coalesce(max(posicion), 0) + $2 AS p FROM crm_oportunidades WHERE etapa_id = $1 AND id <> $3`,
        [etapaId, SEPARACION, oportunidadId],
      );
      posicion = fin[0].p as number;
    }

    let motivoId: string | null = null;
    if (tipo === "perdida") {
      if (motivoPerdida) {
        const { rows } = await cliente.query(
          `SELECT id FROM crm_motivos_perdida WHERE sucursal_id = $1 AND nombre = $2 AND activo`,
          [sucursalId, motivoPerdida],
        );
        if (!rows[0]) {
          await cliente.query("ROLLBACK");
          return { ok: false, estado: 400, error: "El motivo de pérdida no existe." };
        }
        motivoId = rows[0].id as string;
      } else if (!cambioEtapa) {
        motivoId = actual.motivo_perdida_id; // reordenar dentro de Perdido no borra su motivo
      }
    }

    if (cambioEtapa) {
      await cliente.query(
        `UPDATE crm_oportunidades
            SET etapa_id = $3, posicion = $4, estado = $5, motivo_perdida_id = $6, entro_a_etapa_en = now(),
                cerrada_en = CASE WHEN $5 = 'abierta' THEN NULL ELSE now() END
          WHERE id = $1 AND sucursal_id = $2`,
        [oportunidadId, sucursalId, etapaId, posicion, tipo, motivoId],
      );
      const autor = usuarioId
        ? (await cliente.query(`SELECT id FROM usuarios WHERE id = $1`, [usuarioId])).rows[0]?.id ?? null
        : null;
      await cliente.query(
        `INSERT INTO crm_historial_etapas
           (sucursal_id, oportunidad_id, etapa_origen_id, etapa_destino_id, motivo_perdida_id, usuario_id, origen)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
        [sucursalId, oportunidadId, actual.etapa_id, etapaId, motivoId, autor],
      );
    } else {
      await cliente.query(
        `UPDATE crm_oportunidades SET posicion = $3, motivo_perdida_id = coalesce($4, motivo_perdida_id)
          WHERE id = $1 AND sucursal_id = $2`,
        [oportunidadId, sucursalId, posicion, motivoId],
      );
    }

    await cliente.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}
