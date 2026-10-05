import { MESES_GARANTIA_ORIGINAL, sumarMesesFecha } from "./contratoLogica.js";

/**
 * Datos para emitir la garantía extendida en el portal de Assurant. Funciones puras, sin base de datos.
 *
 * El portal pide: VIN, modelo, año, versión, fecha de factura original, kilometraje, número y valor de la factura,
 * número de motor, estado de circulación y dirección del cliente; la orden de pago le llega al cliente por correo.
 * El vehículo debe estar dentro de la garantía original (36 meses) y tener como máximo 59,000 km.
 */

export const KM_MAXIMO_PARA_EMITIR = 59000;

/** Los cinco datos que captura el ejecutivo (el resto ya viene de la maestra). */
export const CAMPOS_EMISION = ["numero_factura", "valor_factura", "numero_motor", "estado_circulacion", "direccion"] as const;
export type CampoEmision = (typeof CAMPOS_EMISION)[number];

export const ETIQUETA_EMISION: Record<string, string> = {
  vin: "VIN",
  modelo: "Modelo",
  version: "Versión",
  ano_modelo: "Año",
  fecha_factura: "Fecha de la factura",
  kilometraje: "Kilometraje",
  correo: "Correo del cliente",
  numero_factura: "Número de factura",
  valor_factura: "Valor de la factura",
  numero_motor: "Número de motor",
  estado_circulacion: "Estado de circulación",
  direccion: "Dirección del cliente",
};

export type DatosEmisionEntrada = Partial<Record<CampoEmision, string | number | null>>;
export type DatosEmision = {
  numero_factura: string | null;
  valor_factura: number | null;
  numero_motor: string | null;
  estado_circulacion: string | null;
  direccion: string | null;
};

const texto = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());

/**
 * Limpia y valida lo que captura el ejecutivo. Solo se revisan los campos que vienen en la entrada; un texto vacío
 * borra el dato (null). Devuelve los campos listos para guardar o el texto del error.
 */
export function normalizarDatosEmision(entrada: DatosEmisionEntrada): { datos: Partial<DatosEmision> } | { error: string } {
  const datos: Partial<DatosEmision> = {};

  if ("numero_factura" in entrada) {
    const v = texto(entrada.numero_factura);
    if (v.length > 40) return { error: "El número de factura no puede pasar de 40 caracteres." };
    if (v && !/^[A-Za-z0-9._\-/ ]+$/.test(v)) return { error: "El número de factura solo puede llevar letras, números, punto, guion y diagonal." };
    datos.numero_factura = v ? v.toUpperCase() : null;
  }

  if ("valor_factura" in entrada) {
    const crudo = texto(entrada.valor_factura).replace(/[$,\s]/g, "");
    if (!crudo) datos.valor_factura = null;
    else {
      if (!/^\d+(\.\d{1,2})?$/.test(crudo)) return { error: "El valor de la factura debe ser un monto, por ejemplo 385000 o 385000.50." };
      const n = Number(crudo);
      if (!(n > 0) || n > 99999999) return { error: "El valor de la factura debe ser mayor que 0 y menor de 100 millones." };
      datos.valor_factura = Math.round(n * 100) / 100;
    }
  }

  if ("numero_motor" in entrada) {
    const v = texto(entrada.numero_motor).replace(/\s/g, "");
    if (v.length > 30) return { error: "El número de motor no puede pasar de 30 caracteres." };
    if (v && !/^[A-Za-z0-9-]+$/.test(v)) return { error: "El número de motor solo puede llevar letras, números y guion." };
    datos.numero_motor = v ? v.toUpperCase() : null;
  }

  if ("estado_circulacion" in entrada) {
    const v = texto(entrada.estado_circulacion);
    if (v.length > 60) return { error: "El estado de circulación no puede pasar de 60 caracteres." };
    datos.estado_circulacion = v || null;
  }

  if ("direccion" in entrada) {
    const v = texto(entrada.direccion);
    if (v.length > 300) return { error: "La dirección no puede pasar de 300 caracteres." };
    datos.direccion = v || null;
  }

  return { datos };
}

/** Todo lo que se necesita para revisar si el vehículo está listo para emitir. */
export type BaseEmision = DatosEmision & {
  vin: string | null;
  modelo: string | null;
  version: string | null;
  ano_modelo: number | null;
  fecha_factura: string | null;
  kilometraje: number | null;
  correo: string | null;
};

export type Semaforo = "verde" | "ambar" | "rojo";
export type Completitud = {
  semaforo: Semaforo;
  /** Datos que faltan, con su nombre visible. */
  faltan: { campo: string; etiqueta: string; capturable: boolean }[];
  /** Motivos por los que el vehículo no se puede emitir (no es cosa de capturar datos). */
  bloqueos: string[];
  total: number;
  completos: number;
};

const vacio = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

/**
 * Semáforo: rojo si el vehículo no cumple los requisitos (km pasado de 59,000 o garantía original terminada),
 * ámbar si faltan datos, verde si está todo. `hoy` es 'YYYY-MM-DD' (hora de Hermosillo).
 */
export function evaluarCompletitud(b: BaseEmision, hoy: string): Completitud {
  const requeridos: { campo: keyof BaseEmision; capturable: boolean }[] = [
    { campo: "vin", capturable: false },
    { campo: "modelo", capturable: false },
    { campo: "version", capturable: false },
    { campo: "ano_modelo", capturable: false },
    { campo: "fecha_factura", capturable: false },
    // El kilometraje se captura arriba, en Datos: aquí solo se avisa.
    { campo: "kilometraje", capturable: false },
    { campo: "correo", capturable: false },
    { campo: "numero_factura", capturable: true },
    { campo: "valor_factura", capturable: true },
    { campo: "numero_motor", capturable: true },
    { campo: "estado_circulacion", capturable: true },
    { campo: "direccion", capturable: true },
  ];
  const faltan = requeridos.filter((r) => vacio(b[r.campo])).map((r) => ({ campo: r.campo, etiqueta: ETIQUETA_EMISION[r.campo] ?? r.campo, capturable: r.capturable }));

  const bloqueos: string[] = [];
  if (typeof b.kilometraje === "number" && b.kilometraje > KM_MAXIMO_PARA_EMITIR) {
    bloqueos.push(`El kilometraje (${b.kilometraje.toLocaleString("es-MX")}) pasa de ${KM_MAXIMO_PARA_EMITIR.toLocaleString("es-MX")}: no se puede emitir.`);
  }
  if (b.fecha_factura && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_factura) && hoy >= sumarMesesFecha(b.fecha_factura, MESES_GARANTIA_ORIGINAL)) {
    bloqueos.push("La garantía original de 36 meses ya terminó: no se puede emitir.");
  }

  const semaforo: Semaforo = bloqueos.length > 0 ? "rojo" : faltan.length > 0 ? "ambar" : "verde";
  return { semaforo, faltan, bloqueos, total: requeridos.length, completos: requeridos.length - faltan.length };
}
