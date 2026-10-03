/**
 * Campañas que define el usuario: a qué campaña pertenece cada lead según la fecha de su vehículo. Funciones puras,
 * sin base de datos.
 *
 * Dos tipos:
 *  - "dias": ventana en días transcurridos desde la fecha. Entra cuando ya pasaron al menos `dias_desde` y todavía
 *    no llegan a `dias_hasta` (el límite superior no entra). Se recalcula todos los días: los leads entran y salen
 *    solos conforme pasa el tiempo.
 *  - "meses": cohorte mensual. Pertenecen los leads cuya fecha cae en el mes que quedó `meses_atras` meses atrás
 *    del mes actual, sin importar el día. Se envía el día `dia_envio` del mes, a la hora `hora_envio`.
 *
 * Opcionalmente una campaña pide una etapa del vehículo (por su número de orden): el lead solo entra si su
 * vehículo está en esa etapa.
 */

export type TipoCampana = "dias" | "meses";

export type DefinicionCampana = {
  id?: string;
  nombre: string;
  tipo: TipoCampana;
  columna_fecha: "fecha_factura" | "fecha_reporte";
  dias_desde: number | null;
  dias_hasta: number | null;
  meses_atras: number | null;
  /** Día del mes (1 a 28) en que se envía la cohorte. Solo para tipo "meses". */
  dia_envio: number | null;
  /** "HH:MM". Solo para tipo "meses". */
  hora_envio: string | null;
  /** Orden de la etapa del vehículo que se exige, o null si sirve cualquiera. */
  etapa_orden: number | null;
  activa: boolean;
};

export type LeadCampana = {
  /** Fecha de la columna elegida por la campaña, 'YYYY-MM-DD', o null. */
  fecha: string | null;
  /** Orden de la etapa del vehículo del lead, o null si no tiene. */
  etapaOrden: number | null;
};

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Días completos entre dos fechas 'YYYY-MM-DD' (negativo si la primera es posterior). */
export function diasTranscurridos(fecha: string, hoy: string): number {
  const [a1, m1, d1] = fecha.split("-").map(Number);
  const [a2, m2, d2] = hoy.split("-").map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000);
}

/** Mes ('YYYY-MM') que quedó `n` meses atrás del mes de `hoy`. */
export function mesAtras(hoy: string, n: number): string {
  const [a, m] = hoy.split("-").map(Number);
  const indice = a * 12 + (m - 1) - n;
  const anio = Math.floor(indice / 12);
  return `${anio}-${String((indice % 12) + 1).padStart(2, "0")}`;
}

/** ¿El lead pertenece hoy a esta campaña? */
export function perteneceACampana(def: DefinicionCampana, lead: LeadCampana, hoy: string): boolean {
  if (!def.activa) return false;
  if (def.etapa_orden !== null && lead.etapaOrden !== def.etapa_orden) return false;
  if (!lead.fecha || !FECHA.test(lead.fecha)) return false;

  if (def.tipo === "dias") {
    if (def.dias_desde === null || def.dias_hasta === null) return false;
    const d = diasTranscurridos(lead.fecha, hoy);
    return d >= def.dias_desde && d < def.dias_hasta;
  }
  if (def.meses_atras === null) return false;
  return lead.fecha.slice(0, 7) === mesAtras(hoy, def.meses_atras);
}

/**
 * La campaña del lead: la primera de la lista (en el orden que puso el usuario) a la que pertenece. Devuelve
 * también todas las que lo incluyen, para avisar cuando dos reglas se traslapan.
 */
export function asignarCampana<T extends DefinicionCampana>(
  defs: T[],
  lead: (def: T) => LeadCampana,
  hoy: string,
): { elegida: T | null; todas: T[] } {
  const todas = defs.filter((d) => perteneceACampana(d, lead(d), hoy));
  return { elegida: todas[0] ?? null, todas };
}

/**
 * Desde cuándo cuenta la campaña para un lead que pertenece a ella hoy: de aquí se cuentan los días de cada paso.
 *  - Por días: el primer día que cumple la ventana (la fecha del vehículo + `dias_desde`).
 *  - Por meses: el día de envío de este mes. Un lead que llega después de ese día queda con un inicio ya pasado: su
 *    primer mensaje sale en cuanto abra la ventana de envío si todavía está dentro de la vigencia del paso; si no, se
 *    omite y queda registrado.
 */
