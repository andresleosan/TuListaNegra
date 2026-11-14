# Contrato de `SarinGateway` (fase 4)

Interfaz por la que TuListaNegra habla con WhatsApp (`producto.md` B4): **enviar plantilla**, **responder dentro de la ventana de 24 h** y **recibir eventos firmados**. Es una propuesta: se construye primero contra el simulador local, con `WHATSAPP_SEND_READY=0`. Procedencia de las referencias en `docs/spec/referencias.md` (`SarinBotSAAS@651f36f`, `AgendIA@db58e36`, 2026-11-14).

## (a) Interfaz TypeScript propuesta

```ts
type E164 = string;            // «+» y de 8 a 15 dígitos
type WaMessageId = string;     // «wamid.…» de Meta, o sintético en el simulador
type Tono = 'VECINO_AMIGABLE' | 'CORTE_QUINCENA' | 'AVISO_FIRME';

interface SarinGateway {
  /** Mensaje iniciado por el negocio. Único envío permitido fuera de la ventana. */
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  /** Mensaje libre. Falla con WINDOW_CLOSED si pasaron 24 h desde el último entrante. */
  sendReply(input: SendReplyInput): Promise<SendResult>;
  /** Verifica la firma sobre el cuerpo crudo y normaliza. Lanza si la firma no vale. */
  parseWebhook(rawBody: ArrayBuffer, headers: Headers): Promise<SarinEvent[]>;
  /** Reto GET de alta del webhook; null si el modo o el token no coinciden. */
  verifyChallenge(url: URL): string | null;
  /** Descarga un medio entrante para guardarlo en R2. */
  fetchMedia(mediaId: string): Promise<{ bytes: ArrayBuffer; mimeType: string }>;
}

interface SendBase {
  to: E164;
  /** Clave de idempotencia: reenviar la misma no manda dos mensajes. */
  requestId: string;
  /** Vuelve intacto en los eventos de estado, para conciliar. Sin datos personales. */
  callbackData?: string;
}
interface SendTemplateInput extends SendBase {
  template: `cobro_${Lowercase<Tono>}` | 'aviso_abono_pendiente' | 'codigo_verificacion';
  language: 'es_CO';
  variables: string[];                                  // en el orden de la plantilla
  buttonPayloads?: string[];                            // respuestas rápidas, máximo 3
}
interface SendReplyInput extends SendBase {
  replyTo?: WaMessageId;
  content:
    | { kind: 'text'; text: string }                                     // hasta 4096
    | { kind: 'buttons'; text: string; buttons: { id: string; title: string }[] } // 1 a 3, título ≤ 20
    | { kind: 'image'; r2Key: string; caption?: string };                // tirilla
}
type SendResult =
  | { status: 'accepted'; waMessageId: WaMessageId }
  | { status: 'rejected'; code: 'WINDOW_CLOSED' | 'INVALID_TEMPLATE' | 'RATE_LIMITED' | 'OTHER'; retryable: boolean }
  | { status: 'unknown' };      // timeout o 5xx: pudo salir. No se reintenta solo.

interface EventBase {
  waMessageId: WaMessageId;     // clave de idempotencia (UNIQUE en whatsapp_messages)
  occurredAt: number;           // ms UTC
  phoneNumberId: string;        // número nuestro que lo recibió
}
interface InboundBase extends EventBase {
  from: E164;
  profileName?: string;
  replyToWaMessageId?: WaMessageId;   // paso 2 del enrutamiento de B4
}
type SarinEvent =
  | (InboundBase & { kind: 'text'; text: string })
  | (InboundBase & { kind: 'button'; buttonId: string; title: string })
  | (InboundBase & { kind: 'image'; mediaId: string; mimeType: string; sha256?: string; caption?: string })
  | (EventBase & { kind: 'status'; status: 'sent' | 'delivered' | 'read' | 'failed'; errorCode?: number; callbackData?: string });
```

Notas de diseño:
- `SendResult` con `accepted`, `rejected` y `unknown` sigue al resultado que devuelven `sendText` y `sendButtons` en `src/lib/server/platform-ycloud-client.ts` y a la regla «ambiguo no se reintenta» de `src/lib/server/whatsapp-worker.ts` (`sendPending`).
- El identificador de botón sigue el molde de `shared/platform-whatsapp-menu.ts`: espacio de nombres, versión, acción e identificador del registro. Propuesta: `tln.v1:<accion>:<id>`, por ejemplo `tln.v1:aprobar:mov_…`. Recibir un botón **no** autoriza nada: el servidor comprueba quién lo pulsó y el estado del abono.
- La interfaz no lleva `business_id`: el enrutamiento es de TuListaNegra y ocurre **después** de `parseWebhook`. Los nombres de plantilla son provisionales hasta que Meta los apruebe.

## (b) Webhook y firma

