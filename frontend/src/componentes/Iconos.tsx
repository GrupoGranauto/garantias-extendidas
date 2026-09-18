/** Iconos de trazo (geometría de lucide, igual que el diseño de referencia). */

const trazo = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

type IconoProps = { className?: string };

export function IconoCorreo({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      <rect x="2" y="4" width="20" height="16" rx="2" />
    </svg>
  );
}

export function IconoCandado({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function IconoOjo({ abierto, className }: IconoProps & { abierto: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
      {!abierto && <path d="m3 21 18-18" />}
    </svg>
  );
}

export function IconoFlecha({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function IconoGoogle({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-1 .67-2.28 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.67-.35-1.39-.35-2.09s.13-1.42.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

/* ---------- Navegación del panel ---------- */

export function IconoInicio({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.8V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.8" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  );
}

export function IconoGrupos({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
      <circle cx="9" cy="7" r="3.2" />
      <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
      <path d="M16.5 4.1a3.2 3.2 0 0 1 0 6.2" />
    </svg>
  );
}

export function IconoUsuarios({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="M19 20v-1.5a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4V20" />
      <circle cx="11.5" cy="7.5" r="3.5" />
    </svg>
  );
}

export function IconoPaneles({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M21.5 20h-19" />
    </svg>
  );
}

export function IconoPuestos({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <rect x="3" y="7.5" width="18" height="12.5" rx="2" />
      <path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" />
      <path d="M3 13h18" />
    </svg>
  );
}

export function IconoAdministradores({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V6L12 3Z" />
      <path d="m9.3 12 1.9 1.9 3.5-3.6" />
    </svg>
  );
}

export function IconoChevron({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconoMenu({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </svg>
  );
}

export function IconoSalir({ className }: IconoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...trazo}>
      <path d="M15 17v1.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2V7" />
      <path d="M10 12h11" />
      <path d="m18 9 3 3-3 3" />
    </svg>
  );
}
