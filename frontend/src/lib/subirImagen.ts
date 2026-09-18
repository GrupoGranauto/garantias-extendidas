import { supabase } from "./supabase";

const BUCKET = "marca";
const LIMITE_BYTES = 2 * 1024 * 1024;

/** Nombre seguro y único: sin acentos, espacios ni choques entre sucursales. */
function rutaPara(subdominio: string, campo: string, archivo: File): string {
  const extension = (archivo.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${subdominio}/${campo}-${Date.now()}.${extension}`;
}

/**
 * Sube una imagen del portal y devuelve su URL pública.
 * La escritura la autoriza una política de Storage: solo rol admin.
 */
export async function subirImagen(
  subdominio: string,
  campo: string,
  archivo: File,
): Promise<string> {
  if (archivo.size > LIMITE_BYTES) {
    throw new Error(`"${archivo.name}" pesa más de 2 MB.`);
  }

  const ruta = rutaPara(subdominio, campo, archivo);

  const { error } = await supabase.storage.from(BUCKET).upload(ruta, archivo, {
    cacheControl: "3600",
    upsert: false,
    contentType: archivo.type || undefined,
  });

  if (error) {
    throw new Error(`No se pudo subir "${archivo.name}": ${error.message}`);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(ruta);
  return data.publicUrl;
}
