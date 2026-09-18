/** Mensajes de Supabase Auth traducidos a algo legible para el usuario. */
const MAPA: Array<[RegExp, string]> = [
  [/invalid login credentials/i, "Correo o contraseña incorrectos."],
  [/email not confirmed/i, "Falta confirmar tu correo. Revisa la bandeja de entrada."],
  [/signups not allowed|signup_disabled|email signups are disabled/i,
    "Esta cuenta no está dada de alta. Pídele acceso al administrador."],
  // La base rechaza altas sin invitación (trigger exigir_invitacion_al_crear)
  [/alta_no_autorizada|database error saving new user/i,
    "Esta cuenta no está autorizada. El acceso lo da un administrador."],
  [/password should be at least (\d+)/i, "La contraseña es demasiado corta."],
  [/unable to validate email address/i, "El correo no tiene un formato válido."],
  [/email rate limit exceeded|over_email_send_rate_limit/i, "Demasiados intentos. Espera unos minutos."],
  [/for security purposes.*(\d+) seconds/i, "Demasiados intentos seguidos. Espera un momento."],
  [/new password should be different/i, "La contraseña nueva debe ser distinta de la anterior."],
  [/auth session missing|invalid claim|jwt expired/i, "La sesión expiró. Vuelve a iniciar sesión."],
  [/provider is not enabled/i, "El acceso con Google no está habilitado en el proyecto."],
  [/code verifier|pkce/i,
    "El enlace se abrió en otro navegador o se limpió el almacenamiento. Inicia sesión de nuevo."],
  [/failed to fetch|networkerror/i, "Sin conexión con el servidor de autenticación."],
];

export function traducirError(mensaje: string): string {
  for (const [patron, texto] of MAPA) {
    if (patron.test(mensaje)) return texto;
  }
  return mensaje;
}
