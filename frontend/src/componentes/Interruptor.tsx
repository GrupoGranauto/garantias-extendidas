import { useId } from "react";

type Props = {
  etiqueta: string;
  activo: boolean;
  onChange: (activo: boolean) => void;
};

export default function Interruptor({ etiqueta, activo, onChange }: Props) {
  const id = useId();

  return (
    <div className="interruptor">
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={activo}
        className={activo ? "interruptor-riel encendido" : "interruptor-riel"}
        onClick={() => onChange(!activo)}
      >
        <span className="interruptor-bolita" />
      </button>
      <label htmlFor={id}>{etiqueta}</label>
    </div>
  );
}
