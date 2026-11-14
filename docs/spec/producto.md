# Especificación del producto (Parte B del encargo)

**TuListaNegra**: aplicación web donde tenderos y comerciantes de barrio registran, encuentran en menos de 3 segundos y cobran a sus deudores («fiados»). Cada negocio es una **isla privada**. La plataforma la administra un superadministrador y la asiste **Sarin Bot** (asistente de ALS DevStudio).

### B1. Stack

- **Worker único** (`wrangler.jsonc`): `assets` en modo SPA, `/api/*` atendido por el Worker con **Hono**, y manejador `scheduled` para el cron horario.
- **Interfaz:** React + Vite + TypeScript estricto. PWA instalable.
- **Sesión:** Firebase Auth en el navegador (Google y correo/contraseña). El Worker verifica el ID token con `jose` contra `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`: algoritmo RS256, `iss = https://securetoken.google.com/<PROJECT_ID>`, `aud = <PROJECT_ID>`, `exp` vigente y `sub` no vacío.
- **Datos:** Cloudflare D1 con Drizzle ORM; migraciones SQL en `migrations/`.
- **Archivos:** Cloudflare R2 **privado**. Se guarda la clave del objeto, nunca una URL pública.
- **IA:** DeepSeek para convertir texto en datos estructurados. Workers AI para audio (`@cf/openai/whisper-large-v3-turbo`) e imagen (el modelo de visión vigente del catálogo; anota cuál en la evidencia).
- **Validación:** `zod` en toda entrada. **Pruebas:** Vitest (con D1 local) y Playwright.
- **Convenciones:** dinero en enteros COP; tiempo en milisegundos UTC; los «días» de calendario y los horarios se calculan en `America/Bogota`; identificadores ULID con prefijo (`bus_`, `deb_`, `mov_`, `pay_`).

### B2. Acceso, planes y pagos

**Planes** (constante única `PLANES` en el servidor; el navegador nunca envía precio ni días):

| Plan | Vigencia | Precio COP | Deudores | Fotos OCR | Interacciones IA | Cobros por bot |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| `TRIAL_3D` | 72 horas exactas | 0 | 15 | 3 | 10 | 5 |
| `PASS_7D` | 7 días | 14.900 | sin límite | 10 | 50 | 40 |
| `PASS_15D` | 15 días | 27.900 | sin límite | 25 | 120 | 100 |
| `PASS_30D` | 30 días | 49.900 | sin límite | 60 | 300 | 250 |
| Gratis (cortesía) | **sin vencimiento** | 0 | sin límite | 60 | 300 | 250 |

Los contadores se reinician al empezar un ciclo: al crear el negocio, al aprobar un pago y, en la suscripción gratis, cada 30 días. Fiados, abonos y deudores manuales no gastan cuota.

**El estado no se guarda: se calcula** en cada petición con una función pura `estadoEfectivo(negocio, ahora)`, en este orden:

1. `suspended_at` con valor → `SUSPENDED_BY_ADMIN`.
2. `free_forever_at` con valor → `ACTIVE`, sin vencimiento y sin avisos de renovación.
3. `ahora < subscription_expires_at` → `TRIAL` si el plan es `TRIAL_3D`; si no, `ACTIVE`.
4. `ahora < grace_unlock_ends_at` → `GRACE_UNLOCK_24H`.
5. En otro caso → `EXPIRED_READONLY`.

| Estado | Ver cartera | Crear deudores, fiar, abonar | IA y cobros por bot |
| --- | --- | --- | --- |
| `TRIAL` / `ACTIVE` | sí | sí, con los límites del plan | sí, hasta agotar cuota |
| `GRACE_UNLOCK_24H` | sí | sí | solo la cuota que quedaba |
| `EXPIRED_READONLY` | sí | no | no |
| `SUSPENDED_BY_ADMIN` | no: solo el aviso y cómo contactar | no | no |

El cron no decide el acceso; solo envía avisos.