**Reto de alta** — `GET /api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<TOKEN>&hub.challenge=<TEXTO>`. Si el modo es `subscribe` y el token coincide (comparación en tiempo constante), se responde 200 con el `hub.challenge` tal cual; si no, 403. Referencia: `verifyWhatsAppChallenge` en `src/lib/server/whatsapp-security.ts`.

**Evento** — `POST /api/whatsapp/webhook`, con la cabecera `X-Hub-Signature-256: sha256=<64 hex en minúscula>`.

```text
firma = HMAC-SHA-256(clave = secreto de la app de Meta, mensaje = bytes crudos del cuerpo)
```

Orden obligatorio, igual que `readSignedWebhook` (`src/lib/server/whatsapp-security.ts`, con sus casos en `tests/whatsapp-security.test.ts`):
1. Rechazar con 413 si el cuerpo supera 1 MiB (por `Content-Length` y por lectura real).
2. Leer los **bytes crudos** una sola vez (`request.arrayBuffer()`); no volver a serializar.
3. Exigir el formato `sha256=<64 hex>`; si falta o está mal, 401.
4. Verificar con `crypto.subtle.verify('HMAC', clave, firma, cuerpo)`, que compara en tiempo constante. La referencia usa `createHmac` y `timingSafeEqual` de `node:crypto`; en el Worker se usa Web Crypto.
5. Solo entonces decodificar UTF-8 estricto y hacer `JSON.parse`; después validar con `zod`.
6. Insertar por `wa_message_id`; si ya existía, terminar. Responder 200 y seguir en `ctx.waitUntil`.

Forma del cuerpo que la referencia valida (`payloadSchema` y `valueSchema` en `src/lib/server/whatsapp-store.ts`, y el documento `docs/whatsapp-cloud-api.md`):

```json
{ "object": "whatsapp_business_account",
  "entry": [{ "id": "<WABA_ID>", "changes": [{ "field": "messages", "value": {
    "messaging_product": "whatsapp",
    "metadata": { "phone_number_id": "<PHONE_NUMBER_ID>" },
    "contacts": [{ "wa_id": "<TELEFONO_SIN_MAS>", "profile": { "name": "<NOMBRE>" } }],
    "messages": [{ "id": "<WAMID>", "from": "<TELEFONO_SIN_MAS>", "timestamp": "<EPOCH_SEGUNDOS>",
                   "type": "text", "text": { "body": "<TEXTO>" } }],
    "statuses": [{ "id": "<WAMID>", "status": "delivered", "timestamp": "<EPOCH_SEGUNDOS>",
                   "biz_opaque_callback_data": "<CALLBACK_DATA>" }] } }] }] }
```

Otros hechos vistos en la referencia: rechaza los lotes de más de 100 eventos; `timestamp` llega en segundos y como texto; `read` implica `delivered`; se descartan entrantes con fecha más de 5 minutos en el futuro; el envío va a `POST https://graph.facebook.com/<VERSION>/<PHONE_NUMBER_ID>/messages` con `Authorization: Bearer`, y la respuesta trae `messages[0].id`.

Lo que la referencia **no** analiza y sale de la documentación pública de Meta, sin respaldo en código (ver (e)): `type: "interactive"` con `interactive.button_reply.{id,title}`, `type: "button"` (respuesta rápida de plantilla), `type: "image"` con `image.{id,mime_type,sha256,caption}`, y `context.id` como origen de `replyToWaMessageId`. La forma `interactive.button_reply.id` sí aparece, pero en el formato del proveedor: `normalize` en `src/lib/server/ycloud-webhook.ts`.

## (c) Las dos variantes que decide el dueño

| | **A. Número propio contra la Cloud API** | **B. Eventos reenviados desde Sarin Bot** |
| --- | --- | --- |
| Quién firma lo entrante | Meta, con el secreto de la app | Sarin Bot, con un secreto compartido nuevo |
| Cabecera | `X-Hub-Signature-256` | Propuesta: la misma cabecera y el mismo algoritmo, más una marca de tiempo con tolerancia de 300 s |
| Cuerpo | Formato de Meta de (b) | Formato por acordar; lo más simple es reenviar el cuerpo de Meta sin tocar |
| Envío | `fetch` directo a Graph API con el token del número | Llamada HTTP a un servicio de Sarin Bot que **hoy no existe** |
| Plantillas | Se aprueban en la cuenta de TuListaNegra | Se aprueban en la cuenta de Sarin Bot |
| Medios | Graph API con el token propio | Sarin Bot tiene que servirlos o reenviar los bytes |
| Secretos en Cloudflare | Secreto de la app, token de verificación, token del número | Secreto compartido y credencial de envío |
| Enrutamiento por negocio | Todo en TuListaNegra, un solo número | Sarin Bot debe decidir antes qué mensajes son de TuListaNegra |
| Depende de | Alta en Meta: cuenta, número y plantillas | Desarrollo nuevo en Sarin Bot, además de su alta en Meta |

