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

export function getBigQuery(): BigQuery {
  if (!flags.bigquery) {
    throw new Error(
      "BigQuery no configurado. Define BIGQUERY_PROJECT_ID y GOOGLE_APPLICATION_CREDENTIALS en backend/.env",
    );
  }
  if (!client) {
    client = new BigQuery({
      projectId: env.BIGQUERY_PROJECT_ID,
      keyFilename: resolveKeyFile(),
      location: env.BIGQUERY_LOCATION,
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
