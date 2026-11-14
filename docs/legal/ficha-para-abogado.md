# Ficha técnica para el abogado · TuListaNegra

Hechos sacados del código al 2026-11-14 para redactar los **términos** y la **política de tratamiento de datos** (LEG-01) y
decidir el **semáforo** (SEM-01). No es un texto legal: dice qué hace la app, no qué debe decir el contrato.
Las preguntas abiertas están al final.

## Quiénes son las partes

- **ALS DevStudio** opera TuListaNegra y cobra los pases. El superadministrador revisa los pagos.
- **La tienda (tendero)** es la que se registra. Es la responsable de los datos de sus deudores; TuListaNegra los trata
  por encargo de ella (producto.md, «Datos personales»).
- **El deudor** es una persona natural que le debe a la tienda. No tiene cuenta. Solo interactúa por WhatsApp, cuando
  ese canal se encienda.

## Qué datos se guardan

| De quién | Datos | Para qué |
| --- | --- | --- |
| Tienda | Correo de la cuenta, identificador de Firebase, nombre de la tienda, tipo y número de documento (opcional), WhatsApp del dueño y la fecha en que lo verificó, cómo le pagan sus clientes, fecha de aceptación de términos | Cuenta, contacto y acceso |
| Tienda | Pases, capturas de pago de los pases (imagen), notas de la revisión, quién la revisó | Cobro de la suscripción |
| Deudor | Nombre, alias, tipo y número de documento (opcionales), WhatsApp (opcional), cupo, saldo, fecha de la deuda más antigua, fecha prometida de pago | Libreta de fiados |
| Deudor | Fecha en que la tienda **declara** que el deudor aceptó mensajes de WhatsApp y fecha en que el deudor se dio de baja escribiendo «SALIR» | Reglas de contacto |
| Deudor | Marca de «lista negra»: es **interna de cada tienda**, ninguna otra la ve | Decisión de la tienda de no fiarle más |
| Deudor | Movimientos (fiado, abono, ajuste) con monto, descripción, foto de evidencia opcional y origen (manual, voz, foto, WhatsApp) | Historial de la deuda |
| Deudor y dueño | Mensajes de WhatsApp entrantes y salientes: teléfono, contenido, plantilla usada y estado de entrega | Cobros por bot, comprobantes y promesas de pago |
| Superadministrador | Registro de cada acción que toma en la consola | Auditoría |

## Dónde se guardan y a quién se envían

| Proveedor | Qué recibe | Dónde |
| --- | --- | --- |
| Cloudflare (Workers, D1, R2) | Todo lo de la tabla anterior. Las imágenes van en un bucket privado que solo se lee con sesión. | Red global de Cloudflare; la ubicación de la base se elige al crearla |
| Google Firebase | Correo y contraseña o cuenta de Google del tendero (solo el ingreso) | Google |
| DeepSeek (apagado hoy) | La frase que el tendero escribe o dicta («fíale 5 000 a doña Rosa»). **Incluye nombres**; se tapan los números de 7 dígitos o más (documentos, teléfonos). | Fuera de Colombia (China) |
| Workers AI de Cloudflare (apagado hoy) | Foto del cuaderno de fiados (nombres y montos) y captura del pago de un pase | Cloudflare |
| Meta / WhatsApp Cloud API (apagado hoy) | Teléfono del deudor o del dueño y el texto de cada mensaje | Meta |

## Qué se le escribe a un deudor (todo apagado hasta que el dueño lo encienda)

- Solo si la tienda tiene registrado el consentimiento del deudor. Ese consentimiento lo **declara la tienda**: la app no
  lo comprueba con el deudor.
- Solo en el horario de cobro y nunca en domingo ni en festivo colombiano (reglas.md, COB-01).
- Con un límite de frecuencia por deudor.
- El deudor se da de baja escribiendo «SALIR». Desde ese momento no recibe más mensajes de esa tienda.
- Los pagos que manda el deudor quedan **pendientes** hasta que el dueño los aprueba. Nada de lo que llega por WhatsApp
  mueve un saldo sin que una persona lo confirme.

## Conservación y borrado

- **No hay borrado automático por plazo.** Todo se guarda sin fecha de caducidad.
- Los movimientos confirmados no se pueden modificar ni borrar: la base lo impide (`migrations/0001_inmutabilidad.sql`).
  Un error se corrige con un ajuste nuevo.
- Archivar un deudor lo oculta de la libreta, pero sus datos se conservan.
- Hoy no existe un botón para que un deudor o una tienda pida borrar sus datos.

## Preguntas para el abogado

1. **Textos:** términos y condiciones, y política de tratamiento de datos (Ley 1581 de 2012, Decreto 1377 de 2013).
   ¿TuListaNegra figura como encargada y la tienda como responsable?
2. **Consentimiento:** ¿basta con que la tienda declare que el deudor aceptó mensajes, o el bot debe pedírselo en su
   primer mensaje?
3. **Cobranza:** confirmar si las reglas de contacto cumplen la Ley 2300 de 2023 (horario, días y frecuencia). También
   si el texto de las plantillas en `src/worker/whatsapp/plantillas.json` sirve tal como está.
4. **DeepSeek:** ¿se puede enviar a un proveedor fuera del país la frase con el nombre del deudor? ¿Qué hay que avisar
   o pedir para hacerlo?
5. **Plazos:** ¿cuánto tiempo se guardan los movimientos, los mensajes, las capturas de pago y los datos de una tienda
   que cancela?
6. **Derechos:** ¿cómo atiende un deudor sus derechos de consulta, rectificación y supresión si no tiene cuenta? ¿Lo
   hace por medio de la tienda?
7. **«Lista negra»:** ¿el nombre de la marca interna y el de la marca comercial generan algún riesgo?
8. **Semáforo comunitario (SEM-01):** compartir entre tiendas una señal sobre un deudor. Hoy está **fuera** del
   producto. Se construye solo con visto bueno escrito. Si se aprueba, el identificador sería un HMAC con clave secreta
   y nunca mostraría datos de otra tienda.
9. **Festivo de la Ley 2578 de 2026:** confirmar el 9 de julio, trasladado a lunes. Hoy está incluido por prudencia.
