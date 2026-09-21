type Props = { pantalla?: boolean };

/** Icono de carga. `pantalla` lo centra a todo lo alto (para el arranque de la app). */
export default function Cargador({ pantalla }: Props) {
  return (
    <div className={`cargador${pantalla ? " cargador-pantalla" : ""}`} role="status" aria-label="Cargando">
      <span className="cargador-spinner" />
    </div>
  );
}
