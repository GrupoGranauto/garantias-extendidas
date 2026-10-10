import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env, flags } from "./config/env.js";
import { healthRouter } from "./routes/health.js";
import { garantiasRouter } from "./routes/garantias.js";
import { adminRouter } from "./routes/admin.js";
import { adminWhatsappRouter } from "./routes/adminWhatsapp.js";
import { adminPlantillasRouter } from "./routes/adminPlantillas.js";
import { adminEntidadesRouter } from "./routes/adminEntidades.js";
import { adminCrmRouter } from "./routes/adminCrm.js";
import { crmPortalRouter } from "./routes/crmPortal.js";
import { crmProcesoRouter } from "./routes/crmProceso.js";
import { crmCicloRouter } from "./routes/crmCiclo.js";
import { crmCampanasDefRouter } from "./routes/crmCampanasDef.js";
import { crmReglasContratoRouter } from "./routes/crmReglasContrato.js";
import { iniciarMotorCrm } from "./lib/motorCrm.js";
import { iniciarSyncProgramadoCrm } from "./lib/sincronizacionCrm.js";
import { entidadDatosRouter } from "./routes/entidadDatos.js";
import { whatsappChatRouter } from "./routes/whatsappChat.js";
import { entidadesIngestaRouter } from "./routes/entidadesIngesta.js";
import { publicoRouter } from "./routes/publico.js";
import { perfilRouter } from "./routes/perfil.js";
import { webhookWhatsappRouter } from "./routes/webhookWhatsapp.js";
import { cloudtalkRouter } from "./routes/cloudtalk.js";
import { origenPermitido } from "./lib/origenes.js";

const app = express();

// Railway pone un proxy delante: sin esto todas las peticiones parecerían venir de la misma IP.
app.set("trust proxy", 1);

// Cabeceras de seguridad (nosniff, HSTS, referrer…). CSP y las políticas de origen cruzado quedan fuera:
// romperían el inicio de sesión con Google y los recursos de Supabase.
app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));

const limite = (maximo: number, ventanaMs: number, mensaje: string) =>
  rateLimit({
    windowMs: ventanaMs,
    limit: maximo,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: mensaje });
    },
  });

app.use(
  cors({
    origin(origen, callback) {
      // Sin origen: curl, health checks, peticiones servidor a servidor
      if (!origen || origenPermitido(origen)) return callback(null, true);
      callback(new Error(`Origen no permitido: ${origen}`));
    },
    credentials: true,
  }),
);
// El webhook de WhatsApp necesita el cuerpo crudo (Buffer) para validar la
// firma HMAC contra el app_secret; por eso va antes de express.json() y con
// su propio parser. El resto de la API sí usa JSON ya parseado.
app.use("/api/webhooks/whatsapp", express.raw({ type: "application/json" }), webhookWhatsappRouter);

// 20mb: alcanza para el base64 de video/documento de muestra en plantillas de WhatsApp.
app.use(express.json({ limit: "20mb" }));

// Límites por IP. El de la API es holgado (una oficina entera comparte IP); el de sincronización, estricto.
app.use("/api", limite(1200, 60_000, "Demasiadas peticiones. Espera un momento."));
const limiteSync = limite(10, 60 * 60_000, "Ya se pidieron varias sincronizaciones en la última hora.");
app.post("/api/admin/sucursales/:id/crm/sincronizacion", limiteSync);
app.post("/api/admin/sucursales/:id/crm/sincronizar", limiteSync);

app.use("/api/health", healthRouter);
app.use("/api/publico", publicoRouter);
app.use("/api/perfil", perfilRouter);
app.use("/api/garantias", garantiasRouter);
// Routers accesibles para cualquier usuario de la sucursal (asesor incluido):
// van ANTES de adminRouter porque este aplica requireAdmin a todo /api/admin,
// y si entrara primero bloquearía a los asesores en el chat y la base de datos.
// Cada uno protege sus rutas con requireAccesoSucursal.
app.use("/api/admin", entidadDatosRouter);
app.use("/api/admin", whatsappChatRouter);
app.use("/api/admin", crmPortalRouter);
app.use("/api/admin", crmProcesoRouter);
app.use("/api/admin", crmCicloRouter);
app.use("/api/admin", crmCampanasDefRouter);
app.use("/api/admin", crmReglasContratoRouter);
app.use("/api/admin", cloudtalkRouter);
// Routers solo-admin (adminRouter gatea con requireAdmin todo lo que le llegue).
app.use("/api/admin", adminRouter);
app.use("/api/admin", adminWhatsappRouter);
app.use("/api/admin", adminPlantillasRouter);
app.use("/api/admin", adminEntidadesRouter);
app.use("/api/admin", adminCrmRouter);
// Ingesta externa: autenticada por API key propia de la sucursal, no por sesión.
app.use("/api/entidades", entidadesIngestaRouter);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

/* ------------------------------------------------------------
   En produccion este mismo servicio sirve el frontend compilado.
   Asi un solo dominio comodin cubre portal y API, y no hay CORS
   entre ellos porque comparten origen.
   ------------------------------------------------------------ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sitio = path.resolve(__dirname, "../../frontend/dist");

if (fs.existsSync(sitio)) {
  // Los archivos con hash en el nombre pueden cachearse para siempre
  app.use(
    express.static(sitio, {
      index: false,
      setHeaders(res, ruta) {
        if (ruta.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // Cualquier otra ruta la resuelve el enrutador del navegador
  app.get("*", (_req, res) => {
    res.sendFile(path.join(sitio, "index.html"));
  });
} else {
  app.use((_req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
  });
}

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  },
);

// El motor (automatizaciones, reglas, cálculo de campañas, cobertura) trabaja sobre la base, y la base es la MISMA para
// desarrollo y producción: corre solo en el servidor desplegado. En una copia local se enciende a propósito con CRM_MOTOR=on.
const motorEncendido =
  process.env.CRM_MOTOR === "on" ||
  (process.env.CRM_MOTOR !== "off" && (env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT_ID)));

app.listen(env.PORT, () => {
  if (flags.supabase && motorEncendido) iniciarMotorCrm();
  if (flags.supabase && flags.bigquery && process.env.CRM_SYNC_AUTO === "true") iniciarSyncProgramadoCrm();
  console.log(`[backend] http://localhost:${env.PORT}  (${env.NODE_ENV})`);
  console.log(`[backend] sitio: ${fs.existsSync(sitio) ? sitio : "no compilado (modo desarrollo)"}`);
  console.log(`[backend] supabase: ${flags.supabase ? "ok" : "sin configurar"} | bigquery: ${flags.bigquery ? "ok" : "sin configurar"}`);
  console.log(`[backend] motor CRM: ${flags.supabase && motorEncendido ? "encendido" : "apagado (en local se enciende con CRM_MOTOR=on)"}`);
});
