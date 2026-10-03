import type { Request, Router } from "express";

type PerfilSesion = { rol: string; ejecutivo_asignado: string | null } | undefined;

/**
 * Regla única de visibilidad por ejecutivo: un asesor con ejecutivo asignado solo ve y toca lo de su
 * ejecutivo; el administrador, y un asesor sin ejecutivo asignado, ven todo. Devuelve el nombre del
 * ejecutivo al que se restringe, o null si no hay restricción. Toda ruta que filtre por ejecutivo debe
 * pasar por aquí, para que la regla no se reescriba (ni se olvide) en cada una.
 */
export function ejecutivoRestringido(perfil: PerfilSesion): string | null {
  return perfil && perfil.rol !== "admin" && perfil.ejecutivo_asignado ? perfil.ejecutivo_asignado : null;
}

export const restringidoDe = (req: Request): string | null => ejecutivoRestringido(req.perfil);

/** ¿Puede este perfil tocar un registro cuyo ejecutivo dueño es `dueño`? */
export function puedeTocar(perfil: PerfilSesion, dueño: unknown): boolean {
  const r = ejecutivoRestringido(perfil);
  return r === null || dueño === r;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (valor: unknown): valor is string => typeof valor === "string" && UUID.test(valor);

/** Rechaza con 400 (en vez de un error 500 de la base) los parámetros de ruta que no sean uuid. */
export function exigirUuid(router: Router, ...nombres: string[]): void {
  for (const nombre of nombres) {
    router.param(nombre, (_req, res, next, valor) => {
      if (!esUuid(valor)) {
        res.status(400).json({ error: "Identificador inválido." });
        return;
      }
      next();
    });
  }
}
