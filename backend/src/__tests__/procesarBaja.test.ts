import { beforeEach, describe, expect, it, vi } from "vitest";
import { procesarBaja } from "../lib/campanasEnvio.js";

/*
  procesarBaja contra un cliente de mentira que registra las sentencias en orden. Sin base no se puede probar el efecto,
  pero sí qué contactos llegan como «pasan a baja hoy» y que la fecha de una baja que ya existía no se reescribe.
*/

const bd = vi.hoisted(() => ({
  /** Contactos del número que NO estaban en baja antes de registrar la supresión. */
  sinBaja: [] as string[],
  /** Todos los contactos del número. */
  delNumero: [] as string[],
  sentencias: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("../lib/db.js", () => ({
  getPool: () => ({
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        bd.sentencias.push({ sql, params });
        if (sql.includes("SELECT id FROM crm_contactos")) return { rows: bd.sinBaja.map((id) => ({ id })) };
        if (sql.includes("UPDATE crm_contactos SET whatsapp_baja = true")) return { rows: bd.delNumero.map((id) => ({ id })) };
        return { rows: [] };
      },
      release: () => {},
    }),
  }),
}));

const SUC = "00000000-0000-0000-0000-000000000001";
const TEL = "6621234567";

describe("procesarBaja", () => {
  beforeEach(() => {
    bd.sinBaja = [];
    bd.delNumero = [];
    bd.sentencias = [];
  });

  const indice = (trozo: string) => bd.sentencias.findIndex((s) => s.sql.includes(trozo));
  const sentencia = (trozo: string) => bd.sentencias.find((s) => s.sql.includes(trozo));

  it("lee quién no estaba en baja antes de registrar la supresión, y solo a esos les pone la fecha de hoy", async () => {
    bd.sinBaja = ["k-nuevo"];
    bd.delNumero = ["k-nuevo", "k-ya-en-baja"];
    expect(await procesarBaja(SUC, TEL, "wamid.1")).toBe(2);

    const previos = indice("SELECT id FROM crm_contactos");
    expect(previos).toBeGreaterThan(-1);
    expect(sentencia("SELECT id FROM crm_contactos")!.sql).toContain("AND NOT whatsapp_baja");
    expect(previos).toBeLessThan(indice("crm_registrar_supresion"));

    const marca = sentencia("UPDATE crm_contactos SET whatsapp_baja = true")!;
    expect(indice("UPDATE crm_contactos SET whatsapp_baja = true")).toBeGreaterThan(indice("crm_registrar_supresion"));
    // Quien ya estaba en baja conserva su fecha; quien pasa a baja hoy toma la de hoy.
    expect(marca.sql).toContain("whatsapp_baja_en = CASE WHEN id = ANY($3::uuid[]) THEN now() ELSE coalesce(whatsapp_baja_en, now()) END");
    expect(marca.params).toEqual([SUC, TEL, ["k-nuevo"]]);
    expect(indice("COMMIT")).toBeGreaterThan(indice("UPDATE crm_contactos SET whatsapp_baja = true"));
  });

  it("si todos ya estaban en baja, ninguno cambia de fecha", async () => {
    bd.delNumero = ["k-ya-en-baja"];
    await procesarBaja(SUC, TEL);
    expect(sentencia("UPDATE crm_contactos SET whatsapp_baja = true")!.params[2]).toEqual([]);
  });

  it("la supresión se registra aunque el número no tenga contacto, con el mensaje como evidencia", async () => {
    expect(await procesarBaja(SUC, TEL, "wamid.2")).toBe(0);
    expect(sentencia("crm_registrar_supresion")!.params).toEqual([SUC, TEL, { wa_message_id: "wamid.2" }]);
    expect(indice("UPDATE crm_oportunidades")).toBe(-1);
    expect(indice("COMMIT")).toBeGreaterThan(0);
  });
});