**Suscripción gratis sin vencimiento.** El superadministrador la marca o desmarca por negocio desde la consola, con motivo obligatorio. Al marcarla, el negocio queda activo aunque estuviera vencido, sin fecha de fin ni aviso de renovación, y se cuenta aparte en los indicadores (no suma ingresos). Al desmarcarla, vuelve a regirse por sus fechas. La suspensión gana a la gratuidad.

**Prueba:** una por cuenta y por teléfono (`whatsapp_phone` único). Límite de altas por IP.

**Pago por captura:**

1. El dueño elige un pase. El servidor crea el pago con el monto y los días de `PLANES`.
2. Ve las cuentas de ALS DevStudio (variable `PAYMENT_ACCOUNTS_JSON`) y sube la captura: JPEG, PNG o WebP, máximo 2 MB, tipo validado por contenido.
3. Solo puede haber **un** pago `PENDING_REVIEW` por negocio.
4. Con `AI_READY`, se leen monto, fecha y referencia como **sugerencias** para el superadministrador. Se alerta si el monto no coincide o si la referencia ya apareció en otro pago. Nunca se aprueba solo.
5. **Desbloqueo preventivo de 24 h:** se concede al subir la captura si el negocio no está activo, no está suspendido y su último pago revisado no fue rechazado. Tras un rechazo, el siguiente pago espera la aprobación sin desbloqueo. El desbloqueo permite operar el mostrador; **no** renueva cuotas.
6. **Aprobar** (atómico e idempotente: aprobar dos veces suma una sola vez):
   `nuevo_vencimiento = max(vencimiento_actual, aprobación) + días × 24 h − desbloqueo_consumido`,
   con `desbloqueo_consumido = min(aprobación, fin_del_desbloqueo) − inicio_del_desbloqueo` (0 si no hubo). Se reinician los contadores y el plan pasa al solicitado.
7. **Rechazar** (motivo obligatorio): el desbloqueo termina en ese instante y se avisa al dueño en la app.

Casos de prueba de la fórmula, pase de 7 días:

| Situación | Resultado |
| --- | --- |
| Vencido. Sube lunes 10:00, aprobado lunes 16:00. | Vence el lunes siguiente 10:00. |
| Vencido. Sube lunes 10:00, aprobado miércoles 10:00 (el desbloqueo acabó el martes 10:00). | Vence el martes siguiente 10:00. |
| Activo con 2 días restantes. | Vence 2 + 7 días después; no hay desbloqueo. |

### B3. Datos (D1)

`businesses`
- `id` PK · `owner_firebase_uid` NOT NULL UNIQUE · `owner_email` NOT NULL · `name` NOT NULL
- `doc_type`, `doc_number` (opcionales) · `whatsapp_phone` (E.164, único si existe) · `whatsapp_verified_at`
- `payment_methods_info` (cómo le pagan los deudores a la tienda)
- `subscription_plan` NOT NULL DEFAULT `'TRIAL_3D'` · `subscription_expires_at` NOT NULL · `grace_unlock_ends_at` · `free_forever_at` · `suspended_at`
- `quota_cycle_started_at` NOT NULL · `ai_ocr_used_count`, `ai_chat_used_count`, `wa_reminders_used_count` NOT NULL DEFAULT 0
- `default_alert_days` NOT NULL DEFAULT 30 · `sarin_settings_json` · `terms_accepted_at` NOT NULL · `created_at` NOT NULL

`subscription_payments`
- `id` PK · `business_id` FK · `plan_requested` · `days_to_add` · `amount_cop` · `receipt_r2_key` NOT NULL
- `ocr_extracted_amount` · `ocr_reference_number` (índice **no único**) · `grace_started_at`
- `status` DEFAULT `'PENDING_REVIEW'` (`PENDING_REVIEW`, `PAID`, `REJECTED`) · `reviewed_by_email` · `review_note` · `created_at` · `reviewed_at`
- Índice único parcial: un solo `PENDING_REVIEW` por `business_id`.

