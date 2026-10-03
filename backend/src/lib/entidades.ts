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

/**
 * Vista relacional del CRM (todas las sucursales juntas). Una entidad cuyo
 * nombre técnico es este no es una tabla propia de la sucursal: toda consulta
 * debe llevar su sucursal_id, y sus columnas no se modifican desde la definición.
 */
export const VISTA_CRM = "crm_v_oportunidades";

export function esEntidadCrm(tabla: string): boolean {
  return tabla === VISTA_CRM;
}

/** Relación a consultar: la tabla de la sucursal, o la vista del CRM (que exige sucursal). */
function relacionDe(subdominio: string, tabla: string, sucursalId?: string): string {
  const nombreTabla = exigirIdentificador(tabla, "Nombre técnico de la entidad");
  if (esEntidadCrm(nombreTabla)) {
    if (!sucursalId) throw new Error("La vista del CRM exige la sucursal.");
    return `"public"."${nombreTabla}"`;
  }
  return `"${exigirIdentificador(nombreEsquema(subdominio), "Esquema")}"."${nombreTabla}"`;
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

/** Fechas relativas a "hoy" en la zona horaria de la sucursal. La semana va de lunes a domingo. */
export type FechaRelativa = "hoy" | "manana" | "semana" | "mes" | "mes_anterior";

/**
 * Condición sobre una columna. Todo lo que traiga un mismo filtro se exige a la
 * vez (AND); varios filtros también se combinan con AND.
 */
export type FiltroColumna = {
  columna: string;
  /** Igual a alguno de estos valores (sin distinguir mayúsculas). */
  valores?: string[];
  /** Con `valores`: además acepta las celdas sin valor (ej. "No" también cuenta lo nunca llenado). */
  incluirVacio?: boolean;
  /** Solo las celdas sin valor. */
  vacio?: boolean;
  /** Contiene este texto (sin distinguir mayúsculas). */
  contiene?: string;
  /** Rango de fechas inclusivo. */
  desde?: string;
  hasta?: string;
  /** Fecha relativa a hoy. */
  relativo?: FechaRelativa;
};

export type OpcionesListado = {
  /** Sucursal dueña de los datos: obligatoria con la vista del CRM, que mezcla a todas. */
  sucursalId?: string;
  /** Solo las oportunidades de esta etapa del embudo (vista del CRM). */
  etapaId?: string;
  /** Orden del embudo: por posición dentro de la etapa, en vez de por una columna. */
  porPosicion?: boolean;
  /** Solo oportunidades abiertas y activas que llevan más de N horas en su etapa (fuera de SLA). */
  enEtapaMasDeHoras?: number;
  /** Restricción obligatoria por una columna (ej. el Ejecutivo de un asesor). Puede ser una columna no visible. */
  restriccion?: { columna: string; valor: string };
  filtros?: FiltroColumna[];
  /** Cada texto debe aparecer (sin distinguir mayúsculas) en alguna columna visible. */
  busquedas?: string[];
  orden?: { columna: string; dir: "asc" | "desc" };
  /** Zona horaria IANA con la que se resuelven "hoy", "esta semana"… Por omisión, Hermosillo. */
  zona?: string;
};

const ZONA_POR_OMISION = "America/Hermosillo";

/**
 * Arma el WHERE y sus parámetros. Las columnas se validan contra la lista de
 * campos visibles (o como identificador, en la restricción); los valores siempre
 * van parametrizados, nunca interpolados.
 */
function construirDonde(
  campos: CampoEntidad[],
  opciones: OpcionesListado,
): { sql: string; params: unknown[] } | { error: string } {
  const visibles = new Map(campos.map((c) => [c.nombre_tecnico, c]));
  const params: unknown[] = [];
  const condiciones: string[] = [`"borrado_en" IS NULL`];
  const marcador = (valor: unknown) => {
    params.push(valor);
    return `$${params.length}`;
  };
  // La zona se registra como parámetro una sola vez y se reutiliza.
  let marcadorZona: string | null = null;
  const zona = () => {
    if (marcadorZona === null) marcadorZona = marcador(opciones.zona ?? ZONA_POR_OMISION);
    return marcadorZona;
  };
  const hoy = () => `(now() AT TIME ZONE ${zona()})::date`;
  const comoLike = (texto: string) => `%${texto.replace(/[\\%_]/g, "\\$&")}%`;

  if (opciones.sucursalId) condiciones.push(`"sucursal_id" = ${marcador(opciones.sucursalId)}::uuid`);
  if (opciones.etapaId) condiciones.push(`"etapa_id" = ${marcador(opciones.etapaId)}::uuid`);
  if (opciones.enEtapaMasDeHoras) {
    condiciones.push(
      `"estado_oportunidad" = 'abierta' AND "estado_fuente" = 'ACTIVA' AND "entro_a_etapa_en" < now() - make_interval(hours => ${marcador(opciones.enEtapaMasDeHoras)}::int)`,
    );
  }

  if (opciones.restriccion) {
    const col = exigirIdentificador(opciones.restriccion.columna, "Columna de restricción");
    condiciones.push(`"${col}" = ${marcador(opciones.restriccion.valor)}`);
  }

  for (const filtro of opciones.filtros ?? []) {
    const campo = visibles.get(filtro.columna);
    if (!campo) return { error: `No se puede filtrar por '${filtro.columna}'.` };
    const col = exigirIdentificador(campo.nombre_tecnico, "Columna de filtro");
    const esFecha = campo.tipo === "fecha" || campo.tipo === "fecha_hora";
    const sinValor = `("${col}" IS NULL OR "${col}"::text = '')`;

    if (filtro.valores && filtro.valores.length > 0) {
      const igual = `lower("${col}"::text) = ANY(${marcador(filtro.valores.map((v) => v.toLowerCase()))}::text[])`;
      condiciones.push(filtro.incluirVacio ? `(${igual} OR ${sinValor})` : igual);
    }
    if (filtro.vacio) condiciones.push(sinValor);
    if (filtro.contiene) condiciones.push(`"${col}"::text ILIKE ${marcador(comoLike(filtro.contiene))}`);

    if (filtro.desde || filtro.hasta || filtro.relativo) {
      if (!esFecha) return { error: `'${campo.nombre_visible}' no es una fecha: no admite filtro de fecha.` };
      // La fecha de un instante (timestamptz) se mide en la zona de la sucursal, no en la del servidor.
      const dia = campo.tipo === "fecha_hora" ? `("${col}" AT TIME ZONE ${zona()})::date` : `"${col}"::date`;

      if (filtro.desde) condiciones.push(`${dia} >= ${marcador(filtro.desde)}::date`);
      if (filtro.hasta) condiciones.push(`${dia} <= ${marcador(filtro.hasta)}::date`);

      switch (filtro.relativo) {
        case "hoy":
          condiciones.push(`${dia} = ${hoy()}`);
          break;
        case "manana":
          condiciones.push(`${dia} = ${hoy()} + 1`);
          break;
        case "semana":
          condiciones.push(`${dia} >= date_trunc('week', ${hoy()})::date AND ${dia} < date_trunc('week', ${hoy()})::date + 7`);
          break;
        case "mes":
          condiciones.push(
            `${dia} >= date_trunc('month', ${hoy()})::date AND ${dia} < (date_trunc('month', ${hoy()}) + interval '1 month')::date`,
          );
          break;
        case "mes_anterior":
          condiciones.push(
            `${dia} >= (date_trunc('month', ${hoy()}) - interval '1 month')::date AND ${dia} < date_trunc('month', ${hoy()})::date`,
          );
          break;
      }
    }
  }

  for (const busqueda of opciones.busquedas ?? []) {
    const texto = busqueda.trim();
    if (!texto) continue;
    const ph = marcador(comoLike(texto));
    const columnasBusqueda = campos
      .filter((c) => c.tipo !== "booleano")
      .map((c) => `"${exigirIdentificador(c.nombre_tecnico, "Nombre técnico del campo")}"::text ILIKE ${ph}`);
    if (columnasBusqueda.length > 0) condiciones.push(`(${columnasBusqueda.join(" OR ")})`);
  }

  return { sql: condiciones.join(" AND "), params };
}

/** Cuántas filas cumplen los filtros actuales más, opcionalmente, una condición extra (para los KPIs). */
export async function contarRegistros(
  subdominio: string,
  tabla: string,
  campos: CampoEntidad[],
  opciones: OpcionesListado,
  extra?: FiltroColumna,
): Promise<{ total: number } | { error: string }> {
  const relacion = relacionDe(subdominio, tabla, opciones.sucursalId);
  const donde = construirDonde(campos, extra ? { ...opciones, filtros: [...(opciones.filtros ?? []), extra] } : opciones);
  if ("error" in donde) return donde;

  const { rows } = await getPool().query(
    `SELECT count(*)::int AS total FROM ${relacion} WHERE ${donde.sql};`,
    donde.params,
  );
  return { total: rows[0]?.total ?? 0 };
}

/**
 * Valores distintos de una columna dentro de lo que dejan pasar los filtros que
 * se le manden: así cada desplegable solo ofrece lo que todavía es alcanzable.
 * Elegir una Agencia reduce los Capturistas disponibles. Quien llama omite el
 * filtro del propio desplegable (si no, elegir un valor dejaría solo ese valor).
 */
export async function valoresDistintosFiltrados(
  subdominio: string,
  tabla: string,
  campos: CampoEntidad[],
  columna: string,
  opciones: OpcionesListado,
  limite = 200,
): Promise<string[] | { error: string }> {
  const relacion = relacionDe(subdominio, tabla, opciones.sucursalId);
  const campo = campos.find((c) => c.nombre_tecnico === columna);
  if (!campo) return { error: `No se puede enumerar '${columna}'.` };
  const col = exigirIdentificador(campo.nombre_tecnico, "Columna");

  const donde = construirDonde(campos, opciones);
  if ("error" in donde) return donde;

  const { rows } = await getPool().query(
    `SELECT DISTINCT "${col}"::text AS valor FROM ${relacion} ` +
      `WHERE ${donde.sql} AND "${col}" IS NOT NULL AND "${col}"::text <> '' ORDER BY 1 LIMIT ${Math.max(1, Math.floor(limite))};`,
    donde.params,
  );
  return rows.map((r) => r.valor as string);
}

export async function listarRegistros(
  subdominio: string,
  tabla: string,
  campos: CampoEntidad[],
  limite: number,
  desplazamiento: number,
  opciones: OpcionesListado = {},
): Promise<{ filas: Record<string, unknown>[]; total: number } | { error: string }> {
  const relacion = relacionDe(subdominio, tabla, opciones.sucursalId);
  // Sin "creado_en": esto lo ve el portal de la sucursal, solo le corresponden
  // las columnas de su propio esquema, no las de auditoría interna.
  const columnas = ["id", ...campos.map((c) => exigirIdentificador(c.nombre_tecnico, "Nombre técnico del campo"))];

  const donde = construirDonde(campos, opciones);
  if ("error" in donde) return donde;

  // Orden: solo por una columna visible. Desempate estable (creado_en, id) para
  // que la paginación no repita ni se salte filas cuando hay valores iguales.
  let orden = `"creado_en" DESC, "id"`;
  if (opciones.porPosicion) {
    orden = `"posicion" ASC, "id"`;
  } else if (opciones.orden) {
    const campo = campos.find((c) => c.nombre_tecnico === opciones.orden!.columna);
    if (!campo) return { error: `No se puede ordenar por '${opciones.orden.columna}'.` };
    const col = exigirIdentificador(campo.nombre_tecnico, "Columna de orden");
    const dir = opciones.orden.dir === "desc" ? "DESC" : "ASC";
    orden = `"${col}" ${dir} NULLS LAST, "creado_en" DESC, "id"`;
  }

  const pool = getPool();
  const n = donde.params.length;
  const { rows: filas } = await pool.query(
    `SELECT ${columnas.map((c) => `"${c}"`).join(", ")} FROM ${relacion} ` +
      `WHERE ${donde.sql} ORDER BY ${orden} LIMIT $${n + 1} OFFSET $${n + 2};`,
    [...donde.params, limite, desplazamiento],
  );
  const { rows: conteo } = await pool.query(
    `SELECT count(*)::int AS total FROM ${relacion} WHERE ${donde.sql};`,
    donde.params,
  );

  return { filas, total: conteo[0]?.total ?? 0 };
}

/** Valores distintos de una columna (ej. los ejecutivos), para poblar un selector. */
export async function listarValoresDistintos(
  subdominio: string,
  tabla: string,
  columna: string,
  // Restricción opcional (ej. el Ejecutivo de un asesor): solo valores de filas visibles para él.
  restriccion?: { columna: string; valor: string },
  limite = 200,
  sucursalId?: string,
): Promise<string[]> {
  const relacion = relacionDe(subdominio, tabla, sucursalId);
  const col = exigirIdentificador(columna, "Columna");
  const params: unknown[] = [];
  let restriccionSql = "";
  if (sucursalId && esEntidadCrm(tabla)) {
    params.push(sucursalId);
    restriccionSql += ` AND "sucursal_id" = $${params.length}::uuid`;
  }
  if (restriccion) {
    const colR = exigirIdentificador(restriccion.columna, "Columna de restricción");
    params.push(restriccion.valor);
    restriccionSql += ` AND "${colR}" = $${params.length}`;
  }
  const { rows } = await getPool().query(
    `SELECT DISTINCT "${col}"::text AS valor FROM ${relacion} ` +
      `WHERE "borrado_en" IS NULL AND "${col}" IS NOT NULL AND "${col}"::text <> ''${restriccionSql} ` +
      `ORDER BY 1 LIMIT ${Math.max(1, Math.floor(limite))};`,
    params,
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
  sucursalId?: string,
): Promise<Record<string, unknown> | null> {
  const relacion = relacionDe(subdominio, tabla, sucursalId);
  const colTelefono = exigirIdentificador(columnaTelefono, "Columna de teléfono");
  const columnas = [...new Set(columnasDeseadas)].map((c) => exigirIdentificador(c, "Columna"));
  if (columnas.length === 0) return null;

  const porSucursal = sucursalId && esEntidadCrm(tabla) ? ` AND "sucursal_id" = $2::uuid` : "";
  const { rows } = await getPool().query(
    `SELECT ${columnas.map((c) => `"${c}"`).join(", ")} FROM ${relacion} ` +
      `WHERE "borrado_en" IS NULL${porSucursal} ` +
      `AND right(regexp_replace("${colTelefono}"::text, '\\D', '', 'g'), 10) = right(regexp_replace($1, '\\D', '', 'g'), 10) ` +
      `ORDER BY "creado_en" DESC LIMIT 1;`,
    porSucursal ? [waId, sucursalId] : [waId],
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

const FECHA_MINIMA = "2000-01-01";

/**
 * Rechaza fechas incoherentes al capturar: formato inválido, una fecha que no
 * existe (ej. 2026-02-31), anteriores a 2000, o en el futuro. Devuelve el texto
 * del error o null si la fecha es válida.
 */
export function validarFechaCoherente(valor: string, nombreVisible: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return `La fecha de '${nombreVisible}' no es válida.`;
  const fecha = new Date(`${valor}T00:00:00Z`);
  // new Date normaliza (2026-02-31 -> marzo); si no "regresa" al mismo texto, no existía.
  if (Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== valor) {
    return `La fecha de '${nombreVisible}' no existe.`;
  }
  if (valor < FECHA_MINIMA) return `La fecha de '${nombreVisible}' es demasiado antigua (antes de ${FECHA_MINIMA}).`;
  const hoy = new Date().toISOString().slice(0, 10);
  if (valor > hoy) return `La fecha de '${nombreVisible}' no puede ser futura.`;
  return null;
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

    if (campo.tipo === "fecha") {
      const error = validarFechaCoherente(String(coercion.valor), campo.nombre_visible);
      if (error) return { error };
    }

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
  sucursalId?: string,
): Promise<unknown | undefined> {
  const relacion = relacionDe(subdominio, tabla, sucursalId);
  const col = exigirIdentificador(columna, "Columna");
  const porSucursal = sucursalId && esEntidadCrm(tabla) ? ` AND "sucursal_id" = $2::uuid` : "";
  const { rows } = await getPool().query(
    `SELECT "${col}" AS valor FROM ${relacion} WHERE "id" = $1 AND "borrado_en" IS NULL${porSucursal};`,
    porSucursal ? [rowId, sucursalId] : [rowId],
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
