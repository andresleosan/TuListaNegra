// `MetaCloudGateway` (contrato-sarin.md, variante A, decidida por el dueño): número propio contra la WhatsApp Cloud API.
// Solo se usa con WHATSAPP_SEND_READY = "1". Misma semántica que el simulador (catálogo local, ventana de 24 h,
// idempotencia por requestId, bandeja en `whatsapp_messages`); la diferencia es que, al final, sí llama a Meta.
// Nunca se registran tokens, cuerpos ni teléfonos: como mucho el estado HTTP y el código numérico de error de Meta.
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { bd } from '../db';
import { whatsapp_messages as wa } from '../db/schema';
import { nuevoId } from '../../shared/ids';
import catalogo from './plantillas.json';
import { normalizar, verificarFirma, verificarReto } from './meta';
import { PREFIJO_DEV, VENTANA_MS } from './simulado';
import { ErrorWebhook, type CodigoRechazo, type SarinEvent, type SarinGateway, type SendBase, type SendReplyInput, type SendResult, type SendTemplateInput } from './tipos';

/** Supuesto e.5 del contrato: la referencia fija `v25.0`; no se comprobó contra Meta que siga vigente. */
export const GRAPH_VERSION = 'v25.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const ENVIO_TIMEOUT_MS = 10_000;
const MEDIO_TIMEOUT_MS = 15_000;
/** WhatsApp no deja mandar imágenes de más de 5 MB; lo que pase de ahí no se descarga. procesar.ts aplica su propio tope. */
export const MAX_MEDIO_BYTES = 5 * 1024 * 1024;
/** Supuesto: Meta sirve los medios desde sus dominios. Con otro host no se envía el token (podría filtrarse). */
const HOSTS_MEDIOS = ['.fbsbx.com', '.facebook.com', '.whatsapp.net', '.fbcdn.net'];

const E164 = /^\+\d{8,15}$/;
const PLANTILLAS = new Map(catalogo.plantillas.map((p) => [p.nombre, p]));

/** Variables de Cloudflare que exige la variante A. Todas secretas salvo el número, que tampoco va en el repositorio. */
export const VARIABLES_META = ['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'] as const;
type Configuracion = Record<(typeof VARIABLES_META)[number], string>;

/**
 * Interruptor encendido sin configuración real: falla cerrado. Es un `ErrorWebhook` 401 para que el webhook no acepte
 * nada; quien envía lo recibe al pedir el gateway, antes de reservar o gastar nada. `problemas` nombra las variables,
 * nunca sus valores, y no sale en la respuesta HTTP.
 */
export class WhatsappSinConfigurar extends ErrorWebhook {
  constructor(readonly problemas: string[]) {
    super(401, 'whatsapp_sin_configurar');
    this.name = 'WhatsappSinConfigurar';
  }
}

export function configuracionMeta(env: Env): Configuracion {
  const problemas: string[] = [];
  // Recortados: un salto de línea al final de un secreto pegado rompería la cabecera Authorization.
  const valores = Object.fromEntries(VARIABLES_META.map((n) => [n, env[n]?.trim() ?? ''])) as Record<(typeof VARIABLES_META)[number], string>;
  for (const nombre of VARIABLES_META) {
    const valor = valores[nombre];
    if (!valor) problemas.push(`falta ${nombre}`);
    // MEJORAS.md (revisión de WAP-01): el gateway real rechaza los secretos de desarrollo.
    else if (valor.startsWith(PREFIJO_DEV)) problemas.push(`${nombre} es de desarrollo (${PREFIJO_DEV}…)`);
  }
  if (valores.WHATSAPP_PHONE_NUMBER_ID && !/^\d{1,32}$/.test(valores.WHATSAPP_PHONE_NUMBER_ID)) problemas.push('WHATSAPP_PHONE_NUMBER_ID debe ser solo dígitos');
  if (problemas.length) {
    console.error('whatsapp_sin_configurar', problemas.join('; ')); // solo nombres de variables
    throw new WhatsappSinConfigurar(problemas);
  }
  return valores as Configuracion;
}

