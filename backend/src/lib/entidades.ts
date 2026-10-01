import crypto from "node:crypto";
import { getPool } from "./db.js";
import { exigirIdentificador, identificadorValido } from "./identificadores.js";

export type TipoCampo = "texto" | "entero" | "decimal" | "booleano" | "fecha" | "fecha_hora" | "uuid";
export type OrigenCampo = "api" | "back";

export type OpcionCampo = { valor: string; color: string };

export type CampoEntidad = {
  nombre_tecnico: string;
  nombre_visible: string;
  tipo: TipoCampo;
  longitud: number | null;
  requerido: boolean;
  origen: OrigenCampo;
  // Solo metadato de presentación: si es false, la columna existe en la tabla
  // pero no se muestra en el portal de la sucursal. No afecta el DDL ni la
  // ingesta; por omisión las columnas son visibles.
  visible?: boolean;
  // Cómo se edita un campo 'back' de texto en la tabla: 'texto' o 'lista'.
  editor_tipo?: "texto" | "lista";
  // Opciones (etiquetas con color) cuando editor_tipo = 'lista'.
  opciones?: OpcionCampo[];
};

// Columnas de auditoría que el generador siempre agrega; un campo no puede
// llamarse igual que ellas.
const COLUMNAS_RESERVADAS = new Set([
  "id",
  "creado_en",
  "actualizado_en",
  "creado_por",
  "actualizado_por",
  "borrado_en",
  "version",
]);

/** Valida la lista de campos antes de tocar el DDL: duplicados, formato, reservados. */
export function validarCampos(campos: CampoEntidad[]): string | null {
  if (campos.length === 0) return "La entidad debe tener al menos un campo.";

  const vistos = new Set<string>();
  for (const campo of campos) {
    if (!identificadorValido(campo.nombre_tecnico)) {
      return `El nombre técnico '${campo.nombre_tecnico}' debe iniciar con letra y usar solo minúsculas, números y guiones bajos.`;
    }
    if (COLUMNAS_RESERVADAS.has(campo.nombre_tecnico)) {
      return `'${campo.nombre_tecnico}' es un nombre reservado del sistema.`;
    }
    if (vistos.has(campo.nombre_tecnico)) {
      return `El campo '${campo.nombre_tecnico}' está duplicado.`;
    }
    vistos.add(campo.nombre_tecnico);

    if (!campo.nombre_visible.trim()) {
      return "Todos los campos necesitan un nombre visible.";
    }
    if (campo.tipo === "texto" && campo.longitud != null && campo.longitud < 1) {
      return "La longitud debe ser positiva.";
    }
    if (campo.origen === "back" && campo.requerido) {
      return `El campo '${campo.nombre_visible}' es de origen Back: no puede marcarse obligatorio.`;
    }
  }
  return null;
}

/** Un esquema Postgres dedicado por sucursal: aísla sus tablas del resto de la app. */
export function nombreEsquema(subdominio: string): string {
  return `datos_${subdominio.replace(/-/g, "_")}`;
}

function tipoPostgres(campo: Pick<CampoEntidad, "tipo" | "longitud">): string {
  switch (campo.tipo) {
    case "texto":
      return campo.longitud ? `varchar(${campo.longitud})` : "text";
    case "entero":
      return "integer";
    case "decimal":
      return "numeric";
    case "booleano":
      return "boolean";
    case "fecha":
      return "date";
    case "fecha_hora":
      return "timestamptz";
    case "uuid":
      return "uuid";
  }
}

function tipoBasePostgres(tipo: TipoCampo): string {
  return tipoPostgres({ tipo, longitud: null });
}

/** Crea el esquema de la sucursal (si no existe) y la tabla real de la entidad. */
export async function crearEsquemaYTabla(
  subdominio: string,
  tabla: string,
  campos: CampoEntidad[],
): Promise<void> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");

  const columnas = campos.map((campo) => {
    const columna = exigirIdentificador(campo.nombre_tecnico, "Nombre técnico del campo");
    const tipo = tipoPostgres(campo);
    // Un campo de origen "back" se llena a mano después de crear la fila, así
    // que su columna debe ser nullable: nunca puede marcarse obligatorio
    // (el formulario ya lo impide; esto es la defensa del lado del servidor).
    const notNull = campo.requerido && campo.origen !== "back" ? " NOT NULL" : "";
    return `    "${columna}" ${tipo}${notNull}`;
  });

  const ddl = `
    CREATE SCHEMA IF NOT EXISTS "${esquema}";
    CREATE TABLE "${esquema}"."${nombreTabla}" (
      id uuid PRIMARY KEY,
${columnas.join(",\n")}${columnas.length ? "," : ""}
      creado_en timestamptz NOT NULL DEFAULT now(),
      actualizado_en timestamptz NULL,
      creado_por uuid NULL,
      actualizado_por uuid NULL,
      borrado_en timestamptz NULL,
      version integer NOT NULL DEFAULT 0
    );
  `;

  await getPool().query(ddl);
}

