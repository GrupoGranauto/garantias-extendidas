import { Router } from "express";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { generarApiKey, descifrarApiKey } from "../lib/apiKeyEntidad.js";
import {
  crearEsquemaYTabla,
  eliminarTabla,
  esEntidadCrm,
  evolucionarTabla,
  validarCampos,
  listarValoresDistintos,
  type CampoEntidad,
} from "../lib/entidades.js";
import { aNombreTecnico, identificadorValido } from "../lib/identificadores.js";
import { panelSchema, validarPanel, leerPanelGuardado, type ItemPanel } from "../lib/panel.js";
import { emitirBroadcast } from "../lib/realtime.js";

export const adminEntidadesRouter = Router();

adminEntidadesRouter.use(requireAuth, requireAdmin);

const campoSchema = z.object({
  nombre_tecnico: z.string().trim().min(1),
  nombre_visible: z.string().trim().min(1),
  tipo: z.enum(["texto", "entero", "decimal", "booleano", "fecha", "fecha_hora", "uuid"]),
  longitud: z.number().int().positive().nullable().default(null),
  requerido: z.boolean().default(false),
  origen: z.enum(["api", "back"]).default("api"),
  visible: z.boolean().default(true),
});

const definicionSchema = z.object({
  nombre_visible: z.string().trim().min(1),
  nombre_tecnico: z.string().trim().min(1).optional(), // solo se usa al crear
  columna_ejecutivo: z.string().trim().nullable().default(null),
  campos: z.array(campoSchema),
});

async function obtenerSucursal(id: string) {
  const { data, error } = await getSupabase()
    .from("sucursales")
    .select("id, subdominio")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function obtenerODarDeAltaApiKey(sucursalId: string): Promise<string> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("entidad_api_keys")
    .select("key_cifrado")
    .eq("sucursal_id", sucursalId)
    .maybeSingle();

  if (data) return descifrarApiKey(data.key_cifrado);

  const material = generarApiKey();
  const { error } = await supabase
    .from("entidad_api_keys")
    .insert({ sucursal_id: sucursalId, key_hash: material.hash, key_cifrado: material.cifrado });
  if (error) throw new Error(error.message);

  return material.texto;
}

/** Definición de la entidad de la sucursal, sus campos y su API key de ingesta. */
adminEntidadesRouter.get("/sucursales/:id/entidad", async (req, res, next) => {
  try {
    const sucursal = await obtenerSucursal(req.params.id);
    if (!sucursal) {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }

    const supabase = getSupabase();
    const { data: definicion, error } = await supabase
      .from("entidad_definiciones")
      .select("id, nombre_tecnico, nombre_visible, columna_ejecutivo, creado_en")
      .eq("sucursal_id", sucursal.id)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const apiKey = await obtenerODarDeAltaApiKey(sucursal.id);

    if (!definicion) {
      res.json({ configurado: false, api_key: apiKey });
      return;
    }

    const { data: campos, error: errorCampos } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen, posicion, visible")
      .eq("entidad_id", definicion.id)
      .order("posicion");
    if (errorCampos) throw new Error(errorCampos.message);

    res.json({
      configurado: true,
      nombre_tecnico: definicion.nombre_tecnico,
      nombre_visible: definicion.nombre_visible,
      columna_ejecutivo: definicion.columna_ejecutivo,
      creado_en: definicion.creado_en,
      campos: campos ?? [],
      api_key: apiKey,
    });
  } catch (err) {
    next(err);
  }
});

