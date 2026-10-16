/**
 * Reglas puras de «no contactar» (sin base): el motivo que exige quitarlo, qué hace una acción en lote con los leads que
 * están en «Baja» o bloqueados (no contactables, vehículo descartado) y cuándo una edición corrige un bloqueo. La baja solo
 * se quita desde la ficha, con motivo; en lote nunca se reabre a nadie que pidió no ser contactado ni se libera un bloqueo.
 */

/** Mínimo de caracteres del motivo para quitar «no contactar» (la base exige lo mismo al revocar la supresión). */
export const MOTIVO_QUITAR_MIN = 10;
export const MOTIVO_QUITAR_MAX = 500;

/** Valida el motivo para quitar «no contactar»: devuelve el texto limpio o el error en español. */
export function validarMotivoQuitar(motivo: unknown): { ok: true; motivo: string } | { ok: false; error: string } {
  const limpio = typeof motivo === "string" ? motivo.trim() : "";
  if (!limpio) return { ok: false, error: "Escribe por qué se quita «no contactar»." };
  // Se cuentan caracteres, no unidades de JavaScript: la base cuenta igual (un emoji es uno, no dos).
  const largo = [...limpio].length;
  if (largo < MOTIVO_QUITAR_MIN) return { ok: false, error: `El motivo debe tener al menos ${MOTIVO_QUITAR_MIN} caracteres.` };
  if (largo > MOTIVO_QUITAR_MAX) return { ok: false, error: `El motivo puede tener hasta ${MOTIVO_QUITAR_MAX} caracteres.` };
  return { ok: true, motivo: limpio };
}

export type AccionLote = "etapa" | "ejecutivo" | "tarea";

/**
 * Si una acción en lote deja fuera a un lead en «Baja». Reasignarlo no lo toca; crearle una tarea, sí (la baja descarta
 * sus pendientes: nadie debe buscarlo). Cambiarlo de estado solo se permite para cerrarlo como perdido: reabrirlo o
 * marcarlo como venta en lote, no.
 */
export function bajaQuedaFuera(accion: AccionLote, tipoDestino?: string): boolean {
  if (accion === "ejecutivo") return false;
  if (accion === "tarea") return true;
  return tipoDestino !== "perdida";
}

/** Aviso honesto de cuántos leads en «Baja» se dejaron fuera de la acción en lote, y por qué. Sin ninguno, null. */
export function avisoBajaEnLote(accion: AccionLote, n: number): string | null {
  if (n <= 0 || accion === "ejecutivo") return null;
  const razon = "en «Baja» (la persona pidió no ser contactada)";
  if (accion === "tarea") {
    return n === 1 ? `1 no recibió la tarea: está ${razon}.` : `${n} no recibieron la tarea: están ${razon}.`;
  }
  return n === 1
    ? `1 no se movió: está ${razon}. En lote solo se puede cerrar como perdido.`
    : `${n} no se movieron: están ${razon}. En lote solo se pueden cerrar como perdidos.`;
}

/**
 * Aviso de cuántos leads se quedaron sin la tarea en lote porque no se les puede contactar: no contactables o con una
 * supresión vigente (número equivocado, vehículo descartado o baja de su teléfono). Sin ninguno, null.
 */
export function avisoBloqueadasEnLote(n: number): string | null {
  if (n <= 0) return null;
  const razones = "número equivocado, vehículo descartado o teléfono dado de baja";
  return n === 1
    ? `1 no recibió la tarea: no se le puede contactar (no contactable, ${razones}).`
    : `${n} no recibieron la tarea: no se les puede contactar (no contactables, ${razones}).`;
}

/** Motivos de pérdida que descartan el vehículo (D1): la base los guarda como supresión de su VIN. */
export const DESCARTES_VEHICULO: ReadonlySet<string> = new Set(["ya_no_tiene_auto", "flotilla", "uso_no_elegible", "fuera_km_tiempo"]);

/**
 * Si un cambio de estado en lote deja fuera a un lead bloqueado (no contactable, o con el vehículo descartado): cuando lo
 * reabre o lo marca como venta, o cuando le cambia o le quita el motivo de pérdida que ya tiene. En lote sí se puede cerrar
 * como perdido sin tocar su motivo. Corregirlo (lo único que libera el bloqueo) se hace en su ficha, uno por uno.
 * Los motivos llegan como vienen de la base (id o clave), null si no tiene o no tendrá.
 */
export function bloqueoQuedaFuera(tipoDestino: string, motivoActual: string | null, motivoNuevo: string | null): boolean {
  if (tipoDestino !== "perdida") return true;
  return motivoActual !== null && motivoActual !== motivoNuevo;
}

/** Aviso de cuántos leads bloqueados se dejaron fuera del cambio de estado en lote, y qué hacer. Sin ninguno, null. */
export function avisoBloqueadasEtapaEnLote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "1 no se movió: es no contactable (número equivocado) o tiene el vehículo descartado. En lote solo se puede cerrar como perdido sin cambiarle el motivo; si fue un error de captura, corrígelo en su ficha."
    : `${n} no se movieron: son no contactables (número equivocado) o tienen el vehículo descartado. En lote solo se pueden cerrar como perdidos sin cambiarles el motivo; si fue un error de captura, corrige cada uno en su ficha.`;
}

/**
 * Si la edición que una persona hace sobre UN lead corrige un bloqueo capturado por error, y por eso se declara en su
 * transacción (la base solo libera un número equivocado o un descarte del vehículo con esa marca):
 * - lo saca de «No contactable» (a mano, con el resultado BDC, o porque contestó o escribió el titular);
 * - le quita o le cambia un motivo de descarte del vehículo (con el estado del lead, el motivo o el resultado BDC).
 * Pasarlo a «Baja» no corrige nada. Los motivos van por clave; null = sin motivo.
 */
export function corrigeBloqueo(p: {
  contactoAntes: string | null;
  contactoDespues: string | null;
  motivoAntes: string | null;
  motivoDespues: string | null;
}): boolean {
  const saleDeNoContactable =
    p.contactoAntes === "no_contactable" && p.contactoDespues !== null && p.contactoDespues !== "no_contactable" && p.contactoDespues !== "baja";
  const quitaDescarte = p.motivoAntes !== null && DESCARTES_VEHICULO.has(p.motivoAntes) && p.motivoDespues !== p.motivoAntes;
  return saleDeNoContactable || quitaDescarte;
}

/** Lo que dice si a un lead se le puede buscar: claves de la base, tal como vienen. */
export type ContactoDelLead = {
  /** Estado de contacto del lead (clave: 'baja', 'no_contactable', …). */
  estadoContacto: string | null;
  /** La persona (su contacto) está dada de baja. */
  noContactar: boolean;
  /** Motivo de la supresión vigente que alcanza al lead por su VIN o su teléfono, o null. */
  supresion: string | null;
};

/**
 * Por qué no se le crea una tarea automática a un lead, con las claves del freno de envíos: «baja» (el lead, la persona o
 * su teléfono), «supresion_…» (número equivocado o descarte del vehículo) o «no_contactable». null = sí se le crea.
 */
export function motivoSinTarea(l: ContactoDelLead): string | null {
  if (l.estadoContacto === "baja" || l.noContactar || l.supresion === "baja") return "baja";
  if (l.supresion) return `supresion_${l.supresion}`;
  if (l.estadoContacto === "no_contactable") return "no_contactable";
  return null;
}
