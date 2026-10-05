import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { getPool } from "../lib/db.js";
import { requireAuth, requireAccesoSucursal } from "../middleware/auth.js";
import {
  listarRegistros,
  contarRegistros,
  valoresDistintosFiltrados,
  construirValoresEdicion,
  actualizarRegistro,
  leerColumnaDeFila,
  type CampoEntidad,
  type FiltroColumna,
  type OpcionesListado,
} from "../lib/entidades.js";
import { OPERADORES_FECHA, filtroDeItem, filtrosDeBotones, leerPanelGuardado } from "../lib/panel.js";
import { esEntidadCrm } from "../lib/entidades.js";
import { ejecutivoRestringido, exigirUuid } from "../lib/permisos.js";
import { conOpcionesDinamicas, editarOportunidad, listarEtapas, moverOportunidad, opcionesDinamicas } from "../lib/crm.js";
import { emitirBroadcast } from "../lib/realtime.js";

/**
 * Filtros de la tabla, serializados como JSON en el query string:
 * [{c, v?, i?, n?, k?, d?, h?, r?}] = columna, valores, incluir vacío, solo vacío,
 * contiene, desde, hasta, fecha relativa.
 */
const filtrosSchema = z
  .array(
    z.object({
      c: z.string().min(1).max(80),
      v: z.array(z.string().max(200)).max(50).optional(),
      i: z.boolean().optional(),
      n: z.boolean().optional(),
      k: z.string().max(200).optional(),
      d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      h: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      r: z.enum(OPERADORES_FECHA).optional(),
    }),
  )
  .max(30);

function leerFiltros(crudo: unknown): FiltroColumna[] | { error: string } {
  if (typeof crudo !== "string" || crudo === "") return [];
  try {
    const parsed = filtrosSchema.safeParse(JSON.parse(crudo));
    if (!parsed.success) return { error: "Filtros inválidos." };
    return parsed.data.map((f) => ({
      columna: f.c,
      valores: f.v,
      incluirVacio: f.i,
      vacio: f.n,
      contiene: f.k,
      desde: f.d,
      hasta: f.h,
      relativo: f.r,
    }));
  } catch {
    return { error: "Filtros inválidos." };
  }
}

/** Textos de búsqueda: `q` puede repetirse (una caja de búsqueda por parámetro); todos deben cumplirse. */
function leerBusquedas(crudo: unknown): string[] {
  const lista = Array.isArray(crudo) ? crudo : typeof crudo === "string" ? [crudo] : [];
  return lista
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim().slice(0, 100))
    .filter((q) => q !== "")
    .slice(0, 10);
}

/** Ids de los botones rápidos activos, separados por coma. */
function leerBotones(crudo: unknown): string[] {
  if (typeof crudo !== "string" || crudo === "") return [];
  return crudo
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "" && id.length <= 64)
    .slice(0, 40);
}

/** Filtros que manda el usuario + los de sus botones rápidos activos (resueltos con el panel guardado). */
function filtrosCompletos(contexto: Contexto, filtros: FiltroColumna[], botones: string[]): FiltroColumna[] {
  if (botones.length === 0) return filtros;
  const panel = leerPanelGuardado(contexto.definicion.panel);
  return [...filtros, ...filtrosDeBotones(botones, panel, contexto.campos)];
}

/** Restricción por ejecutivo: un asesor con ejecutivo asignado solo ve los leads de su ejecutivo; admin, todos. */
function restriccionDe(
  perfil: { rol: string; ejecutivo_asignado: string | null } | undefined,
  columnaEjecutivo: unknown,
): { columna: string; valor: string } | undefined {
  const restringido = ejecutivoRestringido(perfil);
  return restringido && columnaEjecutivo ? { columna: columnaEjecutivo as string, valor: restringido } : undefined;
}

export const entidadDatosRouter = Router();

entidadDatosRouter.use(requireAuth);
exigirUuid(entidadDatosRouter, "rowId");
// Cuelga de /sucursales/:id/entidad/registros: aquí ya hay req.params.id.
entidadDatosRouter.use("/sucursales/:id/entidad/registros", requireAccesoSucursal);

const LIMITE_MAXIMO = 200;

type Contexto = {
  sucursal: { id: string; subdominio: string; zona_horaria: string };
  definicion: { id: string; nombre_tecnico: string; nombre_visible: string; columna_ejecutivo: string | null; panel: unknown };
  /** Solo las columnas visibles: el portal no ve, filtra ni enumera las ocultas. */
  campos: CampoEntidad[];
};

