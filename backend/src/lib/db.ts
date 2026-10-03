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
      max: 10,
      // El pooler de Supabase cierra las conexiones que pasan un rato inactivas. Se reciclan antes, para no
      // entregar una ya cerrada ("Connection terminated unexpectedly") a la siguiente consulta.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      keepAlive: true,
    });
    // Sin este manejador, una conexión inactiva que el servidor cierra tumbaría todo el proceso.
    pool.on("error", (err) => console.error(`[db] una conexión inactiva se cerró: ${err.message}`));
  }
  return pool;
}
