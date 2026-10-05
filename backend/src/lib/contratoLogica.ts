/**
 * Reglas del contrato (pago y cierre automáticos). Funciones puras, sin base de datos.
 *
 * Un contrato avanza por estados (cotizado, aceptado, orden de pago, pago confirmado, certificado entregado, cobertura
 * iniciada) y guarda la fecha de cada cambio. Una regla dice: «cuando el contrato lleve N horas en el estado X, crea esta
 * tarea». Además, la cobertura de la garantía extendida empieza cuando termina la garantía original (36 meses desde la factura).
 */

export const ESTADOS_CON_REGLA = ["cotizado", "aceptado", "orden_pago", "pago_confirmado", "certificado_entregado", "cobertura_iniciada"] as const;
export type EstadoConRegla = (typeof ESTADOS_CON_REGLA)[number];

/** La garantía original de Nissan dura 3 años: la extendida empieza al terminar. */
export const MESES_GARANTIA_ORIGINAL = 36;

export type EventoContrato = { estado?: unknown; en?: unknown };

/**
 * Desde cuándo está el contrato en su estado actual (ISO), o null si no se puede saber. Cuenta desde el primer evento de la
 * racha actual: guardar otra vez el mismo estado (por ejemplo, para agregar el folio) NO reinicia el reloj; salir del estado y
 * volver a entrar sí.
 */
export function entradaAlEstado(eventos: EventoContrato[], estadoActual: string, respaldo: string | null): string | null {
  const lista = Array.isArray(eventos) ? eventos : [];
  let inicio = -1;
  for (let i = lista.length - 1; i >= 0; i--) {
    if (lista[i]?.estado !== estadoActual) break;
    inicio = i;
  }
  const en = inicio >= 0 ? lista[inicio]?.en : undefined;
  if (typeof en === "string" && !Number.isNaN(Date.parse(en))) return new Date(en).toISOString();
  return respaldo && !Number.isNaN(Date.parse(respaldo)) ? new Date(respaldo).toISOString() : null;
}

/** Suma meses a 'YYYY-MM-DD' sin pasarse del fin de mes (31 de enero + 1 mes = 28 o 29 de febrero). */
export function sumarMesesFecha(fecha: string, meses: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  const indice = a * 12 + (m - 1) + meses;
  const anio = Math.floor(indice / 12);
  const mes = (indice % 12) + 1;
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, "0")}-${String(Math.min(d, ultimoDia)).padStart(2, "0")}`;
}

/** El día en que empieza la cobertura de la garantía extendida: 36 meses después de la factura. */
export const inicioDeCobertura = (fechaFactura: string): string => sumarMesesFecha(fechaFactura, MESES_GARANTIA_ORIGINAL);

/** ¿Ya terminó la garantía original (y por tanto empezó la cobertura)? */
export function coberturaYaInicio(fechaFactura: string | null, hoy: string): boolean {
  if (!fechaFactura || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFactura)) return false;
  return hoy >= inicioDeCobertura(fechaFactura);
}

export type ReglaContratoEntrada = {
  nombre: string;
  activa: boolean;
  estado: string;
  espera_horas: number;
  titulo: string;
  descripcion: string | null;
  vence_horas: number | null;
};

/** Revisa una regla. Devuelve el texto del error, o null. */
export function validarReglaContrato(r: ReglaContratoEntrada): string | null {
  const nombre = r.nombre.trim();
  if (!nombre) return "Cada regla necesita un nombre.";
  if (!(ESTADOS_CON_REGLA as readonly string[]).includes(r.estado)) return `«${nombre}»: el estado del contrato no es válido.`;
  if (!Number.isInteger(r.espera_horas) || r.espera_horas < 0 || r.espera_horas > 8760) return `«${nombre}»: la espera debe estar entre 0 y 8,760 horas (un año).`;
  if (!r.titulo.trim()) return `«${nombre}»: escribe el título de la tarea.`;
  if (r.vence_horas !== null && (!Number.isInteger(r.vence_horas) || r.vence_horas < 0 || r.vence_horas > 8760)) return `«${nombre}»: el vencimiento no es válido.`;
  return null;
}

export function validarReglasContrato(lista: ReglaContratoEntrada[]): string | null {
  if (lista.length > 20) return "Máximo 20 reglas.";
  const nombres = new Set<string>();
  for (const r of lista) {
    const e = validarReglaContrato(r);
    if (e) return e;
    const n = r.nombre.trim().toLowerCase();
    if (nombres.has(n)) return `Hay dos reglas llamadas «${r.nombre.trim()}».`;
    nombres.add(n);
  }
  return null;
}
