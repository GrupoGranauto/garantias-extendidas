import { env } from "../config/env.js";

export const MAX_CONTACTOS_CLOUDTALK_POR_LOTE = 10;

export type ContactoCRMCloudTalk = {
  id: string;
  nombre: string | null;
  telefono: string | null;
  correo: string | null;
};

export type ContactoCloudTalk = {
  name: string;
  ContactNumber?: { public_number: string }[];
  ContactEmail?: { email: string }[];
};

export type CredencialesCloudTalk = {
  accessKeyId: string;
  accessKeySecret: string;
};

export type ResultadoCloudTalk =
  | { contacto_id: string; estado: "creado"; cloudtalk_id: string | number }
  | { contacto_id: string; estado: "error"; error: string; codigo?: number };

export function mapearContactoCloudTalk(contacto: ContactoCRMCloudTalk): ContactoCloudTalk {
  const nombre = contacto.nombre?.trim();
  if (!nombre) throw new Error("El contacto no tiene nombre y CloudTalk lo requiere.");

  const telefono = contacto.telefono?.trim();
  const correo = contacto.correo?.trim();
  return {
    name: nombre,
    ...(telefono ? { ContactNumber: [{ public_number: telefono }] } : {}),
    ...(correo ? { ContactEmail: [{ email: correo }] } : {}),
  };
}

export function dividirEnBloques<T>(items: T[], tamano: number): T[][] {
  if (!Number.isInteger(tamano) || tamano < 1) throw new Error("El tamaño del bloque debe ser un entero positivo.");
  const bloques: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) bloques.push(items.slice(i, i + tamano));
  return bloques;
}

type AccionBulk = { command_id: string; contacto: ContactoCRMCloudTalk; payload: ContactoCloudTalk };

function mensajeErrorCloudTalk(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const responseData = (body as { responseData?: unknown }).responseData;
    if (typeof responseData === "object" && responseData !== null) {
      const mensaje = (responseData as { message?: unknown }).message;
      if (typeof mensaje === "string" && mensaje.trim()) return mensaje;
    }
  }
  return `CloudTalk respondió con HTTP ${status}.`;
}

function parsearAccionesBulk(body: unknown): Map<string, { id?: string | number; error?: string; codigo?: number }> {
  const respuesta = new Map<string, { id?: string | number; error?: string; codigo?: number }>();
  if (typeof body !== "object" || body === null) return respuesta;
  const responseData = (body as { responseData?: unknown }).responseData;
  if (typeof responseData !== "object" || responseData === null) return respuesta;
  const acciones = (responseData as { data?: unknown }).data;
  if (!Array.isArray(acciones)) return respuesta;

  for (const accion of acciones) {
    if (typeof accion !== "object" || accion === null) continue;
    const valor = accion as {
      command_id?: unknown;
      status?: unknown;
      message?: unknown;
      data?: { id?: unknown };
    };
    if (typeof valor.command_id !== "string") continue;

    const codigo = typeof valor.status === "number" ? valor.status : undefined;
    const id = valor.data?.id;
    const idValido = typeof id === "string" || typeof id === "number";
    // Con status numérico mandamos ese; sin status, un id devuelto cuenta como éxito.
    const exito = codigo !== undefined ? codigo >= 200 && codigo < 300 : idValido;
    if (exito) {
      respuesta.set(valor.command_id, idValido ? { id } : {});
    } else {
      respuesta.set(valor.command_id, {
        error: typeof valor.message === "string" ? valor.message : "CloudTalk rechazó la creación del contacto.",
        ...(codigo !== undefined ? { codigo } : {}),
      });
    }
  }
  return respuesta;
}

async function enviarBloque(
  credenciales: CredencialesCloudTalk,
  bloque: AccionBulk[],
): Promise<ResultadoCloudTalk[]> {
  const acciones = bloque.map(({ command_id, payload }) => ({
    action: "add_contact",
    command_id,
    data: payload,
  }));

  let response: Response;
  try {
    response = await fetch(env.CLOUDTALK_BULK_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credenciales.accessKeyId}:${credenciales.accessKeySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(acciones),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detalle = error instanceof Error ? error.message : "Error de conexión con CloudTalk.";
    return bloque.map(({ contacto }) => ({ contacto_id: contacto.id, estado: "error", error: detalle }));
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = mensajeErrorCloudTalk(body, response.status);
    return bloque.map(({ contacto }) => ({
      contacto_id: contacto.id,
      estado: "error",
      error,
      codigo: response.status,
    }));
  }

  const resultados = parsearAccionesBulk(body);
  return bloque.map(({ command_id, contacto }) => {
    const resultado = resultados.get(command_id);
    if (resultado?.id !== undefined) {
      return { contacto_id: contacto.id, estado: "creado", cloudtalk_id: resultado.id };
    }
    return {
      contacto_id: contacto.id,
      estado: "error",
      error: resultado?.error ?? "CloudTalk no devolvió resultado para este contacto.",
      ...(resultado?.codigo !== undefined ? { codigo: resultado.codigo } : {}),
    };
  });
}

export async function crearContactosCloudTalk(
  credenciales: CredencialesCloudTalk,
  contactos: ContactoCRMCloudTalk[],
  generarId: () => string = () => crypto.randomUUID(),
): Promise<ResultadoCloudTalk[]> {
  const resultados: ResultadoCloudTalk[] = [];
  for (const contactosLote of dividirEnBloques(contactos, MAX_CONTACTOS_CLOUDTALK_POR_LOTE)) {
    const bloque: AccionBulk[] = [];
    const invalidos: ResultadoCloudTalk[] = [];
    for (const contacto of contactosLote) {
      try {
        bloque.push({
          command_id: generarId(),
          contacto,
          payload: mapearContactoCloudTalk(contacto),
        });
      } catch (error) {
        invalidos.push({
          contacto_id: contacto.id,
          estado: "error",
          error: error instanceof Error ? error.message : "Contacto inválido.",
        });
      }
    }
    resultados.push(...invalidos);
    if (bloque.length) resultados.push(...(await enviarBloque(credenciales, bloque)));
  }
  const porId = new Map(resultados.map((resultado) => [resultado.contacto_id, resultado]));
  return contactos.map((contacto) => porId.get(contacto.id) ?? {
    contacto_id: contacto.id,
    estado: "error",
    error: "No se obtuvo un resultado para el contacto.",
  });
}