/** Sucursal + entidad + columnas visibles. Los textos distinguen "no existe la sucursal" de "aún sin tabla". */
async function cargarContexto(sucursalId: string): Promise<Contexto | "sin_sucursal" | "sin_entidad"> {
  const supabase = getSupabase();

  const { data: sucursal, error: errorSucursal } = await supabase
    .from("sucursales")
    .select("subdominio, zona_horaria")
    .eq("id", sucursalId)
    .maybeSingle();
  if (errorSucursal) throw new Error(errorSucursal.message);
  if (!sucursal) return "sin_sucursal";

  const { data: definicion, error: errorDefinicion } = await supabase
    .from("entidad_definiciones")
    .select("id, nombre_tecnico, nombre_visible, columna_ejecutivo, panel")
    .eq("sucursal_id", sucursalId)
    .maybeSingle();
  if (errorDefinicion) throw new Error(errorDefinicion.message);
  if (!definicion) return "sin_entidad";

  const { data: camposFilas, error: errorCampos } = await supabase
    .from("entidad_campos")
    .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen, posicion, visible, editor_tipo, opciones")
    .eq("entidad_id", definicion.id)
    .order("posicion");
  if (errorCampos) throw new Error(errorCampos.message);

  let campos = ((camposFilas ?? []) as CampoEntidad[]).filter((c) => c.visible !== false);
  if (esEntidadCrm(definicion.nombre_tecnico as string)) {
    campos = conOpcionesDinamicas(campos, await opcionesDinamicas(sucursalId));
  }

  return {
    sucursal: { id: sucursalId, subdominio: sucursal.subdominio as string, zona_horaria: sucursal.zona_horaria as string },
    definicion: definicion as Contexto["definicion"],
    campos,
  };
}

type ResultadoKpi = { id: string; valor: number | null; error?: string };

/**
 * Valor de cada KPI del panel. Cuentan DENTRO de los filtros activos (igual que
 * la tabla): un KPI sin columna es el total filtrado; uno con condición cuenta
 * las filas filtradas que además la cumplen. Si su columna ya no está disponible
 * (se renombró u ocultó) no se inventa un número: queda sin valor y con el motivo.
 */
async function calcularKpis(
  contexto: Contexto,
  opciones: OpcionesListado,
  totalFiltrado: number,
): Promise<ResultadoKpi[]> {
  const kpis = leerPanelGuardado(contexto.definicion.panel).filter((i) => i.tipo === "kpi");
  const porNombre = new Map(contexto.campos.map((c) => [c.nombre_tecnico, c]));

  return Promise.all(
    kpis.map(async (item): Promise<ResultadoKpi> => {
      if (!item.columna) return { id: item.id, valor: totalFiltrado };

      const campo = porNombre.get(item.columna);
      const extra = campo ? filtroDeItem(item, campo) : null;
      if (!extra) return { id: item.id, valor: null, error: "Columna no disponible" };

      const cuenta = await contarRegistros(contexto.sucursal.subdominio, contexto.definicion.nombre_tecnico, contexto.campos, opciones, extra);
      return "error" in cuenta ? { id: item.id, valor: null, error: cuenta.error } : { id: item.id, valor: cuenta.total };
    }),
  );
}

/**
 * Lectura de los datos de la entidad de la sucursal, para su propio portal.
 * A diferencia de /admin/sucursales/:id/entidad (solo administrador de
 * plataforma, define la estructura), esto lo puede ver cualquiera de la
 * sucursal — es su información, no la de otra.
 */
