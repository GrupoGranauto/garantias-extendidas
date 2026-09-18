export const MIN_PASSWORD = 8;

export function correoValido(correo: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo.trim());
}

/** Devuelve el problema encontrado, o null si la contraseña pasa. */
export function revisarPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD) {
    return `Debe tener al menos ${MIN_PASSWORD} caracteres.`;
  }
  if (!/[a-z]/.test(password)) return "Debe incluir al menos una minúscula.";
  if (!/[A-Z]/.test(password)) return "Debe incluir al menos una mayúscula.";
  if (!/[0-9]/.test(password)) return "Debe incluir al menos un número.";
  return null;
}
