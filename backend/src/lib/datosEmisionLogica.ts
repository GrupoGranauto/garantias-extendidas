import { sumarMesesFecha } from "./contratoLogica.js";
import { bandaDeKm, fechasCobertura, kmMaximo, nombreProducto, type ProgramaGe } from "./programaGeLogica.js";

/**
 * Datos para emitir la garantía extendida en el portal de Assurant. Funciones puras, sin base de datos.
 *
 * El portal pide: datos del vehículo (VIN, modelo, año, versión, fecha de factura original, km, número y valor de la
 * factura, número de motor, estado de circulación), información del programa (producto = banda de km + plazo, método de
 * pago, vendedor = el ejecutivo asignado al lead) y la dirección del cliente por partes. La orden de pago le llega al cliente por correo.
 * Las reglas (meses de garantía original, km máximo, plazos, MSI, listas) vienen del programa de la sucursal.
 */

/** Lo que captura el ejecutivo (el resto ya viene de la maestra). */
export const CAMPOS_VEHICULO = ["numero_factura", "valor_factura", "numero_motor", "estado_circulacion"] as const;
export const CAMPOS_DIRECCION = ["dir_cp", "dir_estado", "dir_municipio", "dir_colonia", "dir_calle", "dir_num_ext", "dir_num_int"] as const;
export const CAMPOS_PRODUCTO = ["plazo_meses", "metodo_pago", "msi_meses"] as const;
export const CAMPOS_EMISION = [...CAMPOS_VEHICULO, ...CAMPOS_DIRECCION, ...CAMPOS_PRODUCTO] as const;
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
  dir_cp: "Código postal",
  dir_estado: "Estado",
  dir_municipio: "Municipio",
  dir_colonia: "Colonia",
  dir_calle: "Calle",
  dir_num_ext: "Número exterior",
  dir_num_int: "Número interior",
  plazo_meses: "Plazo",
  metodo_pago: "Forma de pago",
  msi_meses: "Plazo de meses sin intereses",
  vendedor: "Vendedor (ejecutivo asignado)",
};

export type MetodoPago = "contado" | "financiado";

export type DatosEmision = {
  numero_factura: string | null;
  valor_factura: number | null;
  numero_motor: string | null;
  estado_circulacion: string | null;
  dir_cp: string | null;
  dir_estado: string | null;
  dir_municipio: string | null;
  dir_colonia: string | null;
  dir_calle: string | null;
  dir_num_ext: string | null;
  dir_num_int: string | null;
  plazo_meses: number | null;
  metodo_pago: MetodoPago | null;
  msi_meses: number | null;
};

export type DatosEmisionEntrada = Partial<Record<CampoEmision, string | number | null>>;

const texto = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());
const enLista = (v: string, lista: string[]) => lista.find((x) => x.toLowerCase() === v.toLowerCase()) ?? null;
const meses = (n: number) => `${n} ${n === 1 ? "mes" : "meses"}`;

/**
 * Limpia y valida lo que captura el ejecutivo, con las listas y reglas del programa. Solo se revisan los campos que vienen
 * en la entrada; un texto vacío borra el dato (null). `actual` es lo guardado, para revisar MSI contra el método de pago.
 */
export function normalizarDatosEmision(
  entrada: DatosEmisionEntrada,
  programa: ProgramaGe,
  actual: Pick<DatosEmision, "metodo_pago"> = { metodo_pago: null },
): { datos: Partial<DatosEmision> } | { error: string } {
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

  // Estado de circulación y estado de la dirección: de la lista del programa (si tiene); si no, texto libre.
  for (const campo of ["estado_circulacion", "dir_estado"] as const) {
    if (!(campo in entrada)) continue;
    const v = texto(entrada[campo]);
    if (v.length > 60) return { error: `${ETIQUETA_EMISION[campo]}: máximo 60 caracteres.` };
    if (v && programa.estados_circulacion.length > 0) {
      const valido = enLista(v, programa.estados_circulacion);
      if (!valido) return { error: `${ETIQUETA_EMISION[campo]}: elige uno de la lista.` };
      datos[campo] = valido;
    } else datos[campo] = v || null;
  }

  if ("dir_cp" in entrada) {
    const v = texto(entrada.dir_cp).replace(/\s/g, "");
    if (v && !/^\d{5}$/.test(v)) return { error: "El código postal debe tener 5 dígitos." };
    datos.dir_cp = v || null;
  }
  const libres: [keyof DatosEmision, number][] = [["dir_municipio", 120], ["dir_colonia", 120], ["dir_calle", 160], ["dir_num_ext", 20], ["dir_num_int", 20]];
  for (const [campo, max] of libres) {
    if (!(campo in entrada)) continue;
    const v = texto(entrada[campo as CampoEmision]);
    if (v.length > max) return { error: `${ETIQUETA_EMISION[campo]}: máximo ${max} caracteres.` };
    (datos as Record<string, unknown>)[campo] = v || null;
  }

  if ("plazo_meses" in entrada) {
    const v = texto(entrada.plazo_meses);
    if (!v) datos.plazo_meses = null;
    else {
      const n = Number(v);
      if (!programa.plazos_meses.includes(n)) return { error: `El plazo debe ser uno de los del programa: ${programa.plazos_meses.map(meses).join(", ")}.` };
      datos.plazo_meses = n;
    }
  }

  if ("metodo_pago" in entrada) {
    const v = texto(entrada.metodo_pago).toLowerCase();
    if (v && v !== "contado" && v !== "financiado") return { error: "La forma de pago es «Contado» o «Meses sin intereses»." };
    datos.metodo_pago = (v || null) as MetodoPago | null;
  }

  const metodo = "metodo_pago" in datos ? datos.metodo_pago : actual.metodo_pago;
  if ("msi_meses" in entrada) {
    const v = texto(entrada.msi_meses);
    if (!v) datos.msi_meses = null;
    else {
      const n = Number(v);
      if (metodo !== "financiado") return { error: "El plazo de meses sin intereses solo aplica si paga a meses sin intereses." };
      if (!programa.msi_meses.includes(n)) return { error: `Los meses sin intereses deben ser ${programa.msi_meses.join(", ")}.` };
      datos.msi_meses = n;
    }
  }
  // «Contado» no tiene meses sin intereses.
  if (metodo !== "financiado" && ("metodo_pago" in datos || "msi_meses" in datos)) datos.msi_meses = null;

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
  /** «Vendedor a asignar» del portal: el ejecutivo que tiene asignado el lead. No se captura. */
  vendedor: string | null;
  /** Dirección anterior en texto libre (antes de pedirla por partes). Solo se muestra como referencia. */
  direccion: string | null;
};