entidadDatosRouter.get("/sucursales/:id/entidad/registros", async (req, res, next) => {
  try {
    const contexto = await cargarContexto(req.params.id);
    if (contexto === "sin_sucursal") {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }
    if (contexto === "sin_entidad") {
      res.json({ configurado: false });
      return;
    }
    const { sucursal, definicion, campos } = contexto;

    const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), LIMITE_MAXIMO);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const desplazamiento = (pagina - 1) * limite;

    const filtros = leerFiltros(req.query.filtros);
    if ("error" in filtros) {
      res.status(400).json({ error: filtros.error });
      return;
    }

    const dir = req.query.dir === "desc" ? "desc" : "asc";
    const columnaOrden = typeof req.query.orden === "string" && req.query.orden ? req.query.orden : null;

    const opciones: OpcionesListado = {
      sucursalId: sucursal.id,
      restriccion: restriccionDe(req.perfil, definicion.columna_ejecutivo),
      filtros: filtrosCompletos(contexto, filtros, leerBotones(req.query.botones)),
      busquedas: leerBusquedas(req.query.q),
      orden: columnaOrden ? { columna: columnaOrden, dir } : undefined,
      zona: sucursal.zona_horaria,
    };

    const resultado = await listarRegistros(sucursal.subdominio, definicion.nombre_tecnico, campos, limite, desplazamiento, opciones);
    if ("error" in resultado) {
      res.status(400).json({ error: resultado.error });
      return;
    }

    const kpis = await calcularKpis(contexto, opciones, resultado.total);

    res.json({
      configurado: true,
      nombre_visible: definicion.nombre_visible,
      embudo: esEntidadCrm(definicion.nombre_tecnico),
      campos,
      filas: resultado.filas,
      total: resultado.total,
      kpis,
      pagina,
      limite,
    });
  } catch (err) {
    next(err);
  }
});

/** Columnas que puede mostrar una tarjeta del embudo; solo salen las que la sucursal deja visibles. */
const COLUMNAS_TARJETA = [
  "cliente",
  "telefono_principal",
  "linea",
  "anio_vin",
  "campana",
  "fase_campana",
  "ejecutivo",
  "estado_contacto",
  "intentos",
  "fecha_ultimo_contacto",
  "entro_a_etapa_en",
  "motivo_perdida",
];
const TARJETAS_POR_ETAPA = 30;

/**
 * Vista de embudo: las etapas con su total y sus primeras tarjetas, dentro de los
 * mismos filtros, búsqueda y restricción por ejecutivo que la tabla. Con `etapa`
 * (y `desplazamiento`) devuelve solo más tarjetas de esa columna.
 */
entidadDatosRouter.get("/sucursales/:id/entidad/registros/embudo", async (req, res, next) => {
  try {
    const contexto = await cargarContexto(req.params.id);
    if (typeof contexto === "string" || !esEntidadCrm(contexto.definicion.nombre_tecnico)) {
      res.json({ configurado: false });
      return;
    }
    const { sucursal, definicion, campos } = contexto;

    const filtros = leerFiltros(req.query.filtros);
    if ("error" in filtros) {
      res.status(400).json({ error: filtros.error });
      return;
    }
    const base: OpcionesListado = {
      sucursalId: sucursal.id,
      restriccion: restriccionDe(req.perfil, definicion.columna_ejecutivo),
      filtros: filtrosCompletos(contexto, filtros, leerBotones(req.query.botones)),
      busquedas: leerBusquedas(req.query.q),
      zona: sucursal.zona_horaria,
      porPosicion: true,
      // La tarjeta muestra pocas columnas, pero los filtros (como «Activa», que es de «Estado fuente») y la búsqueda son los de la tabla.
      camposFiltro: campos,
    };

    const visibles = new Set(campos.map((c) => c.nombre_tecnico));
    const camposTarjeta = campos.filter((c) => COLUMNAS_TARJETA.includes(c.nombre_tecnico) && visibles.has(c.nombre_tecnico));
    const limite = Math.min(Math.max(Number(req.query.limite) || TARJETAS_POR_ETAPA, 1), 500);
    const desplazamiento = Math.max(Number(req.query.desplazamiento) || 0, 0);
    const soloEtapa = typeof req.query.etapa === "string" ? req.query.etapa : null;

    const etapas = await listarEtapas(sucursal.id);
    const aCargar = soloEtapa ? etapas.filter((e) => e.id === soloEtapa) : etapas;

    const columnas = await Promise.all(
      aCargar.map(async (etapa) => {
        const opciones = { ...base, etapaId: etapa.id };
        const r = await listarRegistros(sucursal.subdominio, definicion.nombre_tecnico, camposTarjeta, limite, soloEtapa ? desplazamiento : 0, opciones);
        if ("error" in r) throw new Error(r.error);
        let fueraSla = 0;
        if (etapa.tipo === "abierta" && etapa.tiempo_max_horas) {
          const c = await contarRegistros(sucursal.subdominio, definicion.nombre_tecnico, campos, { ...opciones, enEtapaMasDeHoras: etapa.tiempo_max_horas });
          fueraSla = "error" in c ? 0 : c.total;
        }
        return { ...etapa, total: r.total, tarjetas: r.filas, fuera_sla: fueraSla };
      }),
    );

    // Cuántas tareas pendientes (y vencidas) tiene cada tarjeta: una sola consulta para todas.
    const idsTarjetas = columnas.flatMap((c) => c.tarjetas.map((t) => t.id as string));
    if (idsTarjetas.length > 0) {
      const { rows: tareas } = await getPool().query(
        `SELECT oportunidad_id, count(*)::int AS pendientes, count(*) FILTER (WHERE vence_en < now())::int AS vencidas
           FROM crm_tareas WHERE sucursal_id = $1 AND estado = 'pendiente' AND oportunidad_id = ANY($2::uuid[]) GROUP BY 1`,
        [sucursal.id, idsTarjetas],
      );
      const porOp = new Map(tareas.map((t) => [t.oportunidad_id as string, t]));
      for (const c of columnas) {
        for (const t of c.tarjetas) {
          const x = porOp.get(t.id as string);
          t.tareas_pendientes = x?.pendientes ?? 0;
          t.tareas_vencidas = x?.vencidas ?? 0;
        }
      }
    }

    const motivos = (await opcionesDinamicas(sucursal.id)).motivo_perdida.map((o) => o.valor);
    res.json({ configurado: true, campos: camposTarjeta, etapas: columnas, motivos, limite });
  } catch (err) {
    next(err);
  }
});

