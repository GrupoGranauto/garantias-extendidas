# Plantillas de WhatsApp para las campañas de Garantía Extendida

Textos listos para crear en Meta (WhatsApp Manager → Plantillas de mensajes). Salen del material de Garantía Extendida Nissan
(díptico, manteleta, infografía). No incluyen precios ni nada del documento marcado «Assurant, confidencial».

## Cómo crearlas en Meta (valen para las cuatro)

| Campo | Valor |
|---|---|
| Categoría | **Marketing** (no «Utilidad»: son mensajes de venta; Meta reclasifica o rechaza lo que viene mal categorizado) |
| Idioma | Español (México), `es_MX` |
| Encabezado | Ninguno (el sistema solo envía plantillas con encabezado de texto o sin encabezado) |
| Variables | `{{1}}` = modelo del vehículo, `{{2}}` = agencia. Meta pide un **texto de ejemplo** para cada una: `{{1}}` Versa, `{{2}}` Navojoa |
| Pie de página | `Responde BAJA para no recibir más mensajes` |
| Botones (respuesta rápida) | `Quiero informes` y `Baja` |

- **Por qué no se usa el nombre del cliente:** en la base viene como «Apellido Apellido Nombre» (por ejemplo «Lopez Ramirez Juan Carlos»), con casos
  de un solo apellido con punto («Lopez . Pedro») o razones sociales. Saludar con ese dato quedaría mal.
- **El botón «Baja»** manda ese texto al responder, y el sistema lo entiende como una baja: el contacto queda en baja para siempre y se
  cancela lo que tuviera pendiente. **Requiere desplegar el ajuste del webhook** hecho con estas plantillas: antes, un botón de plantilla se
  guardaba como JSON crudo y no se detectaba la baja.
- **Quien toca «Quiero informes»** cuenta como que respondió: pasa a «Contactado», no recibe la llamada de seguimiento y el chat
  queda sin leer para el ejecutivo.
- Después de que Meta las apruebe: Plantillas → **Sincronizar con Meta**, y en cada una **Variables**: `{{1}}` → Línea, `{{2}}` → Agencia.

---

## 1. `ge_48h_bienvenida` (campaña 48H)

> Hola, te saludamos de {{2}}. Gracias por elegir tu {{1}}.
>
> Con la Garantía Extendida Nissan puedes proteger los principales componentes mecánicos y eléctricos de tu auto hasta por 6 años o 125,000 km, con asistencia vial las 24 horas y sin límite de kilometraje durante la extensión. Es un producto de contratación opcional.
>
> Si quieres que un asesor te explique cómo contratarla, toca el botón.

## 2. `ge_5m_precio` (campaña 5M)

> Hola, te saludamos de {{2}}. Tu {{1}} ya cumplió 5 meses.
>
> Un dato útil: la Garantía Extendida Nissan cuesta menos mientras el auto tiene hasta 15,000 km, y puedes pagarla a 3, 6 o 9 meses sin intereses con tarjeta participante. Aplican términos y condiciones.
>
> ¿Quieres que un asesor te prepare tu cotización? Toca el botón.

## 3. `ge_12m_reparaciones` (campaña 12M_NURTURING)

> Hola, te saludamos de {{2}}. Una reparación mayor fuera de garantía puede ser muy costosa: como referencia, una transmisión puede rondar los $120 mil y un motor los $105 mil (varía por modelo).
>
> La Garantía Extendida Nissan cubre los principales componentes de tu {{1}} con partes originales y mano de obra calificada Nissan.
>
> ¿Platicamos? Toca el botón.

## 4. `ge_28m_vigencia` (campaña 28M)

> Hola, te saludamos de {{2}}. Tu {{1}} está por cumplir los 3 años de su garantía original.
>
> La Garantía Extendida Nissan es la forma de seguir cubierto hasta por 6 años o 125,000 km, con asistencia vial incluida durante la extensión.
>
> ¿Quieres que un asesor te explique cómo contratarla? Toca el botón.

---

## Pendiente de confirmar antes de enviarlas

1. **Plantilla 4 (28M):** el material solo dice que la extensión empieza cuando termina la garantía original; la regla de que *solo* se puede
   contratar mientras esta sigue vigente es una deducción de los precios por kilometraje. Por eso la plantilla no la afirma. Confirmar con Assurant
   antes de convertirla en urgencia («solo mientras…»).
2. **Plantilla 1 (48H):** no menciona el financiamiento con CrediNissan porque falta confirmar si la Garantía Extendida puede incluirse en el crédito
   **después** de la venta. Si se confirma, se agrega una línea.
3. **Plantilla 2 (5M):** los meses sin intereses son del programa «Nissan Nuevos MSI 2026». Confirmar que sigue vigente al enviar.
4. **Plantilla 3 (12M):** los costos son los de referencia del material comercial; ahí mismo se aclara que varían por modelo.
