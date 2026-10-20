/**
 * El nombre con el que se saluda al cliente («Hola Rafael»), sacado de su nombre completo (decisión de Miguel Borbón,
 * 20-oct-2026). La base de clientes manda el nombre en un solo campo con el formato «Apellido Apellido Nombre(s)» y no manda el
 * nombre de pila por separado; sin él, las plantillas que saludan por nombre omiten a la persona. Función pura.
 *
 * Reglas:
 *  - Los dos primeros bloques son los apellidos y lo que sigue son los nombres. Las partículas se pegan a la palabra que sigue
 *    («De Los Reyes» es un solo apellido; «Del Carmen», parte de un nombre).
 *  - Se saluda con el primer nombre, sin iniciales («J. Natividad» → Natividad). Los que se usan compuestos se dejan
 *    completos: María José, Juan Pablo, José Luis, María del Carmen, Ana Sofía… («Ma.» se lee María).
 *  - Si no se puede saber con confianza (menos de tres bloques, o parece empresa) no se adivina: queda vacío y la plataforma
 *    omite a esa persona en las plantillas que usan el nombre, como hasta hoy.
 *  - Se respeta como viene escrito (no se agregan acentos); solo se ajustan mayúsculas.
 */

/** Palabras que van pegadas a la siguiente: «De La Cruz», «Del Carmen», «Mc Gregor». */
const PARTICULAS = new Set(["de", "del", "la", "las", "los", "y", "mc", "mac", "van", "von", "da", "das", "do", "dos", "di"]);

/** Primeros nombres que casi siempre se usan junto con el segundo. */
const COMPUESTOS = new Set(["maria", "ma", "ma.", "jose", "juan", "ana", "luz"]);

/** Palabras de razón social o de giro: si aparece alguna, es empresa y no se saluda por nombre. */
const DE_EMPRESA = new Set([
  "sa", "s.a", "s.a.", "cv", "c.v", "c.v.", "sapi", "srl", "s.r.l", "sc", "s.c", "spr", "rl", "sab", "ac", "a.c", "a.c.",
  "agricola", "agropecuaria", "agroindustrial", "alimentos", "arquitectura", "asociados", "automotriz", "automotrices",
  "autos", "comercial", "comercializadora", "construccion", "constructora", "consultores", "corporativo", "distribuidora",
  "empresa", "equipo", "express", "farmacia", "ferreteria", "finance", "financiera", "grupo", "hermanos", "hnos", "hospital",
  "industrial", "industrias", "inmobiliaria", "institucionales", "leasing", "licores", "llantas", "logistica",
  "mantenimientos", "materiales", "mexico", "motors", "productos", "renta", "rentas", "seguros", "servicios", "sociedad",
  "soluciones", "taller", "transportes", "vinos", "ganadera", "pesquera", "acuicola", "fletes", "mudanzas", "importadora",
  "exportadora", "abarrotes", "restaurante", "hotel", "clinica", "escuela", "colegio", "universidad", "municipio", "gobierno",
  "arrendadora", "sofom", "banca", "financiero", "asociacion", "mutualista", "refacciones", "especializados", "importaciones",
  "electromecanicos", "muebleria", "networks", "tecnologia", "negocios", "desarrolladores", "desarrolladora", "residencial",
  "integral", "integrales", "superacion", "impulsora", "produce", "agroproductora", "rancho", "factura",
]);

const minus = (p: string) => p.toLocaleLowerCase("es-MX");

/** «MARIA» o «maria» → «Maria»; las partículas dentro de un nombre van en minúscula («Maria del Carmen»). */
function capitalizar(palabra: string, enMedio: boolean): string {
  const p = minus(palabra);
  if (enMedio && PARTICULAS.has(p)) return p;
  return p.charAt(0).toLocaleUpperCase("es-MX") + p.slice(1);
}

/** Inicial suelta o con punto («J.», «J»), que no sirve para saludar. «Ma.» no cuenta: es María. */
const esInicial = (p: string) => /^[a-záéíóúñ]\.?$/i.test(p);

export function nombrePilaDe(nombreCompleto: string | null | undefined): string | null {
  if (!nombreCompleto) return null;
  // Cualquier espacio cuenta, también los especiales (la base trae espacios no separables).
  const palabras = nombreCompleto.split(/[\s  -​  　]+/).filter(Boolean);
  if (palabras.length < 3) return null;
  if (palabras.some((p) => DE_EMPRESA.has(minus(p).replace(/[,;]+$/, "")) || /[&\d@]/.test(p))) return null;

  // Bloques: las partículas se pegan a la palabra que sigue.
  const bloques: string[][] = [];
  let pendiente: string[] = [];
  for (const p of palabras) {
    if (PARTICULAS.has(minus(p))) {
      pendiente.push(p);
      continue;
    }
    bloques.push([...pendiente, p]);
    pendiente = [];
  }
  if (pendiente.length > 0) return null; // termina en partícula: no es un nombre normal
  if (bloques.length < 3) return null;

  const nombres = bloques.slice(2).filter((b) => !(b.length === 1 && esInicial(b[0])));
  if (nombres.length === 0) return null;

  const primero = nombres[0];
  // Un nombre de persona no empieza con «Y», «De»…: si pasa, es una razón social que no se reconoció.
  if (PARTICULAS.has(minus(primero[0]))) return null;
  const base = minus(primero[0]);
  const partes = [...primero];
  // «Ma.» es María; y los nombres que se usan compuestos llevan el siguiente («María José», «María del Carmen»).
  if (base === "ma" || base === "ma.") partes[0] = "Maria";
  if (COMPUESTOS.has(base) && primero.length === 1 && nombres.length > 1) partes.push(...nombres[1]);

  return partes.map((p, i) => capitalizar(p, i > 0)).join(" ");
}