Qué cambia en el código: solo la implementación de `SarinGateway` (`MetaCloudGateway` o `SarinForwardGateway`), las variables y el reto `GET`, que solo hace falta en A. El webhook, la idempotencia, el enrutamiento, las reglas de contacto y la tabla `whatsapp_messages` son iguales.

Dos advertencias para la variante B, sacadas del código:
- En las referencias **no hay** interfaz de reenvío ni de envío por encargo (`referencias.md`, sección 6).
- El número de plataforma de Sarin Bot recibe por el proveedor YCloud, que firma distinto: cabecera `YCloud-Signature: t=<segundos>,s=<hex>`, con HMAC-SHA-256 de `t` + `.` + cuerpo y tolerancia de 300 s (`verifySignature` en `src/lib/server/ycloud-webhook.ts`). TuListaNegra no puede verificar esa firma sin el secreto de Sarin Bot, así que Sarin Bot tendría que **volver a firmar** lo que reenvíe. Esa marca de tiempo es el modelo de la protección contra repeticiones propuesta en la tabla.

La opción más simple y reversible es la **A**: no depende de construir nada en otro proyecto. La decisión es del dueño.

## (d) Qué debe ofrecer el simulador local

Para recorrer la fase 4 completa sin Meta y sin escribir a personas reales (A1.6):

1. **`SimulatedGateway`**, que implementa la misma interfaz y nunca sale a la red. Es la única implementación posible con `WHATSAPP_SEND_READY=0`.
2. **Bandeja de salida visible**: cada envío queda en `whatsapp_messages` con un `wa_message_id` sintético, la plantilla ya resuelta con sus variables y los botones, para revisarlo en pantalla y en pruebas.
3. **Catálogo de plantillas local** (un JSON con nombre, idioma y número de variables por tono). Rechaza con `INVALID_TEMPLATE` una plantilla desconocida o con variables de más o de menos.
4. **Inyector de entrantes**: construye el cuerpo en el formato de (b), lo **firma con un secreto de desarrollo** y lo envía al webhook real. No hay atajo que salte la firma (A1.7). Cubre texto, botón, imagen y estado.
5. **Reloj inyectable**, para probar la ventana de 24 h (`WINDOW_CLOSED`), las 72 h del enrutamiento y el horario de contacto.
6. **Estados simulados**: `sent` → `delivered` → `read`, y `failed` con código de error; también desordenados y repetidos.
7. **Casos adversos listos**: firma inválida, cuerpo de más de 1 MiB, el mismo `wa_message_id` dos veces, envío con resultado `unknown`, y `RATE_LIMITED`.
8. **Medios de muestra**: `fetchMedia` devuelve imágenes de prueba (JPEG, PNG, WebP y un archivo que no es imagen) para ejercitar comprobante → R2 → abono pendiente.
9. **Guiones del enrutamiento** de B4, pasos 2 a 6 (respuesta a un mensaje nuestro, orden del dueño verificado, único negocio en 72 h, ambiguo con botones, desconocido) y de la **verificación del teléfono del dueño**: código emitido en la app y entrante simulado con ese código.
10. **Candado de publicación**: `check:release` falla si el secreto de desarrollo o las rutas del simulador aparecen en la configuración de producción.

## (e) Supuestos sin confirmar

No se pudo verificar en el código de las referencias:

1. **Plantillas.** Las referencias no envían ninguna. El cuerpo de envío (`type: "template"`, componentes y variables), el idioma `es_CO` y los nombres propuestos salen de la documentación de Meta, no de código probado.
2. **Imagen entrante, botón entrante y `context.id`** en el formato directo de Meta. El canal directo de la referencia solo procesa texto.
3. **Medios.** La referencia solo descarga audio por su proveedor; ni la descarga de Meta en dos pasos (identificador → URL temporal → bytes) ni el envío de imagen saliente (la tirilla) existen allá.
4. **Código de error de ventana vencida** de Meta y su correspondencia con `WINDOW_CLOSED`.
5. **Versión de Graph API.** La referencia fija `v25.0` y rechaza cualquier otra; no se comprobó contra Meta que siga vigente.
6. **Variante B.** No existe interfaz en Sarin Bot; cabecera, formato y servicio de envío son propuesta de este documento.
7. **Reentregas de Meta** (hasta 7 días, según `docs/whatsapp-cloud-api.md`): afirmación de la referencia, no medida.
8. **Límites de botones** (3 botones, título de 20 caracteres): los aplica `sendButtons` para su proveedor; se asume que Meta impone los mismos.
9. **Copia local** `E:\Proyectos\Sarin Bot`: no existía en esta máquina; puede contener algo que los repositorios no traen.
10. **Nada se ejecutó.** El comportamiento descrito sale de leer código, documentos y pruebas de las referencias; sus pruebas no se corrieron.