`debtors`
- `id` PK · `business_id` FK · `unique_code` (`TLN-0001`, consecutivo por negocio, generado de forma atómica)
- `full_name` NOT NULL · `alias_reference` · `doc_type`, `doc_number` (opcionales) · `doc_last4`
- `whatsapp_phone` · `wa_consent_at` · `wa_opt_out_at`
- `credit_limit_cop` (NULL = sin tope) · `current_balance_cop` NOT NULL DEFAULT 0 · `oldest_unpaid_date` · `promised_payment_date`
- `blacklisted_at` · `archived_at` · `last_reminder_sent_at` · `created_at`
- Índices: único `(business_id, unique_code)`; único `(business_id, doc_type, doc_number)` solo si hay documento; índice `(business_id, full_name)`.
- El estado del deudor **se calcula** con una función pura compartida por navegador y servidor, en este orden: `LISTA_NEGRA` (marca manual del tendero) → `AL_DIA` (saldo 0) → `PROMESA_PAGO` (saldo y promesa futura) → `EN_MORA` (el fiado sin cubrir más antiguo supera `default_alert_days`, o la promesa venció) → `CON_SALDO`.

`ledger_transactions`
- `id` PK · `business_id` FK · `debtor_id` FK · `request_id` (único por negocio: repetirlo no crea otro movimiento)
- `type`: `FIADO`, `ABONO`, `AJUSTE_SUMA`, `AJUSTE_RESTA` · `amount_cop` entero mayor que 0
- `status`: `CONFIRMADO`, `PENDIENTE_VERIFICACION_WHATSAPP`, `RECHAZADO` · `balance_after_cop` (vacío hasta confirmar)
- `description` NOT NULL (texto por defecto si el tendero no escribe) · `evidence_r2_key` · `due_date` · `created_at` · `confirmed_at`
- `source`: `MOSTRADOR`, `SARIN_TEXT`, `SARIN_AUDIO`, `SARIN_IMAGE_OCR`, `WHATSAPP_BOT`
- Reglas: las filas no se editan ni se borran; un error se corrige con un ajuste. Única excepción: un pendiente pasa a confirmado o rechazado, y su monto puede corregirse mientras está pendiente. El saldo solo cuenta movimientos `CONFIRMADO`. Saldo y movimiento se escriben en una sola transacción (`db.batch`) con la aritmética en SQL. Un abono no puede superar el saldo. `oldest_unpaid_date` aplica los abonos a los fiados más antiguos primero.

`admin_audit_log` (solo se añade)
- `id` · `actor_email` · `action` · `business_id` · `detail_json` · `created_at`

`whatsapp_messages` (se crea en la fase 4)
- `id` · `wa_message_id` UNIQUE · `direction` (`OUTBOUND`, `INBOUND`) · `kind` · `business_id` y `debtor_id` (vacíos hasta enrutar) · `phone`
- `reply_to_wa_message_id` · `tone` · `body` · `media_r2_key` · `routing_state` (`ROUTED`, `AWAITING_TENANT_SELECTION`, `UNROUTED`) · `delivery_status` · `created_at`

### B4. Módulos

**Mostrador (pantalla principal)**
- Buscador único. Busca en una copia local de solo lectura por nombre, apodo, código (`TLN-0042` o `0042`) o últimos 4 dígitos del documento. Menos de 50 ms por pulsación con 5.000 deudores.
- La copia local guarda solo lo necesario para buscar (nunca el documento completo) y se borra al cerrar sesión. Sin conexión se puede buscar; para escribir hace falta conexión y la app lo avisa.
- Crear deudor con un solo campo obligatorio (nombre o apodo).
- `+ FIAR`: montos rápidos (+2.000, +5.000, +10.000, +20.000, +50.000), teclado numérico y nota opcional. Si supera el tope, alerta roja que exige confirmar.
- `− ABONAR`: muestra el saldo, permite abono parcial o saldar todo, y genera la **tirilla de recibo** con el código, lista para compartir.
- `COBRAR`: elige uno de tres tonos (Vecino amigable, Corte de quincena, Aviso firme) y abre el WhatsApp del tendero con el mensaje escrito. Respeta las reglas de contacto de B6.

