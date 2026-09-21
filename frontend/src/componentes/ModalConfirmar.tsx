type Props = {
  abierto: boolean;
  titulo: string;
  mensaje: string;
  textoConfirmar?: string;
  peligro?: boolean;
  enviando?: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
};

/** Diálogo de confirmación propio: reemplaza al window.confirm() del navegador. */
export default function ModalConfirmar({
  abierto,
  titulo,
  mensaje,
  textoConfirmar = "Confirmar",
  peligro,
  enviando,
  onConfirmar,
  onCancelar,
}: Props) {
  if (!abierto) return null;

  return (
    <div className="modal-fondo" onClick={onCancelar}>
      <div
        className="modal-tarjeta"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="modal-confirmar-titulo"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="modal-confirmar-titulo">{titulo}</h2>
        <p>{mensaje}</p>
        <div className="modal-acciones">
          <button type="button" className="boton-secundario-claro" onClick={onCancelar} disabled={enviando}>
            Cancelar
          </button>
          <button
            type="button"
            className={peligro ? "boton-guardar boton-guardar-peligro" : "boton-guardar"}
            onClick={onConfirmar}
            disabled={enviando}
          >
            {enviando ? "Un momento…" : textoConfirmar}
          </button>
        </div>
      </div>
    </div>
  );
}