/** Valores distintos de la columna de Ejecutivo: para asignar un ejecutivo a un usuario. */
adminEntidadesRouter.get("/sucursales/:id/entidad/ejecutivos", async (req, res, next) => {
  try {
    const sucursal = await obtenerSucursal(req.params.id);
    if (!sucursal) {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }

    const { data: definicion, error } = await getSupabase()
      .from("entidad_definiciones")
      .select("nombre_tecnico, columna_ejecutivo")
      .eq("sucursal_id", sucursal.id)
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (!definicion || !definicion.columna_ejecutivo) {
      res.json({ configurado: false, ejecutivos: [] });
      return;
    }

    const ejecutivos = await listarValoresDistintos(
      sucursal.subdominio,
      definicion.nombre_tecnico,
      definicion.columna_ejecutivo,
      undefined,
      200,
      sucursal.id,
    );
    res.json({ configurado: true, ejecutivos });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   Campos editables: configura cómo se edita cada campo 'back' en
   la tabla del portal (texto libre o lista de opciones con color).
   Las fechas siempre usan calendario, no se configuran aquí.
   ============================================================ */
const opcionSchema = z.object({
  valor: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color hexadecimal de 6 dígitos."),
});
const campoEditableSchema = z.object({
  nombre_tecnico: z.string().trim().min(1),
  editor_tipo: z.enum(["texto", "lista"]),
  opciones: z.array(opcionSchema).default([]),
});
const camposEditablesSchema = z.object({ campos: z.array(campoEditableSchema) });
const COLUMNAS_LISTA_CRM = new Set(["etapa_embudo", "estado_contacto", "motivo_perdida", "ejecutivo"]);

/** Config actual de los campos 'back' (los que captura la app, no el sync). */
adminEntidadesRouter.get("/sucursales/:id/entidad/campos-editables", async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { data: definicion, error } = await supabase
      .from("entidad_definiciones")
      .select("id, nombre_tecnico")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!definicion) {
      res.json({ configurado: false, campos: [] });
      return;
    }
    const esCrm = esEntidadCrm(definicion.nombre_tecnico);

    const { data: campos, error: errorCampos } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, editor_tipo, opciones")
      .eq("entidad_id", definicion.id)
      .eq("origen", "back")
      .order("posicion");
    if (errorCampos) throw new Error(errorCampos.message);

    // En el CRM las listas de etapa, estado de contacto, motivo y ejecutivo salen de sus tablas: no se configuran aquí.
    const propias = (campos ?? []).filter((c) => !COLUMNAS_LISTA_CRM.has(c.nombre_tecnico) || !esCrm);
    res.json({ configurado: true, campos: propias });
  } catch (err) {
    next(err);
  }
});

/** Guarda el editor (texto/lista + opciones) de los campos 'back'. */
adminEntidadesRouter.put("/sucursales/:id/entidad/campos-editables", async (req, res, next) => {
  const parsed = camposEditablesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const supabase = getSupabase();
    const { data: definicion, error } = await supabase
      .from("entidad_definiciones")
      .select("id")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!definicion) {
      res.status(404).json({ error: "Esta sucursal aún no tiene una entidad definida." });
      return;
    }

    const { data: existentes, error: errorEx } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, tipo, origen")
      .eq("entidad_id", definicion.id);
    if (errorEx) throw new Error(errorEx.message);
    const porNombre = new Map((existentes ?? []).map((c) => [c.nombre_tecnico, c]));

    for (const campo of parsed.data.campos) {
      const actual = porNombre.get(campo.nombre_tecnico);
      if (!actual || actual.origen !== "back") {
        res.status(400).json({ error: `'${campo.nombre_tecnico}' no es un campo editable de la app.` });
        return;
      }
      if (campo.editor_tipo === "lista" && actual.tipo !== "texto") {
        res.status(400).json({ error: `'${campo.nombre_tecnico}' no es de texto: no puede ser lista.` });
        return;
      }
      const opciones = campo.editor_tipo === "lista" ? campo.opciones : [];
      const { error: errorUpd } = await supabase
        .from("entidad_campos")
        .update({ editor_tipo: campo.editor_tipo, opciones })
        .eq("entidad_id", definicion.id)
        .eq("nombre_tecnico", campo.nombre_tecnico);
      if (errorUpd) throw new Error(errorUpd.message);
    }

    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
   Panel de filtrado de la tabla: búsquedas, desplegables, KPIs y
   botones rápidos que el admin arma por sucursal.
   ============================================================ */

/** Panel guardado + columnas visibles (lo único que se puede usar en un elemento). */
adminEntidadesRouter.get("/sucursales/:id/entidad/panel", async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { data: definicion, error } = await supabase
      .from("entidad_definiciones")
      .select("id, panel")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!definicion) {
      res.json({ configurado: false, items: [], campos: [] });
      return;
    }

    const { data: campos, error: errorCampos } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, visible")
      .eq("entidad_id", definicion.id)
      .order("posicion");
    if (errorCampos) throw new Error(errorCampos.message);

    res.json({
      configurado: true,
      items: leerPanelGuardado(definicion.panel),
      campos: (campos ?? []).filter((c) => c.visible !== false),
    });
  } catch (err) {
    next(err);
  }
});

