// Formato de Meta (WhatsApp Cloud API) para lo entrante: reto de alta, firma y cuerpo (contrato-sarin.md, sección b).
// Lo usan el simulador y, cuando exista, el gateway de la variante A. Nunca se registran cuerpos ni teléfonos.
import { z } from 'zod';
import { ErrorWebhook, type SarinEvent } from './tipos';

/** Tope del cuerpo del webhook, como la referencia. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** Lotes más grandes se rechazan enteros (referencia: `whatsapp-store.ts`). */
export const MAX_EVENTOS = 100;

const codificar = (texto: string) => new TextEncoder().encode(texto);

/** Reto GET: modo `subscribe` y token igual a `WHATSAPP_VERIFY_TOKEN`, comparado en tiempo constante. */
export function verificarReto(url: URL, token: string | undefined): string | null {
  const reto = url.searchParams.get('hub.challenge');
  if (!token || url.searchParams.get('hub.mode') !== 'subscribe' || reto === null) return null;
  const recibido = codificar(url.searchParams.get('hub.verify_token') ?? '');
  const esperado = codificar(token);
  // timingSafeEqual exige el mismo largo: solo se filtra la longitud, nunca el contenido.
  return recibido.byteLength === esperado.byteLength && crypto.subtle.timingSafeEqual(recibido, esperado) ? reto : null;
}

/** `X-Hub-Signature-256: sha256=<64 hex>` = HMAC-SHA-256 del cuerpo crudo con el secreto de la app. Lanza 401 si no vale. */
export async function verificarFirma(crudo: ArrayBuffer, cabeceras: Headers, secreto: string | undefined): Promise<void> {
  // Nunca se acepta sin firma comprobable. Mismo motivo que una firma mala: no se revela si hay secreto configurado.
  if (!secreto) throw new ErrorWebhook(401, 'firma_invalida');
  const hex = /^sha256=([0-9a-f]{64})$/.exec(cabeceras.get('X-Hub-Signature-256') ?? '')?.[1];
  if (!hex) throw new ErrorWebhook(401, 'firma_mal_formada');
  const firma = new Uint8Array(hex.match(/../g)!.map((par) => parseInt(par, 16)));
  const clave = await crypto.subtle.importKey('raw', codificar(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  // subtle.verify compara en tiempo constante.
  if (!(await crypto.subtle.verify('HMAC', clave, firma, crudo))) throw new ErrorWebhook(401, 'firma_invalida');
}

const segundos = z.string().regex(/^\d{1,12}$/); // Meta manda el epoch en segundos y como texto
const telefono = z.string().regex(/^\d{8,15}$/); // sin «+»

const mensajeBase = z.object({ id: z.string().min(1), from: telefono, timestamp: segundos, context: z.object({ id: z.string().optional() }).optional() });
const SOPORTADOS = ['text', 'interactive', 'button', 'image'];
const mensaje = z.union([
  mensajeBase.extend({ type: z.literal('text'), text: z.object({ body: z.string() }) }),
  mensajeBase.extend({ type: z.literal('interactive'), interactive: z.object({ type: z.literal('button_reply'), button_reply: z.object({ id: z.string(), title: z.string() }) }) }),
  mensajeBase.extend({ type: z.literal('button'), button: z.object({ payload: z.string(), text: z.string() }) }),
  mensajeBase.extend({ type: z.literal('image'), image: z.object({ id: z.string().min(1), mime_type: z.string(), sha256: z.string().optional(), caption: z.string().optional() }) }),
  // Audio, ubicación, reacciones…: se aceptan y se ignoran, para que Meta no los reentregue durante días.
  mensajeBase.extend({ type: z.string().refine((t) => !SOPORTADOS.includes(t)) }),
]);
const estado = z.object({
  id: z.string().min(1),
  status: z.string(), // sent, delivered, read, failed; otros (p. ej. deleted) se ignoran
  timestamp: segundos,
  biz_opaque_callback_data: z.string().optional(),
  errors: z.array(z.object({ code: z.number().int() })).optional(),
});
const valor = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({ phone_number_id: z.string().min(1) }),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
  // Cada mensaje y estado se valida por separado al normalizar: uno con forma inesperada se descarta sin tumbar el lote,
  // que Meta reentregaría durante días.
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});
const cuerpoMeta = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.union([
      z.object({ field: z.literal('messages'), value: valor }),
      z.object({ field: z.string().refine((f) => f !== 'messages'), value: z.unknown() }), // otros campos: se ignoran
    ])),
  })),
});

