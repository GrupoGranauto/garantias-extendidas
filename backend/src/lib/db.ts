import pg from "pg";
import { env } from "../config/env.js";

let pool: pg.Pool | null = null;

/**
 * Conexión Postgres directa (no PostgREST): necesaria para DDL dinámico
 * (CREATE SCHEMA/TABLE/ALTER COLUMN) que el cliente de Supabase no expone.
 */
export function getPool(): pg.Pool {
  if (!env.SUPABASE_DB_URL) {
    throw new Error("SUPABASE_DB_URL no está configurado.");
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env.SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}