export type Semaforo = "verde" | "ambar" | "rojo";
export type Producto = { nombre: string; banda: string; cobertura: { inicio: string; fin: string } | null };
export type Completitud = {
  semaforo: Semaforo;
  /** Datos que faltan, con su nombre visible. */
  faltan: { campo: string; etiqueta: string; capturable: boolean }[];
  /** Motivos por los que el vehículo no se puede emitir (no es cosa de capturar datos). */
  bloqueos: string[];
  total: number;
  completos: number;
  /** El producto que se emitiría (banda por el km + plazo), con las fechas de cobertura. */
  producto: Producto | null;
};

const vacio = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

/**
 * Semáforo: rojo si el vehículo no cumple los requisitos del programa (km arriba del máximo o garantía original
 * terminada), ámbar si faltan datos, verde si está todo. `hoy` es 'YYYY-MM-DD' (hora de Hermosillo).
 */
export function evaluarCompletitud(b: BaseEmision, hoy: string, programa: ProgramaGe): Completitud {
  const requeridos: { campo: keyof BaseEmision; capturable: boolean }[] = [
    { campo: "vin", capturable: false },
    { campo: "modelo", capturable: false },
    { campo: "version", capturable: false },
    { campo: "ano_modelo", capturable: false },
    { campo: "fecha_factura", capturable: false },
    // El kilometraje se captura arriba, en Datos: aquí solo se avisa.
    { campo: "kilometraje", capturable: false },
    { campo: "correo", capturable: false },
    ...CAMPOS_VEHICULO.map((campo) => ({ campo, capturable: true })),
    // El número interior es opcional en el portal.
    ...CAMPOS_DIRECCION.filter((c) => c !== "dir_num_int").map((campo) => ({ campo, capturable: true })),
    { campo: "plazo_meses", capturable: true },
    { campo: "metodo_pago", capturable: true },
    ...(b.metodo_pago === "financiado" ? [{ campo: "msi_meses" as const, capturable: true }] : []),
    { campo: "vendedor", capturable: false },
  ];
  const faltan = requeridos.filter((r) => vacio(b[r.campo])).map((r) => ({ campo: r.campo, etiqueta: ETIQUETA_EMISION[r.campo] ?? r.campo, capturable: r.capturable }));

  const bloqueos: string[] = [];
  const maximo = kmMaximo(programa);
  if (typeof b.kilometraje === "number" && b.kilometraje > maximo) {
    bloqueos.push(`El kilometraje (${b.kilometraje.toLocaleString("es-MX")}) pasa de ${maximo.toLocaleString("es-MX")}: no se puede emitir.`);
  }
  const fechaValida = !!b.fecha_factura && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_factura);
  if (fechaValida && hoy >= sumarMesesFecha(b.fecha_factura!, programa.meses_garantia_original)) {
    bloqueos.push(`La garantía original de ${programa.meses_garantia_original} meses ya terminó: no se puede emitir.`);
  }

  const banda = typeof b.kilometraje === "number" ? bandaDeKm(b.kilometraje, programa.bandas_km) : null;
  const producto: Producto | null =
    banda && b.plazo_meses
      ? {
          nombre: nombreProducto(programa.nombre, banda.etiqueta, b.plazo_meses),
          banda: banda.etiqueta,
          cobertura: fechaValida ? fechasCobertura(b.fecha_factura!, programa.meses_garantia_original, b.plazo_meses) : null,
        }
      : null;

  const semaforo: Semaforo = bloqueos.length > 0 ? "rojo" : faltan.length > 0 ? "ambar" : "verde";
  return { semaforo, faltan, bloqueos, total: requeridos.length, completos: requeridos.length - faltan.length, producto };
}
