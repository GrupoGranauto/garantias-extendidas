# Verificación antes de enviar mensajes de verdad

Cuatro comprobaciones repetibles. Ninguna manda nada a WhatsApp.

| Qué | Comando | Qué comprueba |
|---|---|---|
| Reglas puras | `npm test` | Reglas de campañas, seguimientos, condiciones, piloto, rampa, errores de Meta, botones del webhook, filtros, contrato y datos para emitir (177 pruebas). No toca la base |
| Motor de envíos | `npm run verificar:motor --workspace backend` | El camino completo contra un **Meta simulado**: planificador (fuente BigQuery y web), simulación, envío real, seguimientos (tarea, llamada y otro WhatsApp), rechazo definitivo, error pasajero con reintentos, sin respuesta de Meta, caída a medias, piloto por agencia, rampa del tope diario, baja y vehículo excluido |
| Webhook de WhatsApp | `npm run verificar:webhook --workspace backend` (con el backend local corriendo) | Mensajes entrantes **firmados**: botón «Quiero informes», botón «Baja», texto «STOP», mensaje interactivo, firma inválida y estados de entrega |
| Reglas del contrato | `npm run verificar:contrato --workspace backend` | Tareas por tiempo en el estado del contrato (orden de pago, certificado), oportunidad perdida sin tareas, cambio de estado antes de tiempo, idempotencia, regla apagada, cambio de espera y cobertura automática a los 36 meses (27 comprobaciones) |

Corre **una a la vez** y no sobre una operación en vivo. `verificar:motor` y `verificar:webhook` usan la base de producción y se niegan a correr si ya hay envíos, pasos de campaña o campañas encendidas: sirven **antes** de salir a producción (paso 4 del checklist), no después. El backend local que pide `verificar:webhook` no necesita el motor (en local no arranca salvo con `CRM_MOTOR=on`). `verificar:contrato` enciende las reglas del contrato unos segundos y las deja como estaban (apagadas) al terminar; como el motor del servidor comparte la base, sus comprobaciones cuentan el resultado final en la base y no lo que devuelve cada llamada.

## Cómo se protege la prueba del motor
- Instala un Meta simulado **antes** de cargar el código y se hace una llamada de autoprueba; si no intercepta, aborta sin tocar nada.
- Se niega a correr si la base ya tiene envíos, pasos de campaña, seguimientos o campañas encendidas (por eso no puede correr sobre una operación en vivo).
- Todo lo que crea (envíos, tareas, conversaciones, mensajes, bajas, ligas de variables) lo borra o restaura al terminar, y verifica que la base quedó igual.
- La prueba del webhook tiene la misma protección (base limpia) y al terminar borra solo los envíos que ella creó.
- Nunca corras `verificar:motor` con `CRM_ENVIOS=on` en Railway: la prueba pone una campaña en modo real unos segundos y el servidor podría tomar sus envíos y mandarlos con el Meta de verdad.

## Reglas de envío que comprueban estas pruebas
- Un mensaje real se envía **a lo sumo una vez**: antes de hablar con Meta se deja una marca durable «enviando»; si el proceso se cae a medias, o Meta aceptó pero no se pudo anotar «enviado», ese envío se da por fallido y no se reenvía. Guardar la campaña o cambiar la fuente no borra un envío marcado «enviando», y un paso (o seguimiento) que ya actuó con clientes no se puede borrar.
- Al pasar una campaña de simulación a real se descarta lo simulado de esa campaña, para que esos leads reciban el mensaje real.
- Si Meta rechaza (número sin WhatsApp, plantilla inexistente, límite de marketing, parámetros), no se reintenta. Si no responde, tampoco (no se sabe si salió). Solo se reintenta (hasta 3 veces, cada 15 min) lo pasajero: límites de velocidad, errores 5xx o no poder ni conectar.
- Si a una plantilla le falta un dato (por ejemplo, un vehículo sin agencia), no sale a medias: queda omitida como «Falta un dato para el mensaje», y la **simulación ya lo muestra**.
- Un vehículo que ya no puede contratar (fuera de los meses o el kilometraje de las etapas) no recibe mensajes ni seguimientos, con cualquier fuente de campañas.

## Antes de encender de verdad (lo que no puede probar un script)
1. App Secret de Meta capturado (el webhook ignora lo que no venga firmado).
2. Plantillas aprobadas por Meta y con sus variables ligadas (Plantillas → Variables). La plantilla de prueba actual tiene una variable ligada a una columna que no existe; con ella el sistema omite todo («Falta un dato para el mensaje»).
3. `CRM_ENVIOS=on` en Railway **con todas las campañas en simulación** (la simulación también la hace el motor de envíos).
4. Campaña en **Simulación** uno o dos días y revisión de la vista previa y del registro.
5. Piloto con una agencia y rampa de tope diario; luego una sola campaña a real; después ampliar.
