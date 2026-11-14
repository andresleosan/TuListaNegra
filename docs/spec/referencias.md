# Referencias de solo lectura (BAS-04)

Patrones de Sarin Bot que TuListaNegra adapta, según la regla A1.2 de `reglas.md`. Se copian **ideas**, nunca código de infraestructura, `.env`, claves ni identificadores de cuenta.

## Procedencia

| Repositorio | Rama | Commit inspeccionado | Fecha del commit |
| --- | --- | --- | --- |
| `andresleosan/SarinBotSAAS` | `main` | `651f36f` | 2026-11-13 |
| `andresleosan/AgendIA` | `main` | `db58e36` | 2026-11-08 |

- Inspección hecha el **2026-11-14** sobre clones superficiales (`--depth 1`), solo con lectura y búsqueda de texto. No se instaló ni se ejecutó nada de ellos (tampoco sus pruebas).
- La ruta local `E:\Proyectos\Sarin Bot` que cita la especificación **no existe en esta máquina** (Linux). Todo lo que sigue sale de los dos repositorios; si la copia local difiere, este documento no lo refleja.
- AgendIA es una variante de marca de SarinBotSAAS: los archivos citados son **idénticos byte a byte en ambos**, salvo `src/lib/server/whatsapp-store.ts` y `src/lib/server/whatsapp-worker.ts` (AgendIA no lleva la comprobación de `policyRevision` antes de enviar). Las rutas valen para los dos repos.
- Diferencia de base que aplica a todos los patrones: allá hay **Next.js 16 en un contenedor** (rutas `src/app/api/**/route.ts` con `runtime = 'nodejs'`, `firebase-admin`, `node:crypto`) y una API de documentos estilo Firestore (`src/lib/storage/types.ts`, `db.runTransaction`) respaldada por una tabla genérica `app_documents` en D1 (`cloudflare/migrations/0001_data.sql`). Aquí hay **un Worker con Hono, tablas D1 propias con Drizzle, R2 y Web Crypto**. Ninguna transacción interactiva de allá se puede trasladar tal cual: en D1 se resuelve con `db.batch` y sentencias condicionales.

## Resumen

| # | Patrón | Estado en las referencias |
| --- | --- | --- |
| 1 | Pago por captura | Encontrado. OCR de monto o referencia: **no encontrado** |
| 2 | Desbloqueo de 24 h | Encontrado, con reglas distintas a las de `producto.md` |
| 3 | Planes, cuotas y contadores | Encontrado (un solo contador de «respuestas», más presupuestos de IA) |
| 4 | Consola del superadministrador | Parcial: acceso por UID, sin bitácora central ni acciones de cortesía |
| 5 | WhatsApp Cloud API | Parcial: firma, idempotencia, ventana, botones y estados sí; **plantillas e imágenes entrantes no encontradas** |
| 6 | Interfaz para que otra app use Sarin Bot | **No encontrado** |

## 1. Pago por captura

**Archivos**
- `src/lib/server/billing.ts`: `submitReceipt`, `readReceiptImage`, `reviewPayment`, `applyPaymentReviewContext`, `readPaymentReviewReceipt`.
- `src/lib/server/schemas.ts`: `receiptSchema`, `validReceiptData`, `adminActionSchema`.
- `src/app/api/billing/route.ts` (dueño) y `src/app/api/admin/route.ts` (`PATCH` aprobar o rechazar).
- `src/lib/server/admin-payment-actions.ts` y `src/app/api/admin/copilot/payment-actions/**`: propuesta y confirmación en dos pasos. Pruebas: `tests/billing.test.ts`, `tests/admin-payment-actions.test.ts`.

**Cómo lo resuelve.** El dueño envía la imagen como *data URL* junto a un `requestId`; el servidor deriva el identificador del recibo de ese `requestId` (reenviar devuelve el mismo recibo) y fija el monto desde la configuración, no desde el navegador (`OFFER_PRICE_CHANGED` si no coincide). `validReceiptData` valida el tipo por **bytes mágicos** (WebP, PNG, JPEG) y limita a 150 KiB. Solo un recibo pendiente a la vez (mira `lastPaymentId`). La revisión es manual y atómica: repetir la misma decisión es un no-op, y la decisión contraria da 409. La imagen se sirve por una ruta autenticada que comprueba dueño o superadministrador.

