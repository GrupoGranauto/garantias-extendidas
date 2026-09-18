import { useEffect, useState } from "react";

export type Imagen = {
  archivo: File | null;
  /** URL temporal para previsualizar. Se libera sola al cambiar. */
  vista: string | null;
  cambiar: (archivo: File | null) => void;
};

/** Maneja un archivo de imagen y su vista previa local. No sube nada. */
export function useImagen(): Imagen {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [vista, setVista] = useState<string | null>(null);

  useEffect(() => {
    if (!archivo) {
      setVista(null);
      return;
    }
    const url = URL.createObjectURL(archivo);
    setVista(url);
    return () => URL.revokeObjectURL(url);
  }, [archivo]);

  return { archivo, vista, cambiar: setArchivo };
}
