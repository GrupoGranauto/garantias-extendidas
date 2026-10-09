import crypto from "node:crypto";
import { env } from "../config/env.js";

const PREFIJO = "ge_live_";

export type MaterialApiKey = { texto: string; hash: string; cifrado: string };

/** SHA-256 (hex) de la key presentada; contra esto se compara al autenticar. */
export function hashDeApiKey(textoPlano: string): string {
  return crypto.createHash("sha256").update(textoPlano, "utf8").digest("hex");
}

// Clave simétrica derivada de un secreto que ya es exclusivo del servidor:
// evita pedir una variable de entorno nueva solo para esto.
function claveCifrado(): Buffer {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY no está configurado; no se pueden cifrar ni descifrar secretos.");
  }
  return crypto.createHash("sha256").update(env.SUPABASE_SERVICE_ROLE_KEY).digest();
}

/** Cifra la key en texto plano (AES-256-GCM) para poder mostrarla de nuevo después. */
export function cifrarSecreto(textoPlano: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", claveCifrado(), iv);
  const cifrado = Buffer.concat([cipher.update(textoPlano, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, cifrado]).toString("base64");
}

export function descifrarSecreto(valor: string): string {
  const clave = claveCifrado();
  const datos = Buffer.from(valor, "base64");
  if (datos.length < 29) throw new Error("El secreto cifrado no es válido.");
  const iv = datos.subarray(0, 12);
  const tag = datos.subarray(12, 28);
  const cifrado = datos.subarray(28);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", clave, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("No se pudo descifrar el secreto; verifica la configuración de cifrado.");
  }
}

export const cifrarApiKey = cifrarSecreto;
export const descifrarApiKey = descifrarSecreto;

/** Genera una key nueva: 32 bytes de aleatoriedad, con prefijo reconocible. */
export function generarApiKey(): MaterialApiKey {
  const aleatorio = crypto.randomBytes(32).toString("base64url");
  const texto = PREFIJO + aleatorio;
  return { texto, hash: hashDeApiKey(texto), cifrado: cifrarSecreto(texto) };
}