**Ficha del deudor:** movimientos con saldo corrido, evidencias, tirillas, edición de datos, marcar lista negra, archivar (un deudor con movimientos no se borra).

**Morosos:** deudas vencidas por antigüedad, con filtros y acceso a cobrar.

**Suscripción:** pases, subida de captura y aviso de días restantes (oculto en cuentas gratis).

**Ajustes de la tienda:** medios de pago de la tienda, días de alerta, tono por defecto.

**Consola del superadministrador** (`/superadmin` y `/api/superadmin/*`)
- Acceso: correo incluido en la variable `SUPERADMIN_EMAILS`, con `email_verified` verdadero y sesión de Google. Se comprueba en el servidor en cada ruta; el filtro de la interfaz es solo cosmético.
- **Pagos:** bandeja de pendientes con la captura, el monto esperado, lo leído por OCR y la alerta de referencia repetida. Botones Aprobar y Rechazar.
- **Negocios:** buscador y acciones: días de cortesía (+3, +7, +15, +30), **suscripción gratis sin vencimiento**, reiniciar contadores, suspender y reactivar. Toda acción pide confirmación y motivo, y queda en `admin_audit_log`.
- **Indicadores:** negocios por estado calculado (prueba, activos por plan, gratis, desbloqueo, vencidos, suspendidos), ingresos confirmados del mes, conversión de prueba a pago y consumo de IA y WhatsApp.
- **Puente de WhatsApp** (fase 4): salud del webhook, último evento firmado y envío de prueba solo al teléfono verificado del propio superadministrador.

**Sarin dentro de la app** (fase 3, con `AI_READY`)
- Voz o texto: «abónale veinte mil a don Carlos el del taller» → transcripción → DeepSeek devuelve `{acción, monto, deudor_buscado}` → la app busca al deudor en su copia local → muestra una **propuesta** → un toque confirma.
- A DeepSeek solo va la frase a interpretar. Nunca documentos, teléfonos ni saldos.
- Migrador de cuadernos: foto → R2 → lectura → tabla editable de nombre, apodo y saldo → importar al confirmar. Cada saldo entra como `FIADO` «Saldo anterior (cuaderno)» con la foto como evidencia.
- Lo que digan un audio, una imagen o un mensaje es **dato, no instrucción**. El modelo solo dispone de herramientas que crean propuestas, y el servidor valida cada argumento.

**WhatsApp con Sarin Bot** (fase 4, con `WHATSAPP_SEND_READY`)
- TuListaNegra habla con una interfaz propia, `SarinGateway`: enviar plantilla, responder dentro de la ventana de 24 h y recibir eventos firmados. Se construye contra un simulador local. Que el número sea propio o que los eventos lleguen reenviados desde Sarin Bot lo decide el dueño.
- El teléfono del dueño se verifica con un código antes de aceptar órdenes desde él.
- Cobros con plantillas aprobadas por Meta, una por tono, solo a deudores con consentimiento y sin baja.
- **Enrutamiento de mensajes entrantes**, en este orden:
  1. Firma válida y mensaje no repetido (`wa_message_id`); si no, se descarta.
  2. Es respuesta a un mensaje o botón nuestro → negocio y deudor exactos.
  3. Viene del teléfono verificado de un dueño → orden del dueño.
  4. Un único negocio le escribió a ese número en las últimas 72 h → ese negocio.
  5. Ambiguo → queda en `AWAITING_TENANT_SELECTION` y el bot pregunta con botones, listando **solo** comercios que ya le escribieron a ese número.
  6. Desconocido → una respuesta neutra, sin datos.