const contenidoRespuesta = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal('buttons'), text: z.string().min(1).max(4096),
    buttons: z.array(z.object({ id: z.string().min(1), title: z.string().min(1).max(20) })).min(1).max(3),
  }),
  z.object({ kind: z.literal('image'), r2Key: z.string().min(1), caption: z.string().optional() }),
]);

const respuestaEnvio = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).min(1).optional(),
  error: z.object({ code: z.number().int() }).optional(),
});
const infoMedio = z.object({ url: z.string().url(), mime_type: z.string().min(1), file_size: z.coerce.number().int().nonnegative().optional() }); // supuesto e.3: Meta puede mandarlo como texto

// Supuesto e.4: códigos de error de Meta según su documentación pública, sin respaldo en código de las referencias.
const VENTANA_CERRADA = new Set([131047]); // re-engagement: pasaron más de 24 h
const PLANTILLA_INVALIDA = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);
const LIMITE = new Set([4, 80007, 130429, 131048, 131056]); // límites de la app, de la cuenta, de envío y por par de números

/** 4xx de Meta → rechazo. Un 4xx quiere decir que no salió; solo el límite de envío vale la pena reintentar más tarde. */
function rechazoDe(http: number, codigo: number | undefined): Extract<SendResult, { status: 'rejected' }> {
  if (http === 429 || (codigo !== undefined && LIMITE.has(codigo))) return { status: 'rejected', code: 'RATE_LIMITED', retryable: true };
  if (codigo !== undefined && VENTANA_CERRADA.has(codigo)) return { status: 'rejected', code: 'WINDOW_CLOSED', retryable: false };
  if (codigo !== undefined && PLANTILLA_INVALIDA.has(codigo)) return { status: 'rejected', code: 'INVALID_TEMPLATE', retryable: false };
  return { status: 'rejected', code: 'OTHER', retryable: false };
}

type FilaEnvio = Pick<typeof wa.$inferSelect, 'status' | 'wa_message_id' | 'error_code'>;
const resultadoDe = (f: FilaEnvio): SendResult =>
  f.status === 'rejected' ? { status: 'rejected', code: f.error_code as CodigoRechazo, retryable: f.error_code === 'RATE_LIMITED' }
    : f.status === 'unknown' || !f.wa_message_id ? { status: 'unknown' }
    : { status: 'accepted', waMessageId: f.wa_message_id };

type Envio = Pick<typeof wa.$inferInsert, 'kind' | 'template' | 'content_json' | 'buttons_json' | 'reply_to_wa_message_id'>;

/** Lee el cuerpo y corta en cuanto pasa del tope, aunque `Content-Length` mienta o no venga. */
async function leerConTope(respuesta: Response, tope: number): Promise<ArrayBuffer> {
  if (Number(respuesta.headers.get('Content-Length') ?? 0) > tope) throw new Error('medio_muy_grande');
  if (!respuesta.body) return new ArrayBuffer(0);
  const lector = respuesta.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > tope) {
      await lector.cancel();
      throw new Error('medio_muy_grande');
    }
    partes.push(value);
  }
  const todo = new Uint8Array(total);
  let i = 0;
  for (const parte of partes) {
    todo.set(parte, i);
    i += parte.byteLength;
  }
  return todo.buffer;
}

export class MetaCloudGateway implements SarinGateway {
  private readonly config: Configuracion;