**Se adapta**
- Monto y días fijados en el servidor; identificador de pago idempotente por `request_id`.
- Validación del tipo por contenido (aquí con límite de 2 MB).
- Revisión idempotente con estado terminal; imagen servida solo por ruta autenticada.
- Propuesta y confirmación en dos pasos con vigencia corta (`admin-payment-actions.ts`): sirve de modelo para los botones Aprobar y Rechazar de la fase 4.

**No se adapta**
- La imagen en base64 dentro de la base de datos → aquí va a **R2 privado** y se guarda `receipt_r2_key`.
- «Un pendiente» comprobado leyendo el último pago → aquí **índice único parcial** en `subscription_payments`.
- OCR de monto, fecha y referencia, y alerta de referencia repetida: **no encontrado**; hay que diseñarlo desde cero (fase 3, con `AI_READY`).
- Motivo de rechazo opcional (`adminActionSchema`) → aquí obligatorio. Los tipos de pago «prueba pagada» y «paquete de respuestas» no existen en TuListaNegra.

## 2. Desbloqueo preventivo de 24 h

**Archivos**
- `src/lib/server/billing-policy.ts`: `grantReceiptGrace`, `approveSubscription`; pruebas en `tests/billing-policy.test.ts`.
- `src/lib/sarin/subscription.ts`: `getBusinessAccess`, `isSubscriptionAllowed`.
- `src/lib/server/billing.ts`: rama de rechazo en `applyPaymentReviewContext`.

**Cómo lo resuelve.** Al subir el comprobante de un plan, `grantReceiptGrace` escribe `graceGrantedAt` y `graceEndsAt = ahora + 24 h`. `getBusinessAccess` es una función pura que calcula el acceso en cada lectura (suspendido → vigente o en gracia → prueba → vencido). Rechazar quita `graceEndsAt` en ese instante. Aprobar hace `max(ahora, vencimiento) + días`.

**Se adapta**
- El estado **calculado** por una función pura, con la suspensión por delante de todo: es el molde de `estadoEfectivo`.
- La gracia concedida en la misma operación atómica que crea el pago, y cortada al rechazar.

**No se adapta**
- Allá la gracia se concede **una sola vez en la vida del negocio**, exige historial pagado y se gasta aunque el negocio siga activo. Aquí se concede cada vez que el negocio no está activo ni suspendido y su último pago revisado no fue rechazado.
- Allá aprobar **no descuenta** el tiempo de gracia consumido. Aquí rige la fórmula de B2 con `desbloqueo_consumido`.
- Allá se guarda un `status` además de las fechas; aquí el estado no se guarda.

## 3. Planes, cuotas y contadores de uso

**Archivos**
- `src/lib/billing-plans.ts` (`BILLING_PLANS`, `getBillingPlan`), `src/lib/paid-trial.ts` y `docs/response-quotas.md`.
- `src/lib/server/response-quota.ts`: `reserveResponseQuota`, `commitResponseQuota`, `releaseResponseQuota`, `getResponseQuota`.
- `src/lib/server/response-periods.ts` y `shared/response-quota-settlement.ts`; pruebas en `tests/response-quota.test.ts`.
- `src/lib/server/ai-budget.ts` y `src/lib/server/ai-usage.ts` (topes en dinero y tokens, medición por mes).
- `src/lib/server/whatsapp-store.ts`: `updateWhatsAppOutbox`, `getWhatsAppUsage` (contadores de mensajes por mes y negocio).

**Cómo lo resuelve.** Una constante única de planes (días, precio, respuestas incluidas). Cada pago aprobado crea un **periodo** con `includedResponses`, `extraResponses`, `usedResponses` y `reservedResponses`. Cada turno de IA **reserva** una unidad antes de llamar al modelo y luego la **confirma o la libera**; el turno se identifica por un hash de negocio, actor, canal y `requestId`, así un reintento no descuenta dos veces. Aparte hay topes diarios y mensuales de gasto de IA, y contadores mensuales de WhatsApp en zona `America/Bogota`.

**Se adapta**
- Constante única de planes en el servidor (`PLANES`).
- Idempotencia del descuento por identificador de solicitud, y devolución de la unidad si la llamada de IA falla antes de producir resultado.
- Aviso al 80 % de uso (`warningThresholdPercent`) y meses calculados en `America/Bogota`.

