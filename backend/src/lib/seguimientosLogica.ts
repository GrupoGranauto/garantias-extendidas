/**
 * Seguimientos después del primer contacto automático de una campaña. Funciones puras, sin base de datos.
 *
 * Un seguimiento se dispara N horas después del primer (o último) mensaje de la campaña y hace una cosa (crear una
 * tarea, agendar una llamada o mandar otro WhatsApp) SOLO si se cumplen todas sus condiciones al momento de ejecutarse.
 * Las condiciones leen cualquier columna de la tabla de oportunidades (la etapa del embudo es la «etiqueta» del cliente)
 * y dos datos calculados: si el cliente respondió por WhatsApp y si contestó (llamada o mensaje registrado).
 */

import { ZONA_ENVIOS } from "./campanasLogica.js";

export type TipoCampo = "texto" | "entero" | "fecha" | "fecha_hora" | "booleano";
export type Operador = "igual" | "distinto" | "contiene" | "vacio" | "no_vacio" | "mayor" | "menor";

export type Condicion = { campo: string; operador: Operador; valor: string };

export const OPERADORES_POR_TIPO: Record<TipoCampo, Operador[]> = {
  texto: ["igual", "distinto", "contiene", "vacio", "no_vacio"],
  entero: ["igual", "distinto", "mayor", "menor", "vacio", "no_vacio"],
  fecha: ["igual", "mayor", "menor", "vacio", "no_vacio"],
  fecha_hora: ["igual", "mayor", "menor", "vacio", "no_vacio"],
  booleano: ["igual"],
};

/** Datos que no son una columna de la tabla sino que se calculan al ejecutar el seguimiento. */
export const CAMPOS_CALCULADOS: { nombre: string; etiqueta: string; tipo: TipoCampo }[] = [
  { nombre: "respondio_whatsapp", etiqueta: "El cliente respondió por WhatsApp", tipo: "booleano" },
  { nombre: "contesto", etiqueta: "El cliente contestó (llamada o mensaje registrado)", tipo: "booleano" },
];

const sinOperando = (o: Operador) => o === "vacio" || o === "no_vacio";

