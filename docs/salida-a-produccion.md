# Salida a producción: checklist (Fase E)

Orden pensado para que **nunca** se mande un mensaje real sin haberlo visto antes en simulación, y para poder apagar todo en un minuto.
Marca cada paso al terminarlo. No saltes pasos: los marcados «Bloquea» impiden el siguiente.

## Estado de partida (2026-10-05)

| Pieza | Hoy |
|---|---|
| Código (fases A, B1, C, D y verificaciones) | Desplegado en Railway |
| Correcciones E0 (envío a lo sumo una vez, simulación que no consume leads, seguridad) | **En local, sin desplegar**. Se despliegan antes del paso 4 (ver «Paso 3.5») |
| WhatsApp de la sucursal | Configurado y activo (token, número, secreto de firma y token de verificación del webhook guardados) |
| Plantillas | Solo `Prueba Garantias` (aprobada), con su variable ligada a una columna que no existe: **no sirve para campañas** |
| Campañas 48H, 5M, 12M_NURTURING, 28M | Apagadas, en simulación, sin plantilla, tope 100 por día, ventana lunes a viernes 9:00 a 19:00 |
| Fuente de las campañas | BigQuery (la web calcula en modo sombra a las 6:00 y solo compara) |
| `CRM_ENVIOS` en Railway | **No existe**: ningún envío sale |
| `CRM_SYNC_AUTO` en Railway | **No existe**: la sincronización diaria con BigQuery no corre (última real: 2026-10-02; hay leads nuevos esperando) |
| Reglas del contrato | Apagadas (20 h, 25 h y 24 h). La cobertura automática a los 36 meses está encendida |
| Seguimientos | Apagados |

---

## Paso 0 · Decisiones y confirmaciones (sin tocar nada)

- [ ] **28M:** confirmar con Assurant si la garantía extendida *solo* se puede contratar mientras la original sigue vigente. La plantilla 4 no lo afirma; si se confirma se puede volver urgencia.
- [ ] **CrediNissan:** confirmar si la garantía extendida puede incluirse en el crédito **después** de la venta. Si sí, se agrega una línea a la plantilla 1.
- [ ] **5M:** confirmar que los meses sin intereses del programa «Nissan Nuevos MSI 2026» siguen vigentes en la fecha de envío.
- [ ] **Hora de la llamada de seguimiento** (propuesta: 10:00).
- [ ] **Agencia piloto** para el primer envío real (una sola).

## Paso 1 · Plantillas en Meta (Bloquea)

Textos y datos exactos en [plantillas-campanas.md](plantillas-campanas.md).

- [ ] Crear `ge_48h_bienvenida`, `ge_5m_precio`, `ge_12m_reparaciones` y `ge_28m_vigencia`: categoría **Marketing**, idioma `es_MX`, sin encabezado, variables `{{1}}` (modelo) y `{{2}}` (agencia) con ejemplo, pie «Responde BAJA para no recibir más mensajes», botones de respuesta rápida «Quiero informes» y «Baja».
- [ ] Esperar a que Meta las **apruebe** las cuatro.
- [ ] En Meta, el webhook apunta a `https://<dominio del servicio>/api/webhooks/whatsapp` con el token de verificación guardado en el portal, y está suscrito a **messages** y a **message_template_status_update**. (Sin esto no llegan respuestas, bajas ni estados de entrega.)

## Paso 2 · Plantillas en el portal (Bloquea)

- [ ] Plantillas → **Sincronizar con Meta**: aparecen las cuatro como «aprobada».
- [ ] En cada una, **Variables**: `{{1}}` → Línea y `{{2}}` → Agencia.
- [ ] (Opcional) Dejar de usar `Prueba Garantias`.

## Paso 3 · Sincronización diaria con BigQuery

La sincronización corre sola **entre las 10:00 y las 10:59 (hora de Hermosillo)**, una vez al día. Si se enciende después de esa hora, la primera corrida automática es al día siguiente; mientras tanto se puede correr a mano.

