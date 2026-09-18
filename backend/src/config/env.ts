import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Carga backend/.env sin importar desde donde se ejecute el proceso
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  /** Dominio bajo el que cuelgan los portales por sucursal */
  DOMINIO_BASE: z.string().default("autoinsights.mx"),

  // Supabase (service role: solo servidor, nunca exponer al browser)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_DB_URL: z.string().optional(),

  // BigQuery
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  BIGQUERY_PROJECT_ID: z.string().optional(),
  BIGQUERY_DATASET: z.string().optional(),
  BIGQUERY_LOCATION: z.string().default("US"),
});

// Una variable vacia en .env (PORT=) cuenta como "no definida"
const limpias = Object.fromEntries(
  Object.entries(process.env).filter(([, valor]) => valor !== undefined && valor !== ""),
);

const parsed = schema.safeParse(limpias);

if (!parsed.success) {
  console.error("Error en variables de entorno:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const flags = {
  supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
  bigquery: Boolean(env.BIGQUERY_PROJECT_ID && env.GOOGLE_APPLICATION_CREDENTIALS),
};