/**
 * Evoluciona una tabla ya existente: agrega columnas nuevas y convierte el
 * tipo de las que cambiaron (vía texto, para que un valor no convertible
 * revierta todo el cambio). Nunca borra una columna de un campo quitado.
 */
export async function evolucionarTabla(
  subdominio: string,
  tabla: string,
  camposActuales: CampoEntidad[],
  camposDeseados: CampoEntidad[],
): Promise<void> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  const actualesPorNombre = new Map(camposActuales.map((c) => [c.nombre_tecnico, c]));

  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");

    for (const campo of camposDeseados) {
      const columna = exigirIdentificador(campo.nombre_tecnico, "Nombre técnico del campo");
      const existente = actualesPorNombre.get(campo.nombre_tecnico);

      if (!existente) {
        await cliente.query(
          `ALTER TABLE "${esquema}"."${nombreTabla}" ADD COLUMN "${columna}" ${tipoPostgres(campo)};`,
        );
      } else if (existente.tipo !== campo.tipo) {
        await cliente.query(
          `ALTER TABLE "${esquema}"."${nombreTabla}" ALTER COLUMN "${columna}" TYPE ${tipoPostgres(campo)} ` +
            `USING "${columna}"::text::${tipoBasePostgres(campo.tipo)};`,
        );
      }
    }

    await cliente.query("COMMIT");
  } catch (err) {
    await cliente.query("ROLLBACK");
    throw err;
  } finally {
    cliente.release();
  }
}

export async function eliminarTabla(subdominio: string, tabla: string): Promise<void> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  await getPool().query(`DROP TABLE IF EXISTS "${esquema}"."${nombreTabla}";`);
}

/** Lee registros de la tabla de la entidad, paginado. Para el portal de la sucursal (solo lectura). */
export async function listarRegistros(
  subdominio: string,
  tabla: string,
  campos: CampoEntidad[],
  limite: number,
  desplazamiento: number,
  // Filtro opcional por una columna (ej. restringir por Ejecutivo). La columna
  // se valida como identificador; el valor va parametrizado.
  filtro?: { columna: string; valor: string },
): Promise<{ filas: Record<string, unknown>[]; total: number }> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  // Sin "creado_en": esto lo ve el portal de la sucursal, solo le corresponden
  // las columnas de su propio esquema, no las de auditoría interna.
  const columnas = ["id", ...campos.map((c) => exigirIdentificador(c.nombre_tecnico, "Nombre técnico del campo"))];

  let filtroSql = "";
  const paramsFiltro: unknown[] = [];
  if (filtro) {
    const col = exigirIdentificador(filtro.columna, "Columna de filtro");
    filtroSql = ` AND "${col}" = $3`;
    paramsFiltro.push(filtro.valor);
  }

  const pool = getPool();
  const { rows: filas } = await pool.query(
    `SELECT ${columnas.map((c) => `"${c}"`).join(", ")} FROM "${esquema}"."${nombreTabla}" ` +
      `WHERE "borrado_en" IS NULL${filtroSql} ORDER BY "creado_en" DESC LIMIT $1 OFFSET $2;`,
    [limite, desplazamiento, ...paramsFiltro],
  );
  const { rows: conteo } = await pool.query(
    `SELECT count(*)::int AS total FROM "${esquema}"."${nombreTabla}" ` +
      `WHERE "borrado_en" IS NULL${filtro ? ` AND "${exigirIdentificador(filtro.columna, "Columna de filtro")}" = $1` : ""};`,
    filtro ? [filtro.valor] : [],
  );

  return { filas, total: conteo[0]?.total ?? 0 };
}

/** Valores distintos de una columna (ej. los ejecutivos), para poblar un selector. */
export async function listarValoresDistintos(
  subdominio: string,
  tabla: string,
  columna: string,
): Promise<string[]> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  const col = exigirIdentificador(columna, "Columna");
  const { rows } = await getPool().query(
    `SELECT DISTINCT "${col}"::text AS valor FROM "${esquema}"."${nombreTabla}" ` +
      `WHERE "borrado_en" IS NULL AND "${col}" IS NOT NULL AND "${col}"::text <> '' ORDER BY 1;`,
  );
  return rows.map((r) => r.valor as string);
}

