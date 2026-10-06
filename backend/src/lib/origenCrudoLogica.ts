import { asignarCampana, inicioEnCampana, sumarDiasFecha, type DefinicionCampana } from "./campanasDefLogica.js";

/**
 * Origen crudo de BigQuery: una fila por VIN, solo con datos de la venta, del vehículo y del cliente. La campaña, su
 * ventana, la elegibilidad y la contactabilidad las calcula la app con las campañas definidas en la web.
 * Funciones puras, sin base de datos.
 */

type Fila = Record<string, unknown>;

const texto = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};

/** ¿La fila viene en formato crudo (sin la campaña calculada por BigQuery)? */
export const esFilaCruda = (m: Fila): boolean => !("campania_actual" in m) && ("nombre" in m || "apellido_paterno" in m || "telefono" in m);

/** Nombre completo en orden natural: «Miguel Borbon López». */
export function nombreCompleto(m: Fila): string | null {
  const partes = [texto(m.nombre), texto(m.apellido_paterno), texto(m.apellido_materno)].filter(Boolean);
  return partes.length ? partes.join(" ") : null;
}

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Lleva una fila cruda a los nombres de campo que usa la sincronización (los de la maestra de siempre), calculando lo que
 * antes calculaba BigQuery: nombre completo y si es contactable (teléfono de 10 dígitos o correo válido). Si el teléfono es
 * celular no se puede saber por el número: queda sin dato.
 */
export function adaptarFilaCruda(m: Fila): Fila {
  const digitos = String(m.telefono ?? "").replace(/\D/g, "");
  const telefono = digitos.length >= 10 ? digitos.slice(-10) : null;
  const correo = texto(m.correo);
  const correoValido = correo && CORREO.test(correo) ? correo.toLowerCase() : null;
  const contactable = Boolean(telefono || correoValido);
  return {
    ...m,
    cliente: nombreCompleto(m),
    telefono_principal: telefono,
    telefono_origen: null,
    tiene_celular: null,
    correo: correoValido,
    es_contactable: contactable,
    motivo_no_contactable: contactable ? null : "SIN_TELEFONO_NI_CORREO",
  };
}

export type EtapaVehiculo = { etapaOrden: number | null; excluido: boolean };

export type CampanaCalculada = {
  campana: string;
  inicio: string;
  fin: string | null;
  fase: string;
  proxima: string | null;
};

/** Primer día del mes siguiente a 'YYYY-MM-DD'. */
function primeroDelMesSiguiente(fecha: string): string {
  const [a, m] = fecha.split("-").map(Number);
  const i = a * 12 + m; // mes siguiente (0-based + 1)
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
}

/**
 * La campaña de un vehículo hoy, con las reglas definidas en la web (la primera que aplica, en el orden del usuario), o
 * null si hoy no está en ninguna. No entra quien ya tiene garantía extendida, quien no es contactable ni el vehículo que
 * las etapas excluyeron. La ventana termina (sin incluir) en `fin`: por días, la fecha + «hasta»; por meses, el primero
 * del mes siguiente.
 */
export function campanaDeVehiculo(
  m: Fila,
  defs: DefinicionCampana[],
  hoy: string,
  etapa: EtapaVehiculo | undefined,
): CampanaCalculada | null {
  if (m.tiene_ge === true || m.es_contactable === false) return null;
  const activas = defs.filter((d) => d.activa);
  const fechaDe = (d: DefinicionCampana) => texto(d.columna_fecha === "fecha_reporte" ? m.fecha_reporte : m.fecha_factura);
  const { elegida } = asignarCampana(activas, (d) => ({ fecha: fechaDe(d), etapaOrden: etapa?.etapaOrden ?? null, excluido: etapa?.excluido ?? false }), hoy);
  if (!elegida) return null;
  const fecha = fechaDe(elegida)!;
  const inicio = inicioEnCampana(elegida, fecha, hoy);
  const fin = elegida.tipo === "dias" ? sumarDiasFecha(fecha, elegida.dias_hasta ?? 0) : primeroDelMesSiguiente(inicio);
  const indice = activas.findIndex((d) => d.nombre === elegida.nombre);
  return { campana: elegida.nombre, inicio, fin, fase: elegida.tipo === "dias" ? "POR_DIAS" : "COHORTE_MENSUAL", proxima: activas[indice + 1]?.nombre ?? null };
}
