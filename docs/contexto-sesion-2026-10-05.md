# Contexto de la sesión: CRM Garantías Extendidas (2026-10-05)

Resumen para retomar el trabajo en otra conversación. No contiene contraseñas ni llaves.

## 1. El proyecto

CRM en español para Grupo GranAuto (sucursal `3393d1c7-ae81-4617-990b-e5bc70fa5ca3`) que gestiona la venta de **Garantía Extendida Nissan**.

| Pieza | Detalle |
|---|---|
| Backend | Express + TypeScript (`backend/`) |
| Frontend | React + Vite (`frontend/`) |
| Base de datos | Supabase, proyecto `qpdxtfdwvyntkjvkipki`. **La comparten el desarrollo local y producción** |
| Despliegue | Railway (proyecto `2bca3be7-ec44-4f4a-9c09-6c9025460447`, servicio `eb806577-b914-41de-9a57-e5b1c82e6b2b`). Despliega solo al hacer push a `main` de `MiguelBorbon61908/garantias-extendidas` |
| Fuente de datos | BigQuery `base-maestra-gn.garantias_extendidas.nis_ge_cartera_maestra` |
| Reglas de negocio | Notion y los documentos GEXT (garantía original 36 meses, hasta 59,000 km, planes de 48/60/72 meses, liga de pago Openpay de 24 h) |

Reglas de trabajo con el usuario:
- Hablar **solo en español**.
- **No hacer commit ni push** sin que lo pida ("commitea y despliega").
- Sin emojis en la interfaz: solo iconos SVG.
- No pedir consentimiento de WhatsApp: el usuario lo descartó. Solo se respeta la baja («Baja»/STOP).
- Las pruebas `verificar:*` usan la base de producción: correrlas **una a la vez** y nunca con campañas en modo real.

## 2. Qué se construyó (todo desplegado)

Último commit en `main`: `3afb383`. Despliegue en Railway: SUCCESS.

| Fase | Contenido | Commit |
|---|---|---|
| 1 a 5 | Etapas del vehículo y km; campañas definidas por el usuario y calculadas a diario (modo sombra vs BigQuery); envíos con las campañas de la web; seguimientos; reportes y activación gradual (piloto por agencia, rampa del tope diario) | hasta `a898301` |
| A | Etapas con exclusión: un vehículo fuera de meses o km no entra a campañas ni recibe envíos | `a898301` |
| B1 | Textos de las 4 plantillas (48H, 5M, 12M_NURTURING, 28M) en `docs/plantillas-campanas.md` | `a898301` |
| Verificación | Envío "a lo sumo una vez", errores de Meta clasificados, variables vacías omitidas, webhook con botones de plantilla, scripts `verificar:*` | `a898301` |
| C | Reglas del contrato (tareas por tiempo en orden de pago y certificado entregado) y cobertura automática a fecha de factura + 36 meses. Migración 0020 | `6179b8b` |
| Hotfix | El Embudo respondía 500 con el filtro "Activa" por defecto desde la migración 0014 (error mío). Ya corregido y con prueba de regresión | `6179b8b` |
| D | Sección "Datos para emitir" en la Ficha (número y valor de factura, número de motor, estado de circulación, dirección) con semáforo verde/ámbar/rojo. Migración 0021 | `7a8c952` |
| Pruebas | `verificar:contrato` ahora restaura las reglas y resiste al motor en paralelo; guía actualizada | `3afb383` |

Migraciones 0014 a 0021 aplicadas en la base compartida.

## 3. Estado actual