**No se adapta**
- Un solo contador de «respuestas» → aquí tres (`ai_ocr_used_count`, `ai_chat_used_count`, `wa_reminders_used_count`) en `businesses`.
- Periodos como documentos aparte y máquina de reserva en varias fases → aquí **una sentencia `UPDATE … WHERE usado < límite`** y reinicio de contadores al empezar ciclo.
- Presupuestos en dólares y tokens, tarifas por proveedor y conciliación manual de reservas: fuera de alcance.

## 4. Consola del superadministrador

**Archivos**
- `src/lib/server/auth.ts`: `requireUser`, `requireSuperadmin`, `isSuperadmin`.
- `src/app/api/admin/**/route.ts`; interfaz en `src/app/admin/page.tsx` y `src/components/admin-*.tsx`.
- `src/lib/server/admin-copilot.ts`: `readAdminCopilotSnapshot` (indicadores).
- `src/lib/server/invitations.ts` (cortesías con `{at, by, reason}`), `src/lib/server/response-quota-admin.ts` (`reconcileResponseQuota`).
- `src/app/api/admin/whatsapp/route.ts`, `src/app/api/admin/platform-whatsapp/status/route.ts`, `src/lib/server/platform-whatsapp-store.ts` (`getPlatformWhatsAppStatus`).

**Cómo lo resuelve.** Cada ruta llama a `requireSuperadmin` en el servidor; el filtro de la interfaz es cosmético. El acceso se decide por **UID exacto** de una variable de entorno. Las acciones sensibles piden `reason`, `expectedVersion` (bloqueo optimista) y, para pagos, autenticación reciente. Los indicadores salen de una lectura acotada (negocios, pagos pendientes, cuotas en aviso o agotadas, suscripciones por vencer). El panel de WhatsApp muestra configuración faltante, último mensaje entrante y último entregado.

**Se adapta**
- Comprobación en el servidor en **cada** ruta, con 403 genérico; motivo obligatorio en toda acción y respuestas `no-store`.
- Panel de salud del canal (qué falta configurar, último evento firmado): modelo del «Puente de WhatsApp».
- Reautenticación reciente antes de aprobar dinero (opcional; anotarlo en la cola del dueño si se quiere).

**No se adapta**
- Acceso por UID → aquí por correo en `SUPERADMIN_EMAILS` con `email_verified` y sesión de Google.
- **Bitácora central: no encontrada.** Allá el rastro va incrustado en cada registro; aquí hay tabla `admin_audit_log` de solo inserción.
- Días de cortesía (+3, +7, +15, +30), suscripción gratis sin vencimiento y reinicio de contadores: **no encontrado** (lo más cercano son las invitaciones).
- Suspender y reactivar un negocio: el estado `suspended` se lee, pero **no se encontró** la acción que lo escribe. El copiloto de IA del administrador queda fuera de alcance.

## 5. WhatsApp Cloud API

Las referencias tienen **dos canales**: uno directo contra Meta, con un número por negocio, y otro «de plataforma» a través del proveedor YCloud, con un único número de Sarin Bot.

**Archivos**
- Firma y reto: `src/lib/server/whatsapp-security.ts` (`readSignedWebhook`, `verifyWhatsAppChallenge`, `readBoundedBytes`); ruta `src/app/api/whatsapp/webhook/route.ts`; `tests/whatsapp-security.test.ts`.
- Firma del proveedor: `src/lib/server/ycloud-webhook.ts` (`readYCloudWebhook`, `verifySignature`).
- Ingesta, idempotencia y estados: `src/lib/server/whatsapp-store.ts` (`ingestWhatsAppWebhook`, `payloadSchema`, `valueSchema`); `src/lib/server/platform-whatsapp-ingress.ts` (`ingestPlatformWhatsAppEvent`).
- Envío y ventana: `src/lib/server/whatsapp-worker.ts` (`sendPending`) y `claimWhatsAppOutbox` en `whatsapp-store.ts`.
- Enrutamiento: `src/lib/server/whatsapp-config.ts` (`saveWhatsAppBinding`, `bindingReady`).
- Botones: `src/lib/server/platform-ycloud-client.ts` (`sendButtons`), `shared/platform-whatsapp-menu.ts` (`createPlatformMenu`, `parsePlatformMenuChoice`).
- Teléfono del dueño: `src/lib/server/platform-whatsapp-link.ts` (`beginPlatformWhatsAppLink`, `verifyPlatformWhatsAppLinkInbound`, `confirmPlatformWhatsAppLink`).
- Medios (solo audio): `shared/platform-whatsapp-audio.ts`, `cloudflare/src/platform-whatsapp-audio.ts`. Documentación: `docs/whatsapp-cloud-api.md`, `docs/ycloud-platform-contract.md`.