/**
 * Busca la fila de la entidad cuyo campo de teléfono coincide con el wa_id,
 * comparando solo los últimos 10 dígitos: así da igual el código de país, el
 * "1" extra que a veces manda Meta, o si el dato está guardado con guiones,
 * espacios o paréntesis.
 */
export async function buscarContactoPorTelefono(
  subdominio: string,
  tabla: string,
  columnaTelefono: string,
  columnasDeseadas: string[],
  waId: string,
): Promise<Record<string, unknown> | null> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  const colTelefono = exigirIdentificador(columnaTelefono, "Columna de teléfono");
  const columnas = [...new Set(columnasDeseadas)].map((c) => exigirIdentificador(c, "Columna"));
  if (columnas.length === 0) return null;

  const { rows } = await getPool().query(
    `SELECT ${columnas.map((c) => `"${c}"`).join(", ")} FROM "${esquema}"."${nombreTabla}" ` +
      `WHERE "borrado_en" IS NULL ` +
      `AND right(regexp_replace("${colTelefono}"::text, '\\D', '', 'g'), 10) = right(regexp_replace($1, '\\D', '', 'g'), 10) ` +
      `ORDER BY "creado_en" DESC LIMIT 1;`,
    [waId],
  );
  return rows[0] ?? null;
}

type ResultadoValores = { valores: Record<string, unknown> } | { error: string };

/** Valida el cuerpo recibido contra la definición y convierte cada valor a su tipo. */
export function construirValores(campos: CampoEntidad[], cuerpo: Record<string, unknown>): ResultadoValores {
  const camposPorNombre = new Map(campos.map((c) => [c.nombre_tecnico, c]));

  for (const clave of Object.keys(cuerpo)) {
    const campo = camposPorNombre.get(clave);
    if (!campo) return { error: `El campo '${clave}' no pertenece a la entidad.` };
    // Un campo de origen "back" se captura desde dentro del sistema: rechazar
    // en vez de ignorar avisa a la integración que está escribiendo un campo
    // que no le corresponde.
    if (campo.origen === "back") {
      return { error: `El campo '${campo.nombre_visible}' se captura desde el sistema, no por la API.` };
    }
  }

  const valores: Record<string, unknown> = {};
  for (const campo of campos) {
    if (campo.origen === "back") continue;

    const presente = Object.prototype.hasOwnProperty.call(cuerpo, campo.nombre_tecnico);
    const crudo = cuerpo[campo.nombre_tecnico];

    if (!presente || crudo === null || crudo === undefined) {
      if (campo.requerido) return { error: `El campo '${campo.nombre_visible}' es obligatorio.` };
      continue;
    }

    const coercion = coercionar(campo, crudo);
    if ("error" in coercion) return coercion;
    valores[campo.nombre_tecnico] = coercion.valor;
  }

  return { valores };
}

function coercionar(campo: CampoEntidad, valor: unknown): { valor: unknown } | { error: string } {
  const invalido = { error: `El valor de '${campo.nombre_visible}' no es válido para el tipo ${campo.tipo}.` };

  switch (campo.tipo) {
    case "texto":
      return typeof valor === "string" || typeof valor === "number" ? { valor: String(valor) } : invalido;

    case "entero": {
      const n = typeof valor === "number" ? valor : Number(valor);
      return Number.isFinite(n) ? { valor: Math.trunc(n) } : invalido;
    }

    case "decimal": {
      const n = typeof valor === "number" ? valor : Number(valor);
      return Number.isFinite(n) ? { valor: n } : invalido;
    }

    case "booleano":
      if (typeof valor === "boolean") return { valor };
      if (valor === "true") return { valor: true };
      if (valor === "false") return { valor: false };
      return invalido;

    case "fecha":
      return typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor) ? { valor } : invalido;

    case "fecha_hora": {
      const fecha = new Date(String(valor));
      return Number.isNaN(fecha.getTime()) ? invalido : { valor: fecha.toISOString() };
    }

    case "uuid": {
      const forma = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return typeof valor === "string" && forma.test(valor) ? { valor } : invalido;
    }
  }
}

