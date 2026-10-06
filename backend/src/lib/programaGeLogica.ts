import { sumarMesesFecha } from "./contratoLogica.js";

/**
 * Programa de garantía extendida de una sucursal. Funciones puras, sin base de datos.
 *
 * Los valores por omisión son los del material GEXT de Nissan / Assurant (programa «NISSAN NUEVOS MSI 2026»): garantía
 * original de 36 meses, bandas 0-15,000 y 15,001-59,000 km, extensiones de 12, 24 y 36 meses, pago «Financiado» a 3, 6
 * o 9 MSI y liga de pago de 24 h. Otro grupo u otro año puede tener otras reglas: por eso viven en la base y no en el código.
 */

export type ProgramaGe = {
  nombre: string;
  area_venta: string;
  meses_garantia_original: number;
  bandas_km: number[];
  plazos_meses: number[];
  msi_meses: number[];
  liga_pago_horas: number;
  estados_circulacion: string[];
  vendedores: string[];
};

export const ESTADOS_MEXICO = [
  "Aguascalientes", "Baja California", "Baja California Sur", "Campeche", "Chiapas", "Chihuahua", "Ciudad de México", "Coahuila",
  "Colima", "Durango", "Estado de México", "Guanajuato", "Guerrero", "Hidalgo", "Jalisco", "Michoacán", "Morelos", "Nayarit",
  "Nuevo León", "Oaxaca", "Puebla", "Querétaro", "Quintana Roo", "San Luis Potosí", "Sinaloa", "Sonora", "Tabasco", "Tamaulipas",
  "Tlaxcala", "Veracruz", "Yucatán", "Zacatecas",
];

export const PROGRAMA_POR_OMISION: ProgramaGe = {
  nombre: "NISSAN NUEVOS MSI 2026",
  area_venta: "NUEVOS",
  meses_garantia_original: 36,
  bandas_km: [15000, 59000],
  plazos_meses: [12, 24, 36],
  msi_meses: [3, 6, 9],
  liga_pago_horas: 24,
  estados_circulacion: ESTADOS_MEXICO,
  vendedores: [],
};

const enteros = (a: number[], min: number, max: number) => a.every((n) => Number.isInteger(n) && n >= min && n <= max);
const crecientes = (a: number[]) => a.every((n, i) => i === 0 || n > a[i - 1]);

/** Revisa la configuración. Devuelve el texto del error, o null. */
export function validarPrograma(p: ProgramaGe): string | null {
  if (!p.nombre.trim()) return "Escribe el nombre del programa.";
  if (!Number.isInteger(p.meses_garantia_original) || p.meses_garantia_original < 1 || p.meses_garantia_original > 120) {
    return "Los meses de la garantía original deben estar entre 1 y 120.";
  }
  if (p.bandas_km.length < 1 || p.bandas_km.length > 6 || !enteros(p.bandas_km, 1, 500000) || !crecientes(p.bandas_km)) {
    return "Las bandas de kilometraje deben ser de 1 a 6 límites, de menor a mayor (por ejemplo 15,000 y 59,000).";
  }
  if (p.plazos_meses.length < 1 || p.plazos_meses.length > 10 || !enteros(p.plazos_meses, 1, 120) || !crecientes(p.plazos_meses)) {
    return "Los plazos deben ser de 1 a 10, en meses, de menor a mayor (por ejemplo 12, 24 y 36).";
  }
  if (p.msi_meses.length > 10 || !enteros(p.msi_meses, 1, 48) || !crecientes(p.msi_meses)) {
    return "Los meses sin intereses deben ir de menor a mayor, entre 1 y 48 (por ejemplo 3, 6 y 9).";
  }
  if (!Number.isInteger(p.liga_pago_horas) || p.liga_pago_horas < 1 || p.liga_pago_horas > 720) return "La vigencia de la liga de pago debe estar entre 1 y 720 horas.";
  if (p.estados_circulacion.length > 100 || p.estados_circulacion.some((e) => !e.trim() || e.length > 60)) return "Revisa la lista de estados: máximo 100, de hasta 60 letras.";
  if (new Set(p.estados_circulacion.map((e) => e.trim().toLowerCase())).size !== p.estados_circulacion.length) return "Hay un estado repetido.";
  if (p.vendedores.length > 200 || p.vendedores.some((v) => !v.trim() || v.length > 120)) return "Revisa la lista de vendedores: máximo 200, de hasta 120 letras.";
  if (new Set(p.vendedores.map((v) => v.trim().toLowerCase())).size !== p.vendedores.length) return "Hay un vendedor repetido.";
  return null;
}

/** Kilometraje máximo para vender: el límite de la última banda. */
export const kmMaximo = (p: ProgramaGe): number => p.bandas_km[p.bandas_km.length - 1];

const miles = (n: number) => n.toLocaleString("es-MX");

/** La banda en que cae un kilometraje («0 - 15,000 km»), o null si pasa del máximo o no hay dato. */
export function bandaDeKm(km: number | null, bandas: number[]): { desde: number; hasta: number; etiqueta: string } | null {
  if (km === null || !Number.isFinite(km) || km < 0) return null;
  for (let i = 0; i < bandas.length; i++) {
    if (km <= bandas[i]) {
      const desde = i === 0 ? 0 : bandas[i - 1] + 1;
      return { desde, hasta: bandas[i], etiqueta: `${miles(desde)} - ${miles(bandas[i])} km` };
    }
  }
  return null;
}

/** Nombre del producto como lo muestra el portal, por ejemplo «NISSAN NUEVOS MSI 2026 · 0 - 15,000 km · 24 meses». */
export const nombreProducto = (programa: string, banda: string, plazo: number) => `${programa} · ${banda} · ${plazo} meses`;

/** Fechas de la cobertura extendida: empieza al terminar la original y dura el plazo contratado (el último día es el anterior). */
export function fechasCobertura(fechaFactura: string, mesesOriginal: number, plazoMeses: number): { inicio: string; fin: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaFactura)) return null;
  const inicio = sumarMesesFecha(fechaFactura, mesesOriginal);
  const termina = sumarMesesFecha(inicio, plazoMeses);
  const d = new Date(`${termina}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { inicio, fin: d.toISOString().slice(0, 10) };
}