const normalizar = (v: unknown): string =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const vacio = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Fecha 'YYYY-MM-DD' en hora de Hermosillo, a partir de una fecha o de un instante ISO. */
export function fechaLocal(valor: unknown): string | null {
  const s = String(valor ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_ENVIOS, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** ¿Se cumple UNA condición para el valor que tiene la oportunidad? */
export function evaluarCondicion(c: Condicion, tipo: TipoCampo, valorFila: unknown): boolean {
  if (c.operador === "vacio") return vacio(valorFila);
  if (c.operador === "no_vacio") return !vacio(valorFila);

  switch (tipo) {
    case "booleano": {
      if (vacio(valorFila)) return false;
      return String(valorFila === true || valorFila === "true") === c.valor;
    }
    case "entero": {
      const n = Number(valorFila);
      const m = Number(c.valor);
      if (vacio(valorFila) || !Number.isFinite(n) || !Number.isFinite(m)) return c.operador === "distinto" && !vacio(c.valor);
      if (c.operador === "igual") return n === m;
      if (c.operador === "distinto") return n !== m;
      if (c.operador === "mayor") return n > m;
      if (c.operador === "menor") return n < m;
      return false;
    }
    case "fecha":
    case "fecha_hora": {
      const f = fechaLocal(valorFila);
      if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(c.valor)) return false;
      if (c.operador === "igual") return f === c.valor;
      if (c.operador === "mayor") return f > c.valor;
      if (c.operador === "menor") return f < c.valor;
      return false;
    }
    default: {
      const a = normalizar(valorFila);
      const b = normalizar(c.valor);
      if (c.operador === "igual") return a === b;
      if (c.operador === "distinto") return a !== b;
      if (c.operador === "contiene") return a.includes(b);
      return false;
    }
  }
}

/**
 * ¿Se cumplen TODAS las condiciones? Sin condiciones, siempre. Un campo que no existe cuenta como no cumplido: es
 * mejor omitir un seguimiento que mandarlo a quien no debía.
 */
export function evaluarCondiciones(
  condiciones: Condicion[],
  fila: Record<string, unknown>,
  tipos: Record<string, TipoCampo>,
): { cumple: boolean; falla: Condicion | null } {
  for (const c of condiciones) {
    const tipo = tipos[c.campo];
    if (!tipo || !(c.campo in fila)) return { cumple: false, falla: c };
    if (!evaluarCondicion(c, tipo, fila[c.campo])) return { cumple: false, falla: c };
  }
  return { cumple: true, falla: null };
}

/** Revisa las condiciones al guardar. Devuelve el texto del error, o null. */
export function validarCondiciones(condiciones: Condicion[], tipos: Record<string, TipoCampo>): string | null {
  if (condiciones.length > 8) return "Máximo 8 condiciones por seguimiento.";
  for (const c of condiciones) {
    const tipo = tipos[c.campo];
    if (!tipo) return `La columna «${c.campo}» no existe.`;
    if (!OPERADORES_POR_TIPO[tipo].includes(c.operador)) return `La condición sobre «${c.campo}» no admite ese operador.`;
    if (sinOperando(c.operador)) continue;
    if (c.valor.trim() === "") return `Falta el valor de la condición sobre «${c.campo}».`;
    if (tipo === "entero" && !Number.isFinite(Number(c.valor))) return `El valor de «${c.campo}» debe ser un número.`;
    if ((tipo === "fecha" || tipo === "fecha_hora") && !/^\d{4}-\d{2}-\d{2}$/.test(c.valor)) return `El valor de «${c.campo}» debe ser una fecha.`;
    if (tipo === "booleano" && c.valor !== "true" && c.valor !== "false") return `El valor de «${c.campo}» debe ser Sí o No.`;
  }
  return null;
}

export type SeguimientoEntrada = {
  nombre: string;
  desde: "primer_envio" | "ultimo_envio";
  espera_horas: number;
  accion: "tarea" | "llamada" | "whatsapp";
  condiciones: Condicion[];
  titulo: string | null;
  descripcion: string | null;
  vence_horas: number | null;
  hora: string | null;
  plantilla_id: string | null;
  vigencia_horas: number;
  activa: boolean;
};

/** Revisa un seguimiento completo. Devuelve el texto del error, o null. */
export function validarSeguimiento(s: SeguimientoEntrada, tipos: Record<string, TipoCampo>): string | null {
  const nombre = s.nombre.trim();
  if (!nombre) return "Cada seguimiento necesita un nombre.";
  if (!Number.isInteger(s.espera_horas) || s.espera_horas < 0 || s.espera_horas > 8760) return `«${nombre}»: la espera debe estar entre 0 y 8,760 horas (un año).`;
  if (s.accion === "tarea" || s.accion === "llamada") {
    if (!s.titulo || s.titulo.trim() === "") return `«${nombre}»: escribe el título de la ${s.accion === "llamada" ? "llamada" : "tarea"}.`;
    if (s.hora !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.hora)) return `«${nombre}»: la hora no es válida (HH:MM).`;
    if (s.accion === "llamada" && s.vence_horas === null) return `«${nombre}»: indica para cuándo se agenda la llamada.`;
  } else if (s.activa && !s.plantilla_id) {
    return `«${nombre}»: elige la plantilla del WhatsApp para poder activarlo.`;
  }
  return validarCondiciones(s.condiciones, tipos);
}

/**
 * Para cuándo queda una tarea o llamada: `venceHoras` después de ahora y, si se pidió una hora, a esa hora (de Hermosillo)
 * del día resultante; si esa hora ya pasó, al día siguiente. Sin `venceHoras` no tiene fecha.
 */
export function calcularVencimiento(ahora: Date, venceHoras: number | null, hora: string | null): Date | null {
  if (venceHoras === null) return null;
  const base = new Date(ahora.getTime() + venceHoras * 3_600_000);
  if (!hora) return base;
  const fecha = fechaLocal(base.toISOString())!;
  let resultado = new Date(`${fecha}T${hora}:00-07:00`); // Hermosillo no cambia de horario: siempre -07:00
  if (resultado.getTime() <= ahora.getTime()) resultado = new Date(resultado.getTime() + 86_400_000);
  return resultado;
}

/** Reemplaza {cliente}, {vin}, {campana}, {agencia} y {ejecutivo} por los datos de la oportunidad. */
export function rellenarTexto(texto: string, datos: Record<string, unknown>): string {
  return texto.replace(/\{(cliente|vin|campana|agencia|ejecutivo)\}/g, (_m, k: string) => String(datos[k] ?? ""));
}
