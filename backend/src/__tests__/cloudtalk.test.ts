import { afterEach, describe, expect, it, vi } from "vitest";
import {
  crearContactosCloudTalk,
  dividirEnBloques,
  mapearContactoCloudTalk,
  type ContactoCRMCloudTalk,
} from "../lib/cloudtalk.js";

const contacto = (id: string, nombre = "Cliente"): ContactoCRMCloudTalk => ({
  id,
  nombre,
  telefono: "+52 662 123 4567",
  correo: "cliente@example.com",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapeo y bloques CloudTalk", () => {
  it("mapea solo nombre, teléfono y correo disponibles", () => {
    expect(mapearContactoCloudTalk(contacto("a"))).toEqual({
      name: "Cliente",
      ContactNumber: [{ public_number: "+52 662 123 4567" }],
      ContactEmail: [{ email: "cliente@example.com" }],
    });
    expect(() => mapearContactoCloudTalk({ id: "b", nombre: "  ", telefono: null, correo: null })).toThrow(
      "El contacto no tiene nombre y CloudTalk lo requiere.",
    );
  });

  it("divide lotes sin perder ni reordenar elementos", () => {
    expect(dividirEnBloques([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => dividirEnBloques([1], 0)).toThrow("tamaño del bloque");
  });

  it("usa la operación bulk en grupos máximos de 10 y asocia cada respuesta", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const acciones = JSON.parse(String(init?.body)) as { command_id: string; data: { name: string } }[];
      return new Response(JSON.stringify({
        responseData: {
          data: acciones.map((accion, index) => ({
            command_id: accion.command_id,
            status: 201,
            data: { id: `${accion.data.name}-${index}` },
          })),
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const contactos = Array.from({ length: 21 }, (_, index) => contacto(String(index), `Cliente ${index}`));
    let nextId = 0;

    const resultados = await crearContactosCloudTalk(
      { accessKeyId: "key", accessKeySecret: "secret" },
      contactos,
      () => `command-${nextId++}`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const cantidades = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as unknown[]).length);
    expect(cantidades).toEqual([10, 10, 1]);
    expect(resultados).toHaveLength(21);
    expect(resultados.every((resultado) => resultado.estado === "creado")).toBe(true);
    expect(resultados[20]).toMatchObject({ contacto_id: "20", estado: "creado", cloudtalk_id: "Cliente 20-0" });
  });

  it("reporta rechazos individuales y continúa con el resto del bloque", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const acciones = JSON.parse(String(init?.body)) as { command_id: string }[];
      return new Response(JSON.stringify({
        responseData: {
          data: [
            { command_id: acciones[0].command_id, status: 201, data: { id: 123 } },
            { command_id: acciones[1].command_id, status: 406, message: "Invalid phone." },
          ],
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const resultados = await crearContactosCloudTalk(
      { accessKeyId: "key", accessKeySecret: "secret" },
      [contacto("a"), contacto("b")],
      (index => () => `command-${index++}`)(0),
    );

    expect(resultados).toEqual([
      { contacto_id: "a", estado: "creado", cloudtalk_id: 123 },
      { contacto_id: "b", estado: "error", error: "Invalid phone.", codigo: 406 },
    ]);
  });

  it("acepta una acción sin status cuando CloudTalk devuelve un id", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const acciones = JSON.parse(String(init?.body)) as { command_id: string }[];
      return new Response(JSON.stringify({
        responseData: { data: [{ command_id: acciones[0].command_id, data: { id: 99 } }] },
      }), { status: 200 });
    }));
    const resultados = await crearContactosCloudTalk(
      { accessKeyId: "key", accessKeySecret: "secret" },
      [contacto("a")],
    );
    expect(resultados).toEqual([{ contacto_id: "a", estado: "creado", cloudtalk_id: 99 }]);
  });

  it("convierte un fallo HTTP del bloque en errores explícitos por contacto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ responseData: { message: "Unauthorized" } }),
      { status: 401 },
    )));
    const resultados = await crearContactosCloudTalk(
      { accessKeyId: "key", accessKeySecret: "secret" },
      [contacto("a")],
    );
    expect(resultados).toEqual([
      { contacto_id: "a", estado: "error", error: "Unauthorized", codigo: 401 },
    ]);
  });
});
