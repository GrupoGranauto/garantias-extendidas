/*
  Vista previa del ciclo diario de leads contra la maestra (solo lectura: no escribe nada, ni la bitácora).
  Uso:  npm run previsualizar:ciclo --workspace backend [-- <tabla>]
  Sin tabla usa la maestra real (base-maestra-gn.garantias_extendidas.nis_ge_cartera_maestra).
*/
import { previsualizarCiclo } from "../src/lib/sincronizacionCrm.js";
import { getPool } from "../src/lib/db.js";

const SUC = "3393d1c7-ae81-4617-990b-e5bc70fa5ca3";
const tabla = process.argv[2];

try {
  const r = await previsualizarCiclo(SUC, tabla || undefined);
  console.log(JSON.stringify(r, null, 2));
} catch (err) {
  console.error("No se pudo previsualizar:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await getPool().end();
}