  /** Lanza `WhatsappSinConfigurar` si falta algo o hay un secreto de desarrollo. `ahora` y `negocio`, como el simulador. */
  constructor(private readonly env: Env, private readonly ahora: () => number = Date.now, private readonly negocio: string | null = null) {
    this.config = configuracionMeta(env);
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const p = PLANTILLAS.get(input.template);
    const valida = p && p.idioma === input.language && input.variables.length === p.variables && input.variables.every((v) => v.trim());
    const rechazo: CodigoRechazo | null = !valida ? 'INVALID_TEMPLATE' : (input.buttonPayloads?.length ?? 0) > 3 ? 'OTHER' : null;
    const texto = p ? p.texto.replace(/\{\{(\d+)\}\}/g, (_, n: string) => input.variables[Number(n) - 1] ?? '') : null;
    // Supuesto e.1: forma de la plantilla según la documentación de Meta (cuerpo con parámetros de texto y respuestas rápidas).
    const mensaje = {
      type: 'template',
      template: {
        name: input.template,
        language: { code: input.language },
        components: [
          { type: 'body', parameters: input.variables.map((text) => ({ type: 'text', text })) },
          ...(input.buttonPayloads ?? []).map((payload, i) => ({
            type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }],
          })),
        ],
      },
    };
    return this.enviar(input, rechazo, {
      kind: 'template', template: input.template,
      content_json: JSON.stringify({ language: input.language, variables: input.variables, texto: valida ? texto : null }),
      buttons_json: input.buttonPayloads ? JSON.stringify(input.buttonPayloads) : null,
    }, mensaje);
  }

  async sendReply(input: SendReplyInput): Promise<SendResult> {
    const contenido = contenidoRespuesta.safeParse(input.content);
    // La tirilla en imagen exige subir antes el archivo a Meta (no hay URL pública del R2, ni debe haberla): no está
    // hecho. Se rechaza sin llamar a Meta; hoy nadie la envía (la tirilla sale como texto).
    let rechazo: CodigoRechazo | null = contenido.success && input.content.kind !== 'image' ? null : 'OTHER';
    if (!rechazo) {
      const ultimo = await bd(this.env).select({ occurred_at: wa.occurred_at }).from(wa)
        .where(and(eq(wa.phone, input.to), eq(wa.direction, 'ENTRANTE'))).orderBy(desc(wa.occurred_at)).limit(1).get();
      if (!ultimo || this.ahora() - ultimo.occurred_at >= VENTANA_MS) rechazo = 'WINDOW_CLOSED';
    }
    const c = input.content;
    const mensaje = c.kind === 'text' ? { type: 'text', text: { preview_url: false, body: c.text } }
      : c.kind === 'buttons' ? {
        type: 'interactive',
        interactive: { type: 'button', body: { text: c.text }, action: { buttons: c.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } },
      }
      : {};
    return this.enviar(input, rechazo, {
      kind: c.kind,
      content_json: JSON.stringify(c.kind === 'buttons' ? { text: c.text } : { ...c, kind: undefined }),
      buttons_json: c.kind === 'buttons' ? JSON.stringify(c.buttons) : null,
      reply_to_wa_message_id: input.replyTo ?? null,
    }, { ...mensaje, ...(input.replyTo ? { context: { message_id: input.replyTo } } : {}) });
  }

  async parseWebhook(rawBody: ArrayBuffer, headers: Headers): Promise<SarinEvent[]> {
    await verificarFirma(rawBody, headers, this.config.WHATSAPP_APP_SECRET);
    // La app de Meta recibe los webhooks de todos los números suscritos (p. ej. el número de prueba del alta): solo los
    // eventos de NUESTRO número entran; los demás se descartan y el webhook responde 200 igual.
    return normalizar(rawBody).filter((e) => e.phoneNumberId === this.config.WHATSAPP_PHONE_NUMBER_ID);
  }

  verifyChallenge(url: URL): string | null {
    return verificarReto(url, this.config.WHATSAPP_VERIFY_TOKEN);
  }

  /** Supuesto e.3: dos pasos (id → URL temporal → bytes), los dos con el token. Lanza si algo no cuadra. */
  async fetchMedia(mediaId: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(mediaId)) throw new Error('medio_invalido');
    const autorizacion = { Authorization: `Bearer ${this.config.WHATSAPP_ACCESS_TOKEN}` };
    const pedirInfo = await fetch(`${GRAPH}/${mediaId}?phone_number_id=${this.config.WHATSAPP_PHONE_NUMBER_ID}`, {
      headers: autorizacion, signal: AbortSignal.timeout(MEDIO_TIMEOUT_MS),
    });
    if (!pedirInfo.ok) throw new Error('medio_no_disponible');
    const info = infoMedio.safeParse(await pedirInfo.json().catch(() => null));
    if (!info.success) throw new Error('medio_respuesta_invalida');
    if ((info.data.file_size ?? 0) > MAX_MEDIO_BYTES) throw new Error('medio_muy_grande');
    const url = new URL(info.data.url);
    if (url.protocol !== 'https:' || !HOSTS_MEDIOS.some((h) => url.hostname.endsWith(h))) throw new Error('medio_url_no_confiable');
    const descarga = await fetch(url, { headers: autorizacion, signal: AbortSignal.timeout(MEDIO_TIMEOUT_MS) });
    if (!descarga.ok) throw new Error('medio_no_disponible');
    return { bytes: await leerConTope(descarga, MAX_MEDIO_BYTES), mimeType: info.data.mime_type };
  }

  /**
   * Reserva la fila ANTES de llamar a Meta, con `status = 'unknown'`: dos llamadas a la vez con el mismo `requestId`
   * chocan en el índice único y solo una sale a la red; si el Worker muere a mitad, la fila dice lo que pasó (ambiguo).
   * Un `requestId` ya usado devuelve lo de la primera vez sin llamar a Meta. Nada se reintenta solo.
   */
  private async enviar(input: SendBase, rechazo: CodigoRechazo | null, envio: Envio, mensaje: object): Promise<SendResult> {
    const db = bd(this.env);
    const ahora = this.ahora();
    if (!rechazo && !E164.test(input.to)) rechazo = 'OTHER';
    const [nueva] = await db.insert(wa).values({
      ...envio, id: nuevoId('wam', ahora), direction: 'SALIENTE', request_id: input.requestId, phone: input.to,
      phone_number_id: this.config.WHATSAPP_PHONE_NUMBER_ID, business_id: this.negocio, wa_message_id: null,
      status: rechazo ? 'rejected' : 'unknown', error_code: rechazo, callback_data: input.callbackData ?? null, occurred_at: ahora, created_at: ahora,
    }).onConflictDoNothing({ target: wa.request_id }).returning();
    if (!nueva) return resultadoDe((await db.select().from(wa).where(eq(wa.request_id, input.requestId)).get())!);
    if (rechazo) return resultadoDe(nueva);

    const resultado = await this.llamarMeta({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: input.to.slice(1), // Meta usa el número sin «+»
      // Vuelve en los estados del webhook (supuesto e.1). Conciliar un `unknown` con esto sigue pendiente (MEJORAS.md).
      ...(input.callbackData ? { biz_opaque_callback_data: input.callbackData } : {}),
      ...mensaje,
    });
    if (resultado.status === 'accepted') {
      await db.update(wa).set({ status: 'accepted', wa_message_id: resultado.waMessageId }).where(eq(wa.id, nueva.id));
    } else if (resultado.status === 'rejected') {
      await db.update(wa).set({ status: 'rejected', error_code: resultado.code }).where(eq(wa.id, nueva.id));
    }
    return resultado;
  }

  /** 2xx con `messages[0].id` → accepted; 4xx → rejected; timeout, red, 5xx o respuesta rara → unknown (pudo salir). */
  private async llamarMeta(cuerpo: object): Promise<SendResult> {
    let respuesta: Response;
    try {
      respuesta = await fetch(`${GRAPH}/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(ENVIO_TIMEOUT_MS),
      });
    } catch (e) {
      console.warn('whatsapp_envio_ambiguo', e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'red');
      return { status: 'unknown' };
    }
    const datos = respuestaEnvio.safeParse(await respuesta.json().catch(() => null));
    const leido = datos.success ? datos.data : {};
    if (respuesta.ok) {
      const id = leido.messages?.[0]?.id;
      if (id) return { status: 'accepted', waMessageId: id };
      console.warn('whatsapp_envio_ambiguo', `http_${respuesta.status}_sin_id`);
      return { status: 'unknown' };
    }
    if (respuesta.status >= 500 || respuesta.status === 408) {
      console.warn('whatsapp_envio_ambiguo', `http_${respuesta.status}`);
      return { status: 'unknown' };
    }
    const rechazo = rechazoDe(respuesta.status, leido.error?.code);
    console.warn('whatsapp_envio_rechazado', respuesta.status, leido.error?.code ?? null, rechazo.code);
    return rechazo;
  }
}