- **Pruebas:** 177 unitarias pasan. `verificar:motor` 30/30, `verificar:webhook` 14/14, `verificar:contrato` 27/27.
- **Envíos:** no sale ningún mensaje real. `CRM_ENVIOS` no existe en Railway.
- **Sincronización diaria con BigQuery:** no corre (`CRM_SYNC_AUTO` no existe en Railway). Última sincronización real: 2026-10-02. Hay leads nuevos esperando. Cuando se prenda, corre sola solo entre las 10:00 y las 10:59 (hora de Hermosillo).
- **Campañas 48H, 5M, 12M_NURTURING y 28M:** apagadas, en simulación, sin plantilla; tope 100 por día; lunes a viernes de 9:00 a 19:00; la fuente es BigQuery.
- **Reglas del contrato:** apagadas (espera 20 h, 25 h y 24 h). La cobertura automática está encendida, pero no hay contratos.
- **Seguimientos:** apagados.
- **WhatsApp:** configurado y activo. La única plantilla es `Prueba Garantias`, con su variable ligada a una columna que no existe: no sirve para campañas.
- **Roster de ejecutivos:** María José Nuñez y Fernando Zazueta.

## 4. Incidentes de la sesión (para no repetirlos)

1. **Embudo 500 en producción** (filtro "Activa"): los filtros se validaban solo contra las columnas de la tarjeta. Arreglado con `camposFiltro` en `entidades.ts`.
2. **Roster vacío:** una prueba negativa mía lo dejó vacío y bloqueó la sincronización. Se restauró y ahora el servidor rechaza un roster vacío.
3. **`verificar:motor` abortado por "statement timeout"** (conexión inestable al pooler local). Se restauró a mano. Lección: correr los scripts uno por uno, sin encadenarlos con builds largos.
4. **Reglas del contrato encendidas por error:** `verificar:contrato` las dejaba encendidas y una con espera de 40 h. Se apagaron con un `UPDATE` autorizado por el usuario y se corrigió el script.
5. Se mató sin querer el backend local al detener un script colgado; se reinició.

## 5. Pendiente

**Fase E, salida a producción.** Checklist completo en [salida-a-produccion.md](salida-a-produccion.md). Resumen del orden:
1. Crear y aprobar las 4 plantillas en Meta (textos en `plantillas-campanas.md`).
2. Sincronizar plantillas en el portal y ligar `{{1}}` → Línea y `{{2}}` → Agencia.
3. Sincronización diaria: simular, aplicar a mano y luego `CRM_SYNC_AUTO=true`.
4. Asignar plantilla, piloto (una agencia) y rampa a cada campaña; dejarlas un día hábil en simulación y revisar el registro.
5. `CRM_ENVIOS=on` y una sola campaña en modo real; el primer envío a un teléfono propio.
6. Seguimientos y reglas del contrato, al final.

**Decisiones abiertas del usuario:**
- Agencia piloto para el primer envío real.
- Hora de la llamada de seguimiento (propuesta: 10:00).
- Confirmar con Assurant si la garantía extendida solo se puede contratar con la original vigente (afecta la plantilla 28M).
- Confirmar con CrediNissan si la garantía extendida entra al crédito después de la venta.
- "Estado de circulación": ¿texto libre (hoy) o lista (estados de la república o la del portal de Assurant)?

**No probado en vivo:** envío real a Meta, rol de asesor restringido, "Reasignar cartera".

**Sin commit al cierre de este documento:** `docs/salida-a-produccion.md` y este archivo.

## 6. Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Checklist de salida | `docs/salida-a-produccion.md` |
| Guía de verificación | `docs/verificacion-antes-de-enviar.md` |
| Textos de plantillas | `docs/plantillas-campanas.md` |
| Motor de campañas y envíos | `backend/src/lib/campanasEnvio.ts`, `campanasLogica.ts`, `motorCrm.ts` |
| Seguimientos | `backend/src/lib/seguimientos.ts`, `seguimientosLogica.ts` |
| Reglas del contrato | `backend/src/lib/reglasContrato.ts`, `contratoLogica.ts` |
| Datos para emitir | `backend/src/lib/datosEmision.ts`, `datosEmisionLogica.ts`; interfaz en `frontend/src/portal/FichaOportunidad.tsx` |
| Webhook de WhatsApp | `backend/src/routes/webhookWhatsapp.ts` |
| Scripts de verificación | `backend/scripts/verificar-motor.ts`, `verificar-webhook.ts`, `verificar-contrato.ts` |
| Migraciones | `db/migrations/0014` a `0021` |