/** Configuración del panel de filtrado (elementos y su orden), para dibujarlo en el portal. */
entidadDatosRouter.get("/sucursales/:id/entidad/registros/panel", async (req, res, next) => {
  try {
    const contexto = await cargarContexto(req.params.id);
    if (typeof contexto === "string") {
      res.json({ items: [] });
      return;
    }
    res.json({ items: leerPanelGuardado(contexto.definicion.panel) });
  } catch (err) {
    next(err);
  }
});

/**
 * Valores distintos de una columna visible, para los desplegables de filtro. Salen
 * de lo que dejan pasar los OTROS filtros activos (no el de la propia columna), y
 * respetan la restricción por ejecutivo: un asesor solo ve valores de sus leads.
 */
entidadDatosRouter.get("/sucursales/:id/entidad/registros/valores", async (req, res, next) => {
  try {
    const columna = typeof req.query.columna === "string" ? req.query.columna : "";
    const contexto = await cargarContexto(req.params.id);
    if (typeof contexto === "string") {
      res.json({ valores: [] });
      return;
    }
    const { sucursal, definicion, campos } = contexto;

    const filtros = leerFiltros(req.query.filtros);
    if ("error" in filtros) {
      res.status(400).json({ error: filtros.error });
      return;
    }

    const valores = await valoresDistintosFiltrados(sucursal.subdominio, definicion.nombre_tecnico, campos, columna, {
      sucursalId: sucursal.id,
      restriccion: restriccionDe(req.perfil, definicion.columna_ejecutivo),
      filtros: filtrosCompletos(contexto, filtros, leerBotones(req.query.botones)),
      busquedas: leerBusquedas(req.query.q),
      zona: sucursal.zona_horaria,
    });
    if ("error" in valores) {
      res.status(400).json({ error: "Columna no disponible." });
      return;
    }
    res.json({ valores });
  } catch (err) {
    next(err);
  }
});

/**
 * Edita una fila: solo los campos 'back' (los que captura la app). Un asesor con
 * ejecutivo asignado solo puede editar filas de su ejecutivo; el admin, todas.
 */
