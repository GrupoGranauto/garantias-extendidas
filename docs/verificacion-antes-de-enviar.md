# Verificación antes de enviar mensajes de verdad

Tres comprobaciones repetibles. Ninguna manda nada a WhatsApp.

| Qué | Comando | Qué comprueba |
|---|---|---|
| Reglas puras | `npm test` | Reglas de campañas, seguimientos, condiciones, piloto, rampa, errores de Meta, botones del webhook (144 pruebas) |
| Motor de envíos | `npm run verificar:motor --workspace backend` | El camino completo contra un **Meta simulado**: planificador (fuente BigQuery y web), simulación, envío real, seguimientos (tarea, llamada y otro WhatsApp), rechazo definitivo, error pasajero con reintentos, sin respuesta de Meta, caída a medias, piloto por agencia, rampa del tope diario, baja y vehículo excluido |
| Webhook de WhatsApp | `npm run verificar:webhook --workspace backend` (con el backend local corriendo) | Mensajes entrantes **firmados**: botón «Quiero informes», botón «Baja», texto «STOP», mensaje interactivo, firma inválida y estados de entrega |

## Cómo se protege la prueba del motor
- Instala un Meta simulado **antes** de cargar el código y se hace una llamada de autoprueba; si no intercepta, aborta sin tocar nada.
- Se niega a correr si la base ya tiene envíos, pasos de campaña, seguimientos o campañas encendidas (por eso no puede correr sobre una operación en vivo).
- Todo lo que crea (envíos, tareas, conversaciones, mensajes, bajas, ligas de variables) lo borra o restaura al terminar, y verifica que la base quedó igual.

## Reglas de envío que comprueban estas pruebas
- Un mensaje real se envía **a lo sumo una vez**: antes de hablar con Meta se deja una marca durable «enviando»; si el proceso se cae a medias, ese envío se da por fallido y no se reenvía.
- Si Meta rechaza (número sin WhatsApp, plantilla inexistente, límite de marketing, parámetros), no se reintenta. Si no responde, tampoco (no se sabe si salió). Solo se reintenta (hasta 3 veces, cada 15 min) lo pasajero: límites de velocidad, errores 5xx o no poder ni conectar.
- Si a una plantilla le falta un dato (por ejemplo, un vehículo sin agencia), no sale a medias: queda omitida como «Falta un dato para el mensaje», y la **simulación ya lo muestra**.
- Un vehículo que ya no puede contratar (fuera de los meses o el kilometraje de las etapas) no recibe mensajes ni seguimientos, con cualquier fuente de campañas.

## Antes de encender de verdad (lo que no puede probar un script)
1. `CRM_ENVIOS=on` en Railway.
2. Plantillas aprobadas por Meta y con sus variables ligadas (Plantillas → Variables). La plantilla de prueba actual tiene una variable ligada a una columna que no existe; con ella el sistema omite todo («Falta un dato para el mensaje»).
3. Campaña en **Simulación** uno o dos días y revisión de la vista previa y del registro.
4. Piloto con una agencia y rampa de tope diario; después ampliar.
