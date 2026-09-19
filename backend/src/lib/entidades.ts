import crypto from "node:crypto";
import { getPool } from "./db.js";
import { exigirIdentificador, identificadorValido } from "./identificadores.js";

export type TipoCampo = "texto" | "entero" | "decimal" | "booleano" | "fecha" | "fecha_hora" | "uuid";
export type OrigenCampo = "api" | "back";

export type CampoEntidad = {
  nombre_tecnico: string;
  nombre_visible: string;
  tipo: TipoCampo;
  longitud: number | null;
  requerido: boolean;
  origen: OrigenCampo;
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
