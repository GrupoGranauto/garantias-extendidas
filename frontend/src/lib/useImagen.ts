import { useEffect, useState } from "react";

export type Imagen = {
  /** Archivo nuevo elegido en esta sesión, si lo hay. */
  archivo: File | null;
  /** URL a mostrar: la del archivo nuevo, o la existente si no se ha tocado. */
  vista: string | null;
  /** Había una imagen existente y el usuario la quitó sin reemplazarla. */
  quitada: boolean;
  cambiar: (archivo: File | null) => void;
};

/**
 * Maneja un archivo de imagen y su vista previa.
 *
 * Con `urlInicial` (modo edición) muestra esa imagen hasta que el usuario
 * elija otra o le dé "Quitar". No sube nada por sí solo.
 */
export function useImagen(urlInicial: string | null = null): Imagen {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [urlRemota, setUrlRemota] = useState(urlInicial);
  const [vistaLocal, setVistaLocal] = useState<string | null>(null);

  // La carga de datos en modo edición llega después del primer render;
  // sin esto, useState(urlInicial) se quedaría con el valor del montaje.
  useEffect(() => {
    setUrlRemota(urlInicial);
  }, [urlInicial]);

  useEffect(() => {
    if (!archivo) {
      setVistaLocal(null);
      return;
    }
    const url = URL.createObjectURL(archivo);
    setVistaLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [archivo]);

  function cambiar(nuevo: File | null) {
    setArchivo(nuevo);
    if (nuevo === null) setUrlRemota(null); // "Quitar": limpia tanto lo nuevo como lo existente
  }

  return {
    archivo,
    vista: vistaLocal ?? urlRemota,
    quitada: urlInicial !== null && archivo === null && urlRemota === null,
    cambiar,
  };
}
