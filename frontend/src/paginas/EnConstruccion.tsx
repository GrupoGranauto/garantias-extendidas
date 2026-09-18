type Props = { titulo: string };

/** Marcador de posición: la pantalla existe y se navega, pero aún no hace nada. */
export default function EnConstruccion({ titulo }: Props) {
  return (
    <>
      <div className="panel-encabezado">
        <h1>{titulo}</h1>
        <p>Esta sección todavía no tiene funciones.</p>
      </div>

      <div className="marcador">
        <strong>{titulo}</strong>
        <span>Pantalla pendiente de construir.</span>
      </div>
    </>
  );
}
