import { IconoGoogle } from "./Iconos";

type Props = { onClick: () => void; deshabilitado?: boolean; texto?: string };

export default function BotonGoogle({
  onClick,
  deshabilitado,
  texto = "Continuar con Google",
}: Props) {
  return (
    <button type="button" className="boton-google" onClick={onClick} disabled={deshabilitado}>
      <IconoGoogle />
      {texto}
    </button>
  );
}