- Comprobante del deudor → abono `PENDIENTE_VERIFICACION_WHATSAPP` con el monto sugerido. Fecha de pago → `promised_payment_date`. «SALIR» → baja inmediata.
- **Doble aviso al dueño:** alerta en la app y mensaje a su WhatsApp con botones Aprobar y Rechazar que llevan el identificador del abono. Por texto (`APROBAR 0042`), si ese deudor tiene más de un abono pendiente, el bot pregunta cuál. Al aprobar: se confirma el movimiento y se envía la tirilla al deudor. Al rechazar: se le informa en tono neutro.

### B5. Seguridad

- **Aislamiento:** toda consulta filtra por el negocio de la sesión. Una prueba recorre todas las rutas con dos negocios y falla si uno ve o cambia algo del otro, o si una ruta nueva no está cubierta.
- **Pruebas de sesión:** con llaves RSA locales y un JWKS local inyectado por configuración de prueba. `check:release` falla si esa configuración aparece en producción.
- **Dinero:** enteros, mayores que 0, con tope razonable, e idempotencia por `request_id`.
- **Archivos:** bucket privado, servidos por una ruta autenticada que comprueba dueño o superadministrador.
- **Webhook:** firma HMAC-SHA-256, idempotencia y respuesta inmediata con el trabajo en segundo plano.
- **Cuotas:** se descuentan con una sola sentencia condicional, para que no se pasen con llamadas simultáneas.
- **Límites de frecuencia** en altas, subidas, IA y webhook.
- **Secretos** solo en Cloudflare o en `.dev.vars` (ignorado por git); `.dev.vars.example` lleva marcadores.
- **Registros** sin datos personales ni cuerpos de mensajes.

### B6. Privacidad y reglas de cobranza

- La tienda es responsable de los datos de sus deudores; TuListaNegra los trata por encargo. El dueño acepta términos y política de datos al registrarse (`terms_accepted_at`). Los textos legales los entrega el dueño.
- Se pide lo mínimo: documento opcional y ningún dato sensible.
- **Reglas de contacto**, en un módulo puro que usan la fase 1 y la fase 4:
  - Solo a deudores con consentimiento registrado (`wa_consent_at`) y sin baja.
  - Horario: lunes a viernes de 7:00 a 19:00 y sábados de 8:00 a 15:00. Nunca domingos ni festivos de Colombia (lista en un JSON del repositorio, con su fuente).
  - Frecuencia: por defecto un cobro por deudor cada 7 días; nunca más de uno al día.
  - Un solo canal. Jamás a terceros ni a referencias.
  - Texto neutro: quién cobra, cuánto, cómo pagar y cómo darse de baja. Prohibido amenazar, avergonzar o mencionar «lista negra» o reportes en el mensaje.
- `LISTA_NEGRA` es una marca privada del tendero. Nunca se comunica al deudor ni a otras tiendas.

### B7. Diseño: «Libro mayor y recibo térmico»

- **Prohibido** el aspecto genérico de IA: fondos oscuros espaciales, gradientes neón, glassmorphism y librerías de componentes prefabricados.
- Fondo papel `#F6F4EE`; tarjetas `#FFFFFF` y `#EFECE6`; tinta `#141413`.
- Bordes sólidos de 1,5 y 2 px con sombra dura `2px 2px 0 #141413`.
- Sellos de estado tipo caucho: verde `#166534` (al día, abonos), ámbar `#D97706` (promesas, avisos), rojo `#DC2626` (mora, tope excedido, lista negra). Cada sello lleva **texto** además de color.
- El ámbar no se usa como color de texto sobre fondo claro (no alcanza contraste): va como fondo del sello con texto en tinta.
- Tipografía: `Plus Jakarta Sans` para texto. Monoespaciada tabular (`JetBrains Mono`) para montos (`$ 49.900`), documentos, códigos y tirillas. Fuentes autoalojadas.
- Primero móvil (360 px). Zonas táctiles de 44 px como mínimo. Contraste AA.