async function insertarUno(
  clienteOPool: { query: (texto: string, valores?: unknown[]) => Promise<unknown> },
  esquema: string,
  nombreTabla: string,
  valores: Record<string, unknown>,
): Promise<string> {
  const id = crypto.randomUUID();
  const columnas = ["id", ...Object.keys(valores).map((c) => exigirIdentificador(c, "Columna"))];
  const marcadores = columnas.map((_, i) => `$${i + 1}`);

  await clienteOPool.query(
    `INSERT INTO "${esquema}"."${nombreTabla}" (${columnas.map((c) => `"${c}"`).join(", ")}) ` +
      `VALUES (${marcadores.join(", ")});`,
    [id, ...Object.values(valores)],
  );
  return id;
}

export async function insertarRegistro(
  subdominio: string,
  tabla: string,
  valores: Record<string, unknown>,
): Promise<string> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  return insertarUno(getPool(), esquema, nombreTabla, valores);
}

/**
 * Valida y convierte el cuerpo de una EDICIÓN de fila: solo acepta campos
 * 'back' (los que captura la app), rechaza los 'api' (vienen del sync), y si un
 * campo es lista exige que el valor esté entre sus opciones.
 */
export function construirValoresEdicion(
  campos: CampoEntidad[],
  cuerpo: Record<string, unknown>,
): { valores: Record<string, unknown> } | { error: string } {
  const porNombre = new Map(campos.map((c) => [c.nombre_tecnico, c]));
  const valores: Record<string, unknown> = {};

  for (const clave of Object.keys(cuerpo)) {
    const campo = porNombre.get(clave);
    if (!campo) return { error: `El campo '${clave}' no pertenece a la entidad.` };
    if (campo.origen !== "back") {
      return { error: `'${campo.nombre_visible}' viene de la fuente y no se puede editar aquí.` };
    }

    const crudo = cuerpo[clave];
    if (crudo === null || crudo === undefined || crudo === "") {
      valores[clave] = null;
      continue;
    }

    const coercion = coercionar(campo, crudo);
    if ("error" in coercion) return coercion;

    if (campo.tipo === "texto" && campo.editor_tipo === "lista") {
      const permitido = (campo.opciones ?? []).some((o) => o.valor === coercion.valor);
      if (!permitido) {
        return { error: `'${coercion.valor}' no está entre las opciones de '${campo.nombre_visible}'.` };
      }
    }

    valores[clave] = coercion.valor;
  }

  if (Object.keys(valores).length === 0) return { error: "No hay nada que actualizar." };
  return { valores };
}

/** Lee una sola columna de una fila (ej. el ejecutivo dueño, para permisos). */
export async function leerColumnaDeFila(
  subdominio: string,
  tabla: string,
  rowId: string,
  columna: string,
): Promise<unknown | undefined> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  const col = exigirIdentificador(columna, "Columna");
  const { rows } = await getPool().query(
    `SELECT "${col}" AS valor FROM "${esquema}"."${nombreTabla}" WHERE "id" = $1 AND "borrado_en" IS NULL;`,
    [rowId],
  );
  return rows[0]?.valor;
}

/** Actualiza columnas de una fila. Devuelve true si tocó una fila. */
export async function actualizarRegistro(
  subdominio: string,
  tabla: string,
  rowId: string,
  valores: Record<string, unknown>,
): Promise<boolean> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  const columnas = Object.keys(valores).map((c) => exigirIdentificador(c, "Columna"));
  if (columnas.length === 0) return false;

  const asignaciones = columnas.map((c, i) => `"${c}" = $${i + 2}`).join(", ");
  const { rowCount } = await getPool().query(
    `UPDATE "${esquema}"."${nombreTabla}" SET ${asignaciones}, "actualizado_en" = now() ` +
      `WHERE "id" = $1 AND "borrado_en" IS NULL;`,
    [rowId, ...Object.values(valores)],
  );
  return (rowCount ?? 0) > 0;
}

/** Inserta muchos registros en una sola transacción: todo el lote entra, o nada. */
export async function insertarRegistrosLote(
  subdominio: string,
  tabla: string,
  listaValores: Record<string, unknown>[],
): Promise<string[]> {
  const esquema = exigirIdentificador(nombreEsquema(subdominio), "Esquema");
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");

  const cliente = await getPool().connect();
  const ids: string[] = [];
  try {
    await cliente.query("BEGIN");
    for (const valores of listaValores) {
      ids.push(await insertarUno(cliente, esquema, nombreTabla, valores));
    }
    await cliente.query("COMMIT");
  } catch (err) {
    await cliente.query("ROLLBACK");
    throw err;
  } finally {
    cliente.release();
  }
  return ids;
}
