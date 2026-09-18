import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BigQuery } from "@google-cloud/bigquery";
import { env, flags } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client: BigQuery | null = null;

function resolveKeyFile(): string {
  const raw = env.GOOGLE_APPLICATION_CREDENTIALS!;
  // Acepta ruta absoluta o relativa a la raiz del proyecto (donde vive secrets/)
  const raizProyecto = path.resolve(__dirname, "../../..");
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(raizProyecto, raw);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No existe el archivo de credenciales de BigQuery: ${resolved}`);
  }
  return resolved;
}

type CredencialesGoogle = { client_email: string; private_key: string; project_id?: string };

/** El JSON de la cuenta de servicio, cuando viene en una variable. */
function credencialesEnVariable(): CredencialesGoogle | null {
  const crudo = env.GOOGLE_CREDENTIALS_JSON;
  if (!crudo) return null;

  try {
    const json = JSON.parse(crudo) as CredencialesGoogle;

    if (!json.client_email || !json.private_key) {
      throw new Error("faltan client_email o private_key");
    }

    // Al pegar el JSON en un panel, los saltos de linea suelen quedar escapados
    json.private_key = json.private_key.replace(/\\n/g, "\n");
    return json;
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    throw new Error(`GOOGLE_CREDENTIALS_JSON no es un JSON de cuenta de servicio válido: ${detalle}`);
  }
}

export function getBigQuery(): BigQuery {
  if (!flags.bigquery) {
    throw new Error(
      "BigQuery no configurado. Define BIGQUERY_PROJECT_ID y, o bien GOOGLE_CREDENTIALS_JSON, o bien GOOGLE_APPLICATION_CREDENTIALS.",
    );
  }
  if (!client) {
    const credentials = credencialesEnVariable();

    client = new BigQuery({
      projectId: env.BIGQUERY_PROJECT_ID,
      location: env.BIGQUERY_LOCATION,
      // La variable gana: es la unica opcion en servidores sin disco
      ...(credentials ? { credentials } : { keyFilename: resolveKeyFile() }),
    });
  }
  return client;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const [rows] = await getBigQuery().query({
    query: sql,
    params,
    location: env.BIGQUERY_LOCATION,
  });
  return rows as T[];
}

export async function pingBigQuery(): Promise<{ ok: boolean; detail: string }> {
  try {
    const rows = await query<{ ok: number }>("SELECT 1 AS ok");
    return { ok: rows[0]?.ok === 1, detail: "conexion establecida" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
