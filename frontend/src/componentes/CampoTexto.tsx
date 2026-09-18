import { useId, useState, type ReactNode } from "react";
import { IconoOjo } from "./Iconos";

type Props = {
  etiqueta: string;
  valor: string;
  onChange: (valor: string) => void;
  tipo?: "email" | "text" | "password";
  icono?: ReactNode;
  placeholder?: string;
  autoComplete?: string;
  ayuda?: string;
  /** Se pinta a la derecha de la etiqueta, p. ej. "¿Olvidaste tu contraseña?" */
  accesorio?: ReactNode;
  requerido?: boolean;
};

export default function CampoTexto({
  etiqueta,
  valor,
  onChange,
  tipo = "text",
  icono,
  placeholder,
  autoComplete,
  ayuda,
  accesorio,
  requerido = true,
}: Props) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const esPassword = tipo === "password";

  return (
    <div className="campo">
      <div className="campo-cabecera">
        <label htmlFor={id}>{etiqueta}</label>
        {accesorio}
      </div>

      <div className={esPassword ? "campo-caja con-ojo" : "campo-caja"}>
        <input
          id={id}
          type={esPassword && visible ? "text" : tipo}
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={requerido}
        />
        {icono && <span className="campo-icono">{icono}</span>}
        {esPassword && (
          <button
            type="button"
            className="campo-ojo"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
          >
            <IconoOjo abierto={!visible} />
          </button>
        )}
      </div>

      {ayuda && <small className="ayuda">{ayuda}</small>}
    </div>
  );
}
