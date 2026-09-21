import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { env, flags } from "./config/env.js";
import { healthRouter } from "./routes/health.js";
import { garantiasRouter } from "./routes/garantias.js";
import { adminRouter } from "./routes/admin.js";
import { adminWhatsappRouter } from "./routes/adminWhatsapp.js";
import { adminEntidadesRouter } from "./routes/adminEntidades.js";
import { entidadesIngestaRouter } from "./routes/entidadesIngesta.js";
import { publicoRouter } from "./routes/publico.js";
import { perfilRouter } from "./routes/perfil.js";
import { webhookWhatsappRouter } from "./routes/webhookWhatsapp.js";
import { origenPermitido } from "./lib/origenes.js";

const app = express();

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

app.use(express.json({ limit: "5mb" }));

app.use("/api/health", healthRouter);
app.use("/api/publico", publicoRouter);
app.use("/api/perfil", perfilRouter);
app.use("/api/garantias", garantiasRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin", adminWhatsappRouter);
app.use("/api/admin", adminEntidadesRouter);
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

app.listen(env.PORT, () => {
  console.log(`[backend] http://localhost:${env.PORT}  (${env.NODE_ENV})`);
  console.log(`[backend] sitio: ${fs.existsSync(sitio) ? sitio : "no compilado (modo desarrollo)"}`);
  console.log(`[backend] supabase: ${flags.supabase ? "ok" : "sin configurar"} | bigquery: ${flags.bigquery ? "ok" : "sin configurar"}`);
});
