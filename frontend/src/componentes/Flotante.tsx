import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Menú flotante anclado a un elemento. Se dibuja en el <body> con posición fija,
 * así no lo corta el scroll ni el overflow de la tabla. Se abre hacia abajo, o
 * hacia arriba si abajo no cabe. Se cierra al hacer clic fuera, al hacer scroll
 * fuera del menú (no dentro de él), al redimensionar o con Escape.
 */
export default function Flotante({
  ancla,
  onCerrar,
  children,
  anchoMinimo,
  className,
}: {
  ancla: RefObject<HTMLElement | null>;
  onCerrar: () => void;
  children: ReactNode;
  anchoMinimo?: number;
  className?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; ancho: number; top?: number; bottom?: number; alto: number } | null>(null);

  useLayoutEffect(() => {
    const el = ancla.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const abajo = window.innerHeight - r.bottom - 16;
    const arriba = r.top - 16;
    // Hacia arriba solo si abajo queda corto y arriba hay claramente más espacio.
    const haciaArriba = abajo < 200 && arriba > abajo;
    const alto = Math.max(140, Math.min(360, haciaArriba ? arriba : abajo));
    const ancho = Math.max(r.width, anchoMinimo ?? 0);
    const left = Math.min(r.left, Math.max(8, window.innerWidth - ancho - 8));
    setPos(
      haciaArriba
        ? { left, ancho, bottom: window.innerHeight - r.top + 6, alto }
        : { left, ancho, top: r.bottom + 6, alto },
    );
  }, [ancla, anchoMinimo]);

  useEffect(() => {
    const alPulsar = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ancla.current?.contains(t) || menuRef.current?.contains(t)) return;
      onCerrar();
    };
    const alScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onCerrar();
    };
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    document.addEventListener("mousedown", alPulsar);
    document.addEventListener("keydown", alTeclear);
    window.addEventListener("scroll", alScroll, true);
    window.addEventListener("resize", onCerrar);
    return () => {
      document.removeEventListener("mousedown", alPulsar);
      document.removeEventListener("keydown", alTeclear);
      window.removeEventListener("scroll", alScroll, true);
      window.removeEventListener("resize", onCerrar);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pos) return null;
  return createPortal(
    <div
      ref={menuRef}
      className={`flotante${className ? ` ${className}` : ""}`}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.ancho, maxHeight: pos.alto }}
    >
      {children}
    </div>,
    document.body,
  );
}