- [ ] Equipo → Sincronización → **Simular** y revisar el resumen (nuevas, actualizadas, migradas, cerradas, conflictos). Deben salir los leads nuevos que esperan.
- [ ] Equipo → **Aplicar** (primera corrida real a mano) y revisar que el resumen coincida con la simulación.
- [ ] Railway → variables del servicio → agregar `CRM_SYNC_AUTO=true` (esto reinicia el servicio).
- [ ] Al día siguiente, después de las 11:00: Equipo muestra «corrió hoy» y no hay alerta de más de 36 h.

## Paso 3.5 · Desplegar las correcciones E0 (Bloquea)

- [ ] En el panel de plataforma → Sucursal → WhatsApp: confirmar que el **App Secret** de Meta está capturado. Desde E0 el webhook **ignora** todo lo que no venga firmado; sin el secreto no entrarían respuestas, bajas ni estados de entrega.
- [ ] En Railway: confirmar `NODE_ENV=production`. Desde E0 el motor solo arranca en el servidor desplegado (o con `CRM_MOTOR=on`).
- [ ] Commit y despliegue de E0; revisar en los logs de Railway la línea `[backend] motor CRM: encendido`.

## Paso 4 · Encender el interruptor y simular (todavía sin enviar)

La simulación también la hace el motor de envíos, así que **necesita `CRM_ENVIOS=on`**. Es seguro siempre que **todas** las campañas estén en modo **simulación**: el modo real se elige campaña por campaña y ninguna lo tiene.

- [ ] Antes de tocar Railway, en Automatizaciones → Campañas de WhatsApp: confirmar que las cuatro campañas dicen **Simulación** (o están apagadas) y que Seguimientos está apagado.
- [ ] Railway → variables del servicio → `CRM_ENVIOS=on` (reinicia el servicio).

Luego, en Automatizaciones → **Campañas de WhatsApp**, por cada campaña:

- [ ] Asignar la **plantilla** al primer mensaje (48H → `ge_48h_bienvenida`, 5M → `ge_5m_precio`, 12M_NURTURING → `ge_12m_reparaciones`, 28M → `ge_28m_vigencia`).
- [ ] Revisar ventana (días y horas), tope diario, días entre mensajes y vigencia (mínimo 1 día).
- [ ] Activar el **piloto**: solo la agencia elegida en el paso 0.
- [ ] Activar la **rampa** del tope diario (propuesta: empezar en 20 y subir 20 por día).
- [ ] Dejarla **activa en modo simulación** durante al menos un día hábil.
- [ ] Revisar el **registro de envíos**: a quién le habría llegado, cuántos quedan omitidos y por qué. «Falta un dato para el mensaje» debe ser raro; si es mucho, hay un dato vacío en la base.
- [ ] En «Activación gradual», todos los puntos **bloqueantes** en verde.

## Paso 5 · Pasar una campaña a real

- [ ] Cambiar **una sola campaña** (la que tenga leads de la agencia piloto) a modo **real**. Las demás siguen en simulación.
  - Al guardar, lo **simulado de esa campaña se descarta** (también sus seguimientos simulados) para que esos leads sí reciban el mensaje real. Si a alguno ya se le pasó la vigencia del paso, queda omitido como «Pasó su vigencia».
  - El primer mensaje real, de preferencia a un teléfono propio de la agencia piloto.
- [ ] Vigilar el primer día, cada hora:
  - Envíos: enviado → entregado → leído; ningún «fallido» inexplicado.
  - Mensajes que llegan: las respuestas aparecen en el chat y en la ficha del lead.
  - Una prueba controlada: tocar «Baja» desde un teléfono propio y confirmar que el contacto queda en baja y no recibe más.
  - Que el tope del día se respete (rampa).
