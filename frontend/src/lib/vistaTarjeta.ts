/** Vista de la tarjeta del embudo (misma forma que en el backend: lib/vistaTarjetaLogica.ts). */
export type LugarTarjeta = "arriba" | "arriba_extra" | "esquina" | "subtitulo" | "titulo" | "detalle" | "pie";
export type VistaTarjeta = Record<LugarTarjeta, string | null> & {
  etiquetas: string[];
  avatar: boolean;
  ultimo_mensaje: boolean;
  tareas: boolean;
  llamar: boolean;
};

export const MAX_ETIQUETAS = 6;

export type CampoValor = { tipo: string; nombre_tecnico?: string; opciones?: { valor: string; color?: string | null }[] | null };

export function iniciales(nombre: unknown): string {
  const partes = String(nombre ?? "").trim().split(/\s+/).filter(Boolean);
  return ((partes[0]?.[0] ?? "") + (partes[1]?.[0] ?? "")).toUpperCase() || "?";
}

const mismoDia = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Texto de un valor según su tipo: fecha corta, fecha y hora relativa («Hoy 10:57», «Ayer 12:07»), números con separador. */
export function textoCampo(valor: unknown, campo: CampoValor | undefined): string | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const tipo = campo?.tipo ?? "texto";
  if (tipo === "booleano") return valor === true || valor === "true" ? "Sí" : "No";
  if (tipo === "entero" || tipo === "decimal") {
    const n = Number(valor);
    // Un año (anio_vin, año modelo…) va sin separador de miles: 2024, no 2,024.
    const esAnio = /(^|_)a(n|ñ)i?o(_|$)/.test(campo?.nombre_tecnico ?? "");
    return Number.isNaN(n) ? String(valor) : n.toLocaleString("es-MX", { useGrouping: !esAnio });
  }
  if (tipo === "fecha") {
    const [a, m, d] = String(valor).slice(0, 10).split("-");
    return a && m && d ? `${d}/${m}/${a}` : String(valor);
  }
  if (tipo === "fecha_hora") {
    const f = new Date(String(valor));
    if (Number.isNaN(f.getTime())) return String(valor);
    const hora = f.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false });
    const hoy = new Date();
    const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1);
    if (mismoDia(f, hoy)) return `Hoy ${hora}`;
    if (mismoDia(f, ayer)) return `Ayer ${hora}`;
    return f.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  return String(valor);
}

/** Color de la opción elegida en un campo de lista (si la opción tiene color). */
export function colorCampo(valor: unknown, campo: CampoValor | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  return campo?.opciones?.find((o) => o.valor === String(valor))?.color ?? null;
}