export function inicioEnCampana(def: DefinicionCampana, fecha: string, hoy: string): string {
  if (def.tipo === "dias") return sumarDiasFecha(fecha, def.dias_desde ?? 0);
  return `${hoy.slice(0, 7)}-${String(def.dia_envio ?? 1).padStart(2, "0")}`;
}

/** Suma días a una fecha 'YYYY-MM-DD'. */
export function sumarDiasFecha(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** La hora del primer mensaje: la que puso el paso; si no, la de la campaña por meses; si no, al abrir la ventana (null). */
export function horaDelPaso(horaPaso: string | null, horaCampana: string | null): string | null {
  return horaPaso ?? horaCampana ?? null;
}

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Revisa una definición. Devuelve el texto del error, o null. */
export function validarDefinicion(d: DefinicionCampana): string | null {
  const nombre = d.nombre.trim();
  if (!nombre) return "Cada campaña necesita un nombre.";
  if (!/^[A-Za-z0-9_]{1,30}$/.test(nombre)) return `«${nombre}»: el nombre solo puede tener letras, números y guion bajo (sin espacios), hasta 30 caracteres.`;
  if (d.tipo === "dias") {
    if (d.dias_desde === null || d.dias_hasta === null) return `«${nombre}»: indica desde y hasta cuántos días.`;
    if (!Number.isInteger(d.dias_desde) || !Number.isInteger(d.dias_hasta) || d.dias_desde < 0 || d.dias_hasta > 3650) {
      return `«${nombre}»: los días deben ser números enteros entre 0 y 3,650.`;
    }
    if (d.dias_hasta <= d.dias_desde) return `«${nombre}»: el «hasta» debe ser mayor que el «desde» (el límite superior no entra).`;
    return null;
  }
  if (d.meses_atras === null || !Number.isInteger(d.meses_atras) || d.meses_atras < 0 || d.meses_atras > 120) {
    return `«${nombre}»: indica de hace cuántos meses es la cohorte (0 a 120).`;
  }
  if (d.dia_envio === null || !Number.isInteger(d.dia_envio) || d.dia_envio < 1 || d.dia_envio > 28) {
    return `«${nombre}»: el día de envío debe estar entre 1 y 28 para existir en todos los meses.`;
  }
  if (!d.hora_envio || !HORA.test(d.hora_envio)) return `«${nombre}»: la hora de envío no es válida (HH:MM).`;
  return null;
}

/** Revisa toda la lista: cada definición, nombres distintos y sin pasar de 20. */
export function validarDefiniciones(defs: DefinicionCampana[]): string | null {
  if (defs.length > 20) return "Máximo 20 campañas.";
  const nombres = new Set<string>();
  for (const d of defs) {
    const error = validarDefinicion(d);
    if (error) return error;
    const n = d.nombre.trim().toLowerCase();
    if (nombres.has(n)) return `Hay dos campañas llamadas «${d.nombre.trim()}».`;
    nombres.add(n);
  }
  return null;
}

/** La regla en una frase, para mostrarla en pantalla. */
export function describirDefinicion(d: DefinicionCampana): string {
  const fecha = d.columna_fecha === "fecha_reporte" ? "la fecha de reporte" : "la fecha de factura";
  const etapa = d.etapa_orden !== null ? ` y el vehículo está en la etapa ${d.etapa_orden}` : "";
  if (d.tipo === "dias") {
    return `Entra cuando han pasado de ${d.dias_desde} a ${(d.dias_hasta ?? 0) - 1} días desde ${fecha}${etapa}. Se recalcula todos los días.`;
  }
  const cuando = d.meses_atras === 0 ? "del mes actual" : d.meses_atras === 1 ? "del mes pasado" : `de hace ${d.meses_atras} meses`;
  return `Entra todo lo que tenga ${fecha} ${cuando} (sin importar el día)${etapa}. Se envía el día ${d.dia_envio} a las ${d.hora_envio}.`;
}