/** Guarda el panel completo (el arreglo define también el orden). */
adminEntidadesRouter.put("/sucursales/:id/entidad/panel", async (req, res, next) => {
  const parsed = panelSchema.safeParse(req.body);
  if (!parsed.success) {
    const primero = parsed.error.issues[0];
    res.status(400).json({ error: primero?.message ?? "Datos inválidos.", detalle: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const supabase = getSupabase();
    const { data: definicion, error } = await supabase
      .from("entidad_definiciones")
      .select("id")
      .eq("sucursal_id", req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!definicion) {
      res.status(404).json({ error: "Esta sucursal aún no tiene una entidad definida." });
      return;
    }

    const { data: campos, error: errorCampos } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen, visible")
      .eq("entidad_id", definicion.id);
    if (errorCampos) throw new Error(errorCampos.message);

    const visibles = ((campos ?? []) as CampoEntidad[]).filter((c) => c.visible !== false);
    const errorPanel = validarPanel(parsed.data.items as ItemPanel[], visibles);
    if (errorPanel) {
      res.status(400).json({ error: errorPanel });
      return;
    }

    const { error: errorGuardar } = await supabase
      .from("entidad_definiciones")
      .update({ panel: parsed.data.items, actualizado_en: new Date().toISOString() })
      .eq("id", definicion.id);
    if (errorGuardar) throw new Error(errorGuardar.message);

    // Quien tenga la tabla abierta recarga el panel sin refrescar la página.
    emitirBroadcast(`datos:${req.params.id}`, "panel", {});

    res.json({ guardado: true });
  } catch (err) {
    next(err);
  }
});

/** Crea la entidad (primera vez) o evoluciona su esquema (agrega/ajusta campos). */
adminEntidadesRouter.put("/sucursales/:id/entidad", async (req, res, next) => {
  const parsed = definicionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos.", detalle: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const sucursal = await obtenerSucursal(req.params.id);
    if (!sucursal) {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }

    const campos: CampoEntidad[] = parsed.data.campos;
    const errorCampos = validarCampos(campos);
    if (errorCampos) {
      res.status(400).json({ error: errorCampos });
      return;
    }

    const supabase = getSupabase();
    const { data: existente, error: errorExistente } = await supabase
      .from("entidad_definiciones")
      .select("id, nombre_tecnico")
      .eq("sucursal_id", sucursal.id)
      .maybeSingle();
    if (errorExistente) throw new Error(errorExistente.message);

    if (existente && esEntidadCrm(existente.nombre_tecnico)) {
      res.status(409).json({ error: "Esta sucursal usa el modelo relacional del CRM: sus columnas no se editan desde aquí." });
      return;
    }

    if (!existente) {
      // ---------- Crear ----------
      const nombreTecnico = aNombreTecnico(parsed.data.nombre_tecnico || parsed.data.nombre_visible);
      if (!identificadorValido(nombreTecnico)) {
        res.status(400).json({ error: "El nombre técnico debe iniciar con letra y usar solo minúsculas, números y guiones bajos." });
        return;
      }

      await crearEsquemaYTabla(sucursal.subdominio, nombreTecnico, campos);

      const { data: definicion, error: errorInsert } = await supabase
        .from("entidad_definiciones")
        .insert({
          sucursal_id: sucursal.id,
          nombre_tecnico: nombreTecnico,
          nombre_visible: parsed.data.nombre_visible,
          columna_ejecutivo: parsed.data.columna_ejecutivo,
        })
        .select("id")
        .single();

      if (errorInsert) {
        // La tabla ya se creó: no dejarla huérfana si el metadato no se pudo guardar.
        await eliminarTabla(sucursal.subdominio, nombreTecnico).catch(() => {});
        throw new Error(errorInsert.message);
      }

      const filasCampos = campos.map((campo, indice) => ({ ...campo, entidad_id: definicion.id, posicion: indice }));
      const { error: errorCamposInsert } = await supabase.from("entidad_campos").insert(filasCampos);
      if (errorCamposInsert) throw new Error(errorCamposInsert.message);

      res.status(201).json({ creado: true, nombre_tecnico: nombreTecnico });
      return;
    }

    // ---------- Editar (el nombre técnico de la entidad no cambia) ----------
    const { data: camposActualesFilas, error: errorActuales } = await supabase
      .from("entidad_campos")
      .select("nombre_tecnico, nombre_visible, tipo, longitud, requerido, origen")
      .eq("entidad_id", existente.id);
    if (errorActuales) throw new Error(errorActuales.message);

    await evolucionarTabla(sucursal.subdominio, existente.nombre_tecnico, camposActualesFilas ?? [], campos);

    const { error: errorUpdate } = await supabase
      .from("entidad_definiciones")
      .update({
        nombre_visible: parsed.data.nombre_visible,
        columna_ejecutivo: parsed.data.columna_ejecutivo,
        actualizado_en: new Date().toISOString(),
      })
      .eq("id", existente.id);
    if (errorUpdate) throw new Error(errorUpdate.message);

    // Metadatos de campos: se reemplazan por completo con la lista deseada.
    // La columna física nunca se borra (ver evolucionarTabla), así que si un
    // campo se vuelve a agregar después no se pierde su dato ya guardado.
    await supabase.from("entidad_campos").delete().eq("entidad_id", existente.id);
    const filasCampos = campos.map((campo, indice) => ({ ...campo, entidad_id: existente.id, posicion: indice }));
    const { error: errorCamposInsert } = await supabase.from("entidad_campos").insert(filasCampos);
    if (errorCamposInsert) throw new Error(errorCamposInsert.message);

    res.json({ guardado: true, nombre_tecnico: existente.nombre_tecnico });
  } catch (err) {
    next(err);
  }
});

/** Elimina la entidad por completo: metadatos y su tabla real. */
adminEntidadesRouter.delete("/sucursales/:id/entidad", async (req, res, next) => {
  try {
    const sucursal = await obtenerSucursal(req.params.id);
    if (!sucursal) {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }

    const supabase = getSupabase();
    const { data: definicion, error } = await supabase
      .from("entidad_definiciones")
      .select("id, nombre_tecnico")
      .eq("sucursal_id", sucursal.id)
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (!definicion) {
      res.json({ eliminado: true });
      return;
    }

    if (esEntidadCrm(definicion.nombre_tecnico)) {
      res.status(409).json({ error: "La entidad del CRM no se elimina desde aquí: sus datos son relacionales." });
      return;
    }

    await eliminarTabla(sucursal.subdominio, definicion.nombre_tecnico);

    const { error: errorDelete } = await supabase.from("entidad_definiciones").delete().eq("id", definicion.id);
    if (errorDelete) throw new Error(errorDelete.message);

    res.json({ eliminado: true });
  } catch (err) {
    next(err);
  }
});

/** Regenera la API key de ingesta: la anterior deja de funcionar de inmediato. */
adminEntidadesRouter.post("/sucursales/:id/entidad/api-key/regenerar", async (req, res, next) => {
  try {
    const sucursal = await obtenerSucursal(req.params.id);
    if (!sucursal) {
      res.status(404).json({ error: "Sucursal no encontrada." });
      return;
    }

    const material = generarApiKey();
    const supabase = getSupabase();

    const { data: existente } = await supabase
      .from("entidad_api_keys")
      .select("id")
      .eq("sucursal_id", sucursal.id)
      .maybeSingle();

    const cambios = { key_hash: material.hash, key_cifrado: material.cifrado, rotado_en: new Date().toISOString() };
    const { error } = existente
      ? await supabase.from("entidad_api_keys").update(cambios).eq("id", existente.id)
      : await supabase.from("entidad_api_keys").insert({ sucursal_id: sucursal.id, ...cambios });
    if (error) throw new Error(error.message);

    res.json({ api_key: material.texto });
  } catch (err) {
    next(err);
  }
});