**Cómo lo resuelve.** El `POST` lee los bytes crudos con tope de 1 MiB, calcula HMAC-SHA-256 con el secreto de la app y lo compara en tiempo constante con `X-Hub-Signature-256: sha256=<hex>`; solo después hace `JSON.parse`. Cada mensaje se guarda con identificador `hash(phone_number_id, wamid)` dentro de una transacción que no hace nada si ya existe. La ruta responde enseguida y despierta una cola (`kickWhatsAppWorker`). Cada entrante fija `windowEndsAt = recibido + 24 h` y el envío se cancela si la ventana venció. Un envío con resultado ambiguo (timeout, 5xx) queda `unknown` y **no se reintenta**; solo se reintenta un 429 explícito. Los estados se concilian por `biz_opaque_callback_data` o por el `wamid`. El dueño vincula su teléfono con un código generado en la web que envía desde su WhatsApp y confirma de nuevo en la web.

**Se adapta**
- Verificación sobre **bytes crudos** antes de analizar el JSON, con tope de tamaño y comparación en tiempo constante (aquí con `crypto.subtle`); reto `GET` con `hub.mode`, `hub.verify_token` y `hub.challenge`.
- Idempotencia por `wa_message_id` con restricción `UNIQUE`; responder rápido y trabajar después (`ctx.waitUntil`).
- Ventana de 24 h calculada desde el último entrante; «ambiguo no se reintenta».
- Identificadores de botón con espacio de nombres, versión, acción e identificador del registro; máximo tres botones y título de hasta 20 caracteres.
- Verificación del teléfono del dueño con código de un solo uso, caducidad, tope de intentos y tope de emisiones.
- La palabra exacta `SALIR` como señal que corta la automatización de esa conversación (`src/lib/server/platform-whatsapp-work-admission.ts`).

**No se adapta / no encontrado**
- **Envío de plantillas: no encontrado** (`docs/ycloud-platform-contract.md` lo excluye de forma expresa). Las referencias solo envían texto libre y botones dentro de la ventana.
- **Imágenes o comprobantes entrantes: no encontrado.** El canal directo descarta todo lo que no sea texto; el de plataforma solo admite audio.
- **Enrutamiento entre varios negocios con un número compartido: no encontrado.** Allá cada número pertenece a un solo negocio (`phone_number_id` → negocio). Las reglas de 72 h y `AWAITING_TENANT_SELECTION` de B4 son diseño propio.
- Cola con *polling* cada 30 s en un proceso Node, cifrado AES-GCM del contenido y retención por lotes: aquí el trabajo va en `waitUntil` o en el cron, y no se guardan cuerpos en los registros.

## 6. Interfaz para que otra app use Sarin Bot

**No encontrado.** Ninguno de los dos repositorios expone un servicio por el que una aplicación externa pueda pedir un envío de WhatsApp o suscribirse a eventos reenviados.

Lo revisado y por qué no sirve:
- `src/app/api/sarin/chat/route.ts`: chat para usuarios finales con sesión de Firebase; no es una API entre servicios.
- `pages-gateway/worker.mjs`: pasarela que reenvía todo el tráfico público a la aplicación propia por *service binding*; no admite terceros.
- `cloudflare/src/index.ts` (`SarinApp.outboundByHost`): salidas internas del contenedor hacia datos, identidad, audio y respaldo. `src/app/api/whatsapp/ycloud/platform/webhook/route.ts` recibe del proveedor y no reenvía a nadie.

**Consecuencia.** La variante «eventos reenviados desde Sarin Bot» de B4 exige construir en Sarin Bot algo que hoy no existe. El contrato propuesto está en `docs/spec/contrato-sarin.md`.