entidadDatosRouter.patch("/sucursales/:id/entidad/registros/:rowId", async (req, res, next) => {
  try {
    const supabase = getSupabase();

    const { data: sucursal, error: errorSucursal } = await supabase
      .from("sucursales")
      .select("subdominio")
      .eq("id", req.params.id)
      .maybeSingle();
    if (errorSucursal) throw new Error(errorSucursal.message);
    if (!sucursal) {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }

    const { data: definicion, error: errorDef } = await supabase
      .from("entidad_definiciones")
      .select("id, nombre_tecnico, columna_ejecutivo")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (errorDef) throw new Error(errorDef.message);
    if (!definicion) {
      res.status(404).json({ error: "Esta sucursal no tiene una entidad definida." });
      return;
    }

    const { data: camposFilas, error: errorCampos } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen, editor_tipo, opciones")
      .eq("entidad_id", definicion.id);
    if (errorCampos) throw new Error(errorCampos.message);
    const esCrm = esEntidadCrm(definicion.nombre_tecnico as string);
    const todos = (camposFilas ?? []) as CampoEntidad[];
    const campos = esCrm ? conOpcionesDinamicas(todos, await opcionesDinamicas(req.params.id)) : todos;

    const resultado = construirValoresEdicion(campos, (req.body ?? {}) as Record<string, unknown>);
    if ("error" in resultado) {
      res.status(400).json({ error: resultado.error });
      return;
    }

    // Permiso por ejecutivo: el asesor solo edita filas de su ejecutivo.
    if (
      req.perfil &&
      req.perfil.rol !== "admin" &&
      req.perfil.ejecutivo_asignado &&
      definicion.columna_ejecutivo
    ) {
      const dueño = await leerColumnaDeFila(
        sucursal.subdominio,
        definicion.nombre_tecnico,
        req.params.rowId,
        definicion.columna_ejecutivo as string,
        req.params.id,
      );
      if (dueño === undefined) {
        res.status(404).json({ error: "Registro no encontrado." });
        return;
      }
      if (dueño !== req.perfil.ejecutivo_asignado) {
        res.status(403).json({ error: "No puedes editar un registro de otro ejecutivo." });
        return;
      }
    }

    if (esCrm) {
      const edicion = await editarOportunidad({
        sucursalId: req.params.id,
        oportunidadId: req.params.rowId,
        valores: resultado.valores,
        usuarioId: req.usuario?.id,
      });
      if (!edicion.ok) {
        res.status(edicion.estado).json({ error: edicion.error });
        return;
      }
    } else {
      const ok = await actualizarRegistro(
        sucursal.subdominio,
        definicion.nombre_tecnico,
        req.params.rowId,
        resultado.valores,
      );
      if (!ok) {
        res.status(404).json({ error: "Registro no encontrado." });
        return;
      }
    }

    // Avisar en vivo a quien tenga la tabla abierta (Supabase Realtime).
    emitirBroadcast(`datos:${req.params.id}`, "refresh", { rowId: req.params.rowId });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const moverSchema = z.object({
  etapa_id: z.string().uuid(),
  antes_id: z.string().uuid().nullable().optional(),
  motivo_perdida: z.string().trim().min(1).max(80).nullable().optional(),
});

/**
 * Mueve una tarjeta del embudo (de etapa o de lugar). Misma regla de permiso que
 * editar: un asesor con ejecutivo asignado solo mueve las de su ejecutivo.
 */
entidadDatosRouter.post("/sucursales/:id/entidad/registros/:rowId/mover", async (req, res, next) => {
  const parsed = moverSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos." });
    return;
  }
  try {
    const { data: definicion, error } = await getSupabase()
      .from("entidad_definiciones")
      .select("nombre_tecnico, columna_ejecutivo")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!definicion || !esEntidadCrm(definicion.nombre_tecnico as string)) {
      res.status(404).json({ error: "Esta sucursal no tiene embudo." });
      return;
    }

    if (req.perfil && req.perfil.rol !== "admin" && req.perfil.ejecutivo_asignado && definicion.columna_ejecutivo) {
      const dueño = await leerColumnaDeFila(
        "",
        definicion.nombre_tecnico as string,
        req.params.rowId,
        definicion.columna_ejecutivo as string,
        req.params.id,
      );
      if (dueño === undefined) {
        res.status(404).json({ error: "Registro no encontrado." });
        return;
      }
      if (dueño !== req.perfil.ejecutivo_asignado) {
        res.status(403).json({ error: "No puedes mover un registro de otro ejecutivo." });
        return;
      }
    }

    const resultado = await moverOportunidad({
      sucursalId: req.params.id,
      oportunidadId: req.params.rowId,
      etapaId: parsed.data.etapa_id,
      antesId: parsed.data.antes_id ?? null,
      motivoPerdida: parsed.data.motivo_perdida ?? null,
      usuarioId: req.usuario?.id,
    });
    if (!resultado.ok) {
      res.status(resultado.estado).json({ error: resultado.error });
      return;
    }

    emitirBroadcast(`datos:${req.params.id}`, "refresh", { rowId: req.params.rowId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
