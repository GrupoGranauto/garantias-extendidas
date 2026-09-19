import { useId } from "react";
import type { Imagen } from "../lib/useImagen";

type Props = {
  etiqueta: string;
  imagen: Imagen;
  /** Medida o formato sugerido, solo informativo. */
  recomendado?: string;
};

/** Selector de imagen con vista previa. No sube nada todavía. */
export default function CampoArchivo({ etiqueta, imagen, recomendado }: Props) {
  const id = useId();
  const { archivo, vista, cambiar } = imagen;

  return (
    <div className="campo-formulario">
      <div className="campo-cabecera-fila">
        <label htmlFor={id}>{etiqueta}</label>
        {recomendado && <span className="campo-pista">{recomendado}</span>}
      </div>

      <div className={vista ? "campo-archivo con-archivo" : "campo-archivo"}>
        <div className="campo-archivo-vista">
          {vista ? <img src={vista} alt="" /> : <span className="campo-archivo-hueco" aria-hidden="true" />}
        </div>

        <div className="campo-archivo-datos">
          <p className="campo-archivo-nombre">
            {archivo ? archivo.name : vista ? "Imagen actual" : "Ningún archivo seleccionado"}
          </p>
          {archivo && <p className="campo-archivo-peso">{(archivo.size / 1024).toFixed(0)} KB</p>}
        </div>

        <div className="campo-archivo-acciones">
          <label htmlFor={id} className="boton-tenue">
            {vista ? "Cambiar" : "Seleccionar"}
          </label>
          {vista && (
            <button type="button" className="boton-tenue" onClick={() => cambiar(null)}>
              Quitar
            </button>
          )}
        </div>

        <input
          id={id}
          type="file"
          accept="image/*"
          className="campo-archivo-input"
          onChange={(e) => cambiar(e.target.files?.[0] ?? null)}
        />
      </div>
    </div>
  );
}
