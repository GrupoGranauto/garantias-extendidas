const REGEX_IDENTIFICADOR = /^[a-z][a-z0-9_]*$/;

/**
 * Convierte una etiqueta legible en un identificador técnico de Postgres:
 * minúsculas, sin acentos, todo lo no alfanumérico colapsado a "_".
 * Solo hace el campo más cómodo mientras se escribe; el backend vuelve a
 * validar la forma final antes de tocar el DDL.
 */
export function aNombreTecnico(texto: string): string {
  const normalizado = texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // quita acentos

  let slug = "";
  for (const caracter of normalizado) {
    if (/[a-z0-9]/.test(caracter)) {
      slug += caracter;
    } else if (/[ \-_./]/.test(caracter)) {
      slug += "_";
    }
  }

  return slug.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/** Valida un identificador antes de que llegue al DDL: nunca confiar en el de un cliente. */
export function identificadorValido(valor: string): boolean {
  return REGEX_IDENTIFICADOR.test(valor);
}

/** Lanza si el identificador no es seguro para interpolar en SQL. Última línea de defensa. */
export function exigirIdentificador(valor: string, etiqueta: string): string {
  if (!identificadorValido(valor)) {
    throw new Error(`${etiqueta} inválido: '${valor}'.`);
  }
  return valor;
}
