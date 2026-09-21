import { supabase } from "./supabase";

const LIMITE_BYTES = 2 * 1024 * 1024;

/** Nombre seguro y único: sin acentos, espacios ni choques entre carpetas. */
function rutaPara(carpeta: string, campo: string, archivo: File): string {
  const extension = (archivo.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${carpeta}/${campo}-${Date.now()}.${extension}`;
}

/**
 * Sube una imagen y devuelve su URL pública.
 * La escritura la autoriza una política de Storage: solo rol admin.
 */
export async function subirImagen(
  carpeta: string,
  campo: string,
  archivo: File,
  bucket: string = "marca",
): Promise<string> {
  if (archivo.size > LIMITE_BYTES) {
    throw new Error(`"${archivo.name}" pesa más de 2 MB.`);
  }

  const ruta = rutaPara(carpeta, campo, archivo);

  const { error } = await supabase.storage.from(bucket).upload(ruta, archivo, {
    cacheControl: "3600",
    upsert: false,
    contentType: archivo.type || undefined,
  });

  if (error) {
    throw new Error(`No se pudo subir "${archivo.name}": ${error.message}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(ruta);
  return data.publicUrl;
}