const ESTADOS = ['sent', 'delivered', 'read', 'failed'] as const;
const esEstado = (s: string): s is (typeof ESTADOS)[number] => (ESTADOS as readonly string[]).includes(s);

/** Bytes ya firmados → eventos. UTF-8 estricto, JSON y forma de Meta; si algo falla, 400. */
export function normalizar(crudo: ArrayBuffer): SarinEvent[] {
  let datos: unknown;
  try {
    datos = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(crudo));
  } catch {
    throw new ErrorWebhook(400, 'json_invalido');
  }
  const cuerpo = cuerpoMeta.safeParse(datos);
  if (!cuerpo.success) throw new ErrorWebhook(400, 'forma_invalida');

  // Solo los cambios de `messages`; zod ya validó su `value` (el tipo no se estrecha solo por la unión).
  const valores = cuerpo.data.entry.flatMap((e) => e.changes).filter((c) => c.field === 'messages').map((c) => c.value as z.infer<typeof valor>);
  // Se cuenta todo lo que llega, también lo que se ignora: un lote enorme se rechaza antes de tocar la base.
  if (valores.reduce((n, v) => n + (v.messages?.length ?? 0) + (v.statuses?.length ?? 0), 0) > MAX_EVENTOS) {
    throw new ErrorWebhook(400, 'lote_muy_grande');
  }

  const eventos: SarinEvent[] = [];
  for (const v of valores) {
    const phoneNumberId = v.metadata.phone_number_id;
    const nombres = new Map(v.contacts?.map((c) => [c.wa_id, c.profile?.name]));
    for (const crudoMensaje of v.messages ?? []) {
      const leido = mensaje.safeParse(crudoMensaje);
      if (!leido.success) continue;
      const m = leido.data;
      const base = {
        waMessageId: m.id, occurredAt: Number(m.timestamp) * 1000, phoneNumberId, from: `+${m.from}`,
        ...(nombres.get(m.from) ? { profileName: nombres.get(m.from) } : {}),
        ...(m.context?.id ? { replyToWaMessageId: m.context.id } : {}),
      };
      if ('text' in m) eventos.push({ ...base, kind: 'text', text: m.text.body });
      else if ('interactive' in m) eventos.push({ ...base, kind: 'button', buttonId: m.interactive.button_reply.id, title: m.interactive.button_reply.title });
      else if ('button' in m) eventos.push({ ...base, kind: 'button', buttonId: m.button.payload, title: m.button.text });
      else if ('image' in m) {
        const { id, mime_type, sha256, caption } = m.image;
        eventos.push({ ...base, kind: 'image', mediaId: id, mimeType: mime_type, ...(sha256 ? { sha256 } : {}), ...(caption ? { caption } : {}) });
      }
    }
    for (const crudoEstado of v.statuses ?? []) {
      const leido = estado.safeParse(crudoEstado);
      if (!leido.success) continue;
      const s = leido.data;
      const status = s.status;
      if (!esEstado(status)) continue;
      const errorCode = s.errors?.[0]?.code;
      eventos.push({
        kind: 'status', waMessageId: s.id, occurredAt: Number(s.timestamp) * 1000, phoneNumberId, status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...(s.biz_opaque_callback_data ? { callbackData: s.biz_opaque_callback_data } : {}),
      });
    }
  }
  return eventos;
}