- [ ] Si todo está bien dos o tres días, **ampliar**: más agencias, subir la rampa, y luego encender las otras campañas **una por una**.

## Paso 6 · Seguimientos

- [ ] Automatizaciones → **Seguimientos**: crear los de cada campaña (por ejemplo, llamada si no respondió en 48 h) con su hora de llamada.
- [ ] Encenderlos **después** de que la campaña haya mandado los primeros mensajes reales.
- Un seguimiento solo actúa sobre lo que le tocaba en las últimas 24 h: encenderlo tarde no dispara tareas ni mensajes por todo el historial (lo anterior queda omitido como «atrasado»).
- Un seguimiento que ya actuó con clientes no se puede borrar: se apaga.

## Paso 7 · Pago y cierre

- [ ] Automatizaciones → **Contrato**: revisar espera, título y vencimiento de las tres reglas y **encenderlas** cuando el equipo ya esté registrando contratos en la ficha.
- [ ] Capacitar al equipo en la sección **Datos para emitir** de la ficha (semáforo verde = listo para capturar en el portal de Assurant).
- [ ] Recordar al equipo: la liga de pago de Openpay dura 24 h.

---

## Cómo apagar (en orden, del más fino al más grueso)

| Si quieres detener… | Haz |
|---|---|
| Una campaña | Automatizaciones → Campañas de WhatsApp → apagarla o pasarla a simulación. Sus pendientes no se borran: quedan en espera y, si se vuelve a encender, salen los que sigan dentro de su vigencia |
| Todos los envíos y seguimientos | Railway → quitar `CRM_ENVIOS` (o ponerlo distinto de `on`). Los pendientes se quedan en espera; los seguimientos atrasados más de 24 h ya no corren |
| Todo el motor (automatizaciones, reglas, cálculo de campañas, cobertura) | Railway → `CRM_MOTOR=off` |
| Tareas del contrato | Automatizaciones → Contrato → apagar las reglas |
| La sincronización diaria | Railway → quitar `CRM_SYNC_AUTO` |
| Un contacto | Se da de baja solo si escribe «Baja» o «STOP» (o toca el botón «Baja» de la plantilla): queda en baja para siempre y se cancela lo que tuviera pendiente |

Un envío real se manda **a lo sumo una vez**: si el servidor se cae a medias, o si Meta aceptó el mensaje pero no se pudo anotar, ese envío queda como fallido y no se reenvía. Guardar una campaña o cambiar la fuente no toca un envío que está saliendo, y un mensaje (paso) que ya se mandó a clientes no se puede quitar: se apaga la campaña.

## Antes de cada cambio grande

- `npm test` se puede correr siempre (no toca la base).
- `verificar:motor` y `verificar:webhook` **solo antes del paso 4**: se niegan a correr si ya hay envíos, pasos o campañas encendidas, porque usan la misma base que producción. Después de salir a producción, para cambios del motor bastan `npm test` y revisar la simulación.
- `verificar:contrato` enciende las reglas del contrato unos segundos: no correrla con las reglas ya en uso.

Una a la vez. Detalle en [verificacion-antes-de-enviar.md](verificacion-antes-de-enviar.md).

> Copia local: el backend local trabaja sobre la base de producción. El motor **no** arranca en local (solo con `CRM_MOTOR=on`), y nunca se pone `CRM_ENVIOS=on` en un `.env` local.

## Pendientes conocidos

- No se ha probado con un envío real a Meta (solo contra un Meta simulado) ni con el rol de asesor restringido; el primer envío real debe ser a un teléfono propio.
- «Reasignar cartera» no se ha probado en vivo.
- «Estado de circulación» es texto libre: falta decidir si será una lista (estados de la república o la del portal de Assurant).
- Con una sola sucursal no aplica, pero antes de dar de alta otra: la sincronización lee toda la maestra de BigQuery sin filtrar por distribuidor, y los archivos que mandan los clientes por WhatsApp quedan en un bucket público.
